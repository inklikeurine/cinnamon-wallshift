// CarouselManager.js — Per-monitor wallpaper carousel overlay.
//
// Each open carousel is two chrome actors (Main.layoutManager.addChrome):
//
//   _strip — the thumbnail strip along one edge of the monitor's usable area
//   _tab   — the controls (collapse, favorite, trash, close) in a tab grown out
//            of the strip's inner side, centred, facing into the desktop
//
//   edge bottom:        ╭[⌄ ★ 🗑 ✕]╮
//              ═══════════ strip ═══════════
//
// They are separate actors because a chrome actor's whole box joins the stage
// input region: one actor spanning the tab row would swallow clicks beside the tab.
// Where they go (edge, panels, auto-hide panels, portrait) is CarouselLayout.js.
//
// Collapsing fades the strip out and moves the tab onto the screen edge; only the
// tab (expand, close) stays. Opening and closing fade (ANIM_TIME). Both actors are
// added with visibleInFullscreen: false, so Cinnamon hides them while a
// fullscreen window covers the monitor.
//
// Colours come from the Cinnamon theme (ThemeColors.js) and are re-read when the
// theme changes; stylesheet.css holds sizes and spacing only.

const St       = imports.gi.St;
const Clutter  = imports.gi.Clutter;
const GLib     = imports.gi.GLib;
const Pango    = imports.gi.Pango;
const Tweener  = imports.ui.tweener;
const Main     = imports.ui.main;
const Tooltips = imports.ui.tooltips;

const Utils       = require('./modules/Utils');   // relative to the applet dir, as in applet.js
const ThemeColors = require('./modules/ThemeColors');
const Layout      = require('./modules/CarouselLayout');
const _ = Utils._;

const THUMB_SPACING = 5;
const THUMB_BORDER  = 3;     // always drawn (transparent unless current/hovered), so sizes never shift
const LOAD_BUFFER   = 8;     // extra items loaded beyond the visible viewport
const ANIM_TIME     = 0.18;  // fade / collapse duration, seconds
const NAME_HEIGHT   = 20;    // file-name band at the bottom of a thumbnail
const BADGE_SIZE    = 20;

var DEFAULT_OPTIONS = { edge: 'bottom', thumbSize: 'medium', fileNames: 'hover', closeOnPick: false };

// ── CarouselManager ────────────────────────────────────────────────────────────

var CarouselManager = class CarouselManager {

    constructor(stateManager, thumbnailCache, applet) {
        this._stateManager = stateManager;
        this._thumbCache   = thumbnailCache;
        this._applet       = applet;
        this._carousels    = new Map();   // monitorName → Carousel
        this._closing      = new Set();   // carousels fading out
        this._imagePools   = new Map();
        this._syncPool     = null;
        this._options      = Object.assign({}, DEFAULT_OPTIONS);
        this._colors       = null;
        this._themeSigId   = 0;
        this._themeIdleId  = 0;
        try {
            this._themeContext = St.ThemeContext.get_for_stage(global.stage);
            this._themeSigId = this._themeContext.connect('changed', () => this._onThemeChanged());
        } catch(e) {
            this._themeContext = null;
        }
    }

    // opts: any of { edge, thumbSize, fileNames, closeOnPick }. Open carousels are
    // rebuilt so a new edge or size takes effect at once.
    setOptions(opts) {
        let changed = false;
        for (let k of Object.keys(DEFAULT_OPTIONS)) {
            if (opts[k] !== undefined && opts[k] !== this._options[k]) {
                this._options[k] = opts[k];
                changed = true;
            }
        }
        if (changed) this._rebuildOpen();
    }

    updatePools(imagePools, syncPool) {
        this._imagePools = imagePools;
        this._syncPool   = syncPool;
        for (let [name, carousel] of this._carousels)
            carousel.refreshImages(this._getImagesFor(name));
    }

    onWallpaperChanged(monitorName, imagePath) {
        let c = this._carousels.get(monitorName);
        if (c) c.setCurrentImage(imagePath);
    }

    // The favorites folder changed for the image on `monitorName` (or on all).
    refreshFavorite(monitorName) {
        for (let [name, c] of this._carousels)
            if (!monitorName || name === monitorName) c.updateFavorite();
    }

    openCarousel(monitor) {
        let existing = this._carousels.get(monitor.name);
        if (existing) { existing.expand(); return; }
        let c = new Carousel(monitor, this._getImagesFor(monitor.name),
            this._getCurrentImage(monitor.name), this._context(monitor.name));
        this._carousels.set(monitor.name, c);
        this._notifyApplet();
    }

    closeCarousel(monitorName, animate = true) {
        let c = this._carousels.get(monitorName);
        if (!c) return;
        this._carousels.delete(monitorName);
        if (animate) {
            this._closing.add(c);
            c.fadeOutAndDestroy(() => this._closing.delete(c));
        } else {
            c.destroy();
        }
        this._notifyApplet();
    }

    isOpen(monitorName) { return this._carousels.has(monitorName); }

    // Monitors were plugged, unplugged or moved: put every open carousel back in
    // the right place, and drop the ones whose monitor is gone.
    reopenAll(monitors) {
        let open = [...this._carousels.keys()];
        for (let name of open) this.closeCarousel(name, false);
        for (let name of open) {
            let mon = monitors.find(m => m.name === name);
            if (mon) this.openCarousel(mon);
        }
    }

    destroy() {
        if (this._themeIdleId) {
            GLib.source_remove(this._themeIdleId);
            this._themeIdleId = 0;
        }
        if (this._themeSigId && this._themeContext) {
            this._themeContext.disconnect(this._themeSigId);
            this._themeSigId = 0;
        }
        for (let c of this._closing) c.destroy();
        this._closing.clear();
        for (let c of this._carousels.values()) c.destroy();
        this._carousels.clear();
        this._applet = null;
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    _context(monitorName) {
        let applet = this._applet;
        return {
            thumbCache:  this._thumbCache,
            colors:      this._getColors(),
            options:     Object.assign({}, this._options),
            folder:      applet ? applet._folderFor(monitorName) : '',
            isFavorite:  path => !!applet && applet._isFavorite(path),
            onPick:      path => {
                if (!applet) return;
                applet._applyImageToMonitor(monitorName, path);
                if (this._options.closeOnPick) this.closeCarousel(monitorName);
            },
            onFavorite:  () => applet && applet._toggleFavorite(monitorName),
            onTrash:     () => applet && applet._trashMonitorImage(monitorName),
            onClose:     () => this.closeCarousel(monitorName),
        };
    }

    _notifyApplet() {
        if (this._applet && this._applet.menu) this._applet._updateMenuState();
    }

    _getColors() {
        if (!this._colors)
            this._colors = ThemeColors.read(this._applet ? this._applet.menu : null);
        return this._colors;
    }

    // The new stylesheet is applied after 'changed' returns; read it once it has.
    _onThemeChanged() {
        if (this._themeIdleId) return;
        this._themeIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._themeIdleId = 0;
            this._colors = null;
            let colors = this._getColors();
            for (let c of this._carousels.values()) c.applyColors(colors);
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuildOpen() {
        let open = [...this._carousels.values()].map(c => c.monitor);
        for (let mon of open) this.closeCarousel(mon.name, false);
        for (let mon of open) this.openCarousel(mon);
    }

    _getImagesFor(monitorName) {
        let pool = this._syncPool || this._imagePools.get(monitorName);
        return pool ? pool.getImages().slice() : [];
    }

    _getCurrentImage(monitorName) {
        let rec = this._stateManager.getMonitorRecord(monitorName);
        return rec ? rec.currentImage : null;
    }
};

// ── Carousel ───────────────────────────────────────────────────────────────────

class Carousel {

    constructor(monitor, images, currentImage, ctx) {
        this.monitor       = monitor;
        this._images       = images;
        this._currentImage = currentImage;
        this._ctx          = ctx;
        this._colors       = ctx.colors;
        this._opts         = ctx.options;
        this._isPortrait   = monitor.width < monitor.height;
        this._edge         = Layout.edgeFor(this._opts.edge, this._isPortrait);
        this._thumb        = Layout.thumbSize(this._opts.thumbSize, this._isPortrait);
        this._thickness    = Layout.stripThickness(this._thumb, this._isPortrait);
        this._thumbStep    = (this._isPortrait ? this._thumb.h : this._thumb.w) + THUMB_SPACING;
        this._items        = [];
        this._collapsed    = false;
        this._destroyed    = false;
        this._scrollSigId  = 0;
        this._idleIds      = new Set();
        this._chrome       = [];
        this._build();
    }

    // ── Public ─────────────────────────────────────────────────────────────────

    setCurrentImage(imagePath) {
        let oldIdx = this._images.indexOf(this._currentImage);
        if (oldIdx >= 0 && this._items[oldIdx]) this._items[oldIdx].setCurrent(false);
        this._currentImage = imagePath;
        this._updateActionButtons();
        let newIdx = this._images.indexOf(imagePath);
        if (newIdx >= 0 && this._items[newIdx]) {
            this._items[newIdx].setCurrent(true);
            this._scrollToIndex(newIdx);
        }
    }

    refreshImages(images) {
        this._images = images.slice();
        this._rebuildStrip();
        this._scrollToCurrentImage();
    }

    updateFavorite() {
        if (!this._favBtn) return;
        let fav = !!this._currentImage && this._ctx.isFavorite(this._currentImage);
        this._favIcon.icon_name = fav ? 'starred-symbolic' : 'non-starred-symbolic';
        this._favIcon.set_style('color: ' + (fav ? this._colors.accent : this._colors.fg) + ';');
        this._favTip.set_text(fav ? _('Remove from Favorites') : _('Add to Favorites'));
    }

    applyColors(colors) {
        this._colors = colors;
        this._strip.set_style('background-color: ' + colors.surface + ';');
        if (this._emptyLabel) this._emptyLabel.set_style('color: ' + colors.fg + ';');
        this._tab.set_style(Layout.tabFrameStyle(this._join, colors));
        for (let b of this._buttons) b.restyle();
        for (let item of this._items) item.applyColors(colors);
        this.updateFavorite();
    }

    expand() {
        if (!this._collapsed || this._destroyed) return;
        this._collapsed = false;
        this._strip.show();
        Tweener.removeTweens(this._strip);
        Tweener.addTween(this._strip, { opacity: 255, time: ANIM_TIME, transition: 'easeOutQuad' });
        this._moveTab(this._geom.tabOpen);
        this._setCollapsedControls(false);
        this._loadVisibleThumbnails();
    }

    collapse() {
        if (this._collapsed || this._destroyed) return;
        this._collapsed = true;
        Tweener.removeTweens(this._strip);
        Tweener.addTween(this._strip, {
            opacity: 0, time: ANIM_TIME, transition: 'easeInQuad',
            onComplete: () => { if (!this._destroyed && this._collapsed) this._strip.hide(); }
        });
        this._moveTab(this._geom.tabCollapsed);
        this._setCollapsedControls(true);
    }

    fadeOutAndDestroy(onDone) {
        if (this._destroyed) { if (onDone) onDone(); return; }
        for (let { actor } of this._chrome) {
            actor.reactive = false;
            Tweener.removeTweens(actor);
            Tweener.addTween(actor, { opacity: 0, time: ANIM_TIME, transition: 'easeInQuad' });
        }
        this._later(Math.round(ANIM_TIME * 1000) + 20, () => {
            this.destroy();
            if (onDone) onDone();
        });
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        for (let id of this._idleIds) GLib.source_remove(id);
        this._idleIds.clear();
        if (this._scrollSigId) {
            try { this._adjustment().disconnect(this._scrollSigId); } catch(e) {}
            this._scrollSigId = 0;
        }
        for (let item of this._items) item.alive = false;
        this._items = [];
        for (let { actor } of this._chrome) {
            Tweener.removeTweens(actor);
            try { Main.layoutManager.removeChrome(actor); } catch(e) {}
            actor.destroy();
        }
        this._chrome = [];
    }

    // ── Build ──────────────────────────────────────────────────────────────────

    _build() {
        // Strip: a container holding the scroll view (or the empty-folder message).
        this._strip = new St.Widget({ style_class: 'wallshift-carousel-strip', reactive: true,
                                      clip_to_allocation: true, opacity: 0 });
        this._scrollView = new St.ScrollView({ style_class: 'wallshift-carousel-scroll', reactive: true });
        this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.NEVER);
        this._box = new St.BoxLayout({ vertical: this._isPortrait, reactive: true,
                                       style: 'spacing: ' + THUMB_SPACING + 'px; padding: ' + Layout.STRIP_PAD + 'px;' });
        this._scrollView.add_actor(this._box);
        this._box.connect('scroll-event', (_a, e) => this._onScrollWheel(e));
        this._strip.add_child(this._scrollView);

        // Tab: the four controls, laid out along the strip's direction.
        this._tab = new St.BoxLayout({ style_class: 'wallshift-carousel-tab', vertical: this._isPortrait,
                                       reactive: true, opacity: 0 });
        this._tab.connect('scroll-event', (_a, e) => this._onScrollWheel(e));
        this._buttons = [];
        this._collapseBtn = this._mkButton(Layout.chevron(this._edge, false), _('Hide thumbnails'),
            () => this._collapsed ? this.expand() : this.collapse());
        this._favBtn   = this._mkButton('non-starred-symbolic', _('Add to Favorites'), () => {
            if (!this._currentImage) return;
            this._ctx.onFavorite();
            this.updateFavorite();
        });
        this._favIcon  = this._favBtn.icon;
        this._favTip   = this._favBtn.tooltip;
        this._trashBtn = this._mkButton('user-trash-symbolic', _('Move to Trash'),
            () => { if (this._currentImage) this._trashCurrent(); });
        this._closeBtn = this._mkButton('window-close-symbolic', _('Close carousel'), () => this._ctx.onClose());
        for (let b of this._buttons) this._tab.add_child(b.actor);

        this._place({ w: 4 * 34 + 20, h: 36 });   // estimate; corrected once the tab is styled
        this.applyColors(this._colors);
        this._rebuildStrip();

        this._addChrome(this._strip);
        this._addChrome(this._tab);
        for (let { actor } of this._chrome)
            Tweener.addTween(actor, { opacity: 255, time: ANIM_TIME, transition: 'easeOutQuad' });

        this._later(null, () => {
            try {
                let [, natW] = this._tab.get_preferred_width(-1);
                let [, natH] = this._tab.get_preferred_height(natW);
                this._place({ w: natW, h: natH });
            } catch(e) {}
            this._connectScrollSignal();
            this._scrollToCurrentImage();
            this._loadVisibleThumbnails();
        });
    }

    _place(tabSize) {
        let area = this._usableArea();
        this._geom = Layout.layout(area, this._edge, this._thickness, tabSize);
        this._join = this._geom.join;
        let s = this._geom.strip;
        this._strip.set_position(s.x, s.y);
        this._strip.set_size(s.w, s.h);
        this._scrollView.set_size(s.w, s.h);
        let t = this._collapsed ? this._geom.tabCollapsed : this._geom.tabOpen;
        this._tab.set_position(t.x, t.y);
        if (this._colors) this._tab.set_style(Layout.tabFrameStyle(this._join, this._colors));
    }

    _moveTab(pos) {
        Tweener.removeTweens(this._tab);
        Tweener.addTween(this._tab, { x: pos.x, y: pos.y, time: ANIM_TIME, transition: 'easeOutQuad' });
    }

    _setCollapsedControls(collapsed) {
        this._collapseBtn.icon.icon_name = Layout.chevron(this._edge, collapsed);
        this._collapseBtn.tooltip.set_text(collapsed ? _('Show thumbnails') : _('Hide thumbnails'));
        this._favBtn.actor.visible   = !collapsed;
        this._trashBtn.actor.visible = !collapsed;
        // The tab got smaller: re-centre it on the edge.
        this._later(null, () => {
            try {
                let [, natW] = this._tab.get_preferred_width(-1);
                let [, natH] = this._tab.get_preferred_height(natW);
                let area = this._usableArea();
                this._geom = Layout.layout(area, this._edge, this._thickness, { w: natW, h: natH });
                this._moveTab(this._collapsed ? this._geom.tabCollapsed : this._geom.tabOpen);
            } catch(e) {}
        });
    }

    // One control in the tab: icon button, hover highlight in theme colours, tooltip.
    _mkButton(iconName, tip, onClick) {
        let icon = new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: 16 });
        let actor = new St.Button({ style_class: 'wallshift-carousel-tab-button', child: icon,
                                    reactive: true, track_hover: true, can_focus: true });
        actor.accessible_name = tip;
        let tooltip = new Tooltips.Tooltip(actor, tip);
        let b = {
            actor, icon, tooltip,
            restyle: () => {
                let bg = actor.hover ? this._colors.hoverBg : 'transparent';
                actor.set_style('background-color: ' + bg + ';');
                if (b !== this._favBtn) icon.set_style('color: ' + this._colors.fg + ';');
            }
        };
        actor.connect('notify::hover', () => b.restyle());
        actor.connect('clicked', () => { if (!this._destroyed) onClick(); });
        this._buttons.push(b);
        return b;
    }

    _addChrome(actor) {
        Main.layoutManager.addChrome(actor, { affectsStruts: false, visibleInFullscreen: false });
        this._chrome.push({ actor });
    }

    // Run fn after `ms` milliseconds (null: when idle), unless destroyed first.
    // Pending sources are removed in destroy(); a fired one forgets its id.
    _later(ms, fn) {
        let id = 0;
        let cb = () => {
            this._idleIds.delete(id);
            if (!this._destroyed) fn();
            return GLib.SOURCE_REMOVE;
        };
        id = ms === null
            ? GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, cb)
            : GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, cb);
        this._idleIds.add(id);
    }

    // Favorite / trash act on the current image; dimmed when there is none.
    _updateActionButtons() {
        let has = !!this._currentImage;
        for (let b of [this._favBtn, this._trashBtn]) {
            if (!b) continue;
            b.actor.reactive = has;
            b.actor.opacity  = has ? 255 : 90;
        }
        this.updateFavorite();
    }

    // ── Strip ──────────────────────────────────────────────────────────────────

    _rebuildStrip() {
        for (let item of this._items) item.alive = false;
        this._items = [];
        this._box.destroy_all_children();
        if (this._emptyLabel) { this._emptyLabel.destroy(); this._emptyLabel = null; }

        if (this._images.length === 0) {
            this._scrollView.hide();
            let folder = this._ctx.folder || '';
            let home = GLib.get_home_dir();
            if (folder.startsWith(home + '/')) folder = '~' + folder.slice(home.length);
            let text = folder
                ? _('No images in %s — right-click Wallshift → Configure').replace('%s', folder)
                : _('No images — right-click Wallshift → Configure');
            this._emptyLabel = new St.Label({ text, style_class: 'wallshift-carousel-empty',
                                              x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
            this._emptyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._emptyLabel.set_style('color: ' + this._colors.fg + ';');
            this._strip.add_child(this._emptyLabel);
            let s = this._geom.strip;
            this._later(null, () => {
                if (!this._emptyLabel) return;
                let [, natW] = this._emptyLabel.get_preferred_width(-1);
                let [, natH] = this._emptyLabel.get_preferred_height(-1);
                let w = Math.min(natW, s.w - 24);
                this._emptyLabel.set_size(w, natH);
                this._emptyLabel.set_position(Math.floor((s.w - w) / 2), Math.floor((s.h - natH) / 2));
            });
            this._updateActionButtons();
            return;
        }

        this._scrollView.show();
        let currentIdx = this._images.indexOf(this._currentImage);
        for (let i = 0; i < this._images.length; i++) {
            let path = this._images[i];
            let item = new ThumbnailItem(path, this._thumb, this._opts.fileNames, this._colors);
            if (i === currentIdx) item.setCurrent(true);
            item.connectClicked(() => { if (item.alive && !this._destroyed) this._ctx.onPick(path); });
            this._items.push(item);
            this._box.add_child(item.actor);
        }
        this._updateActionButtons();
    }

    // ── Scroll ─────────────────────────────────────────────────────────────────

    // Portrait strips scroll vertically, landscape strips horizontally. May throw
    // before the scroll view is allocated; callers that run early catch it.
    _adjustment() {
        return this._isPortrait
            ? this._scrollView.vscroll.adjustment
            : this._scrollView.hscroll.adjustment;
    }

    _onScrollWheel(event) {
        let dir = event.get_scroll_direction();
        let adj;
        try { adj = this._adjustment(); } catch(e) { return Clutter.EVENT_STOP; }
        let step = this._thumbStep;
        if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            adj.value = Math.min(adj.value + step, Math.max(0, adj.upper - adj.page_size));
        else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            adj.value = Math.max(adj.value - step, 0);
        return Clutter.EVENT_STOP;
    }

    _connectScrollSignal() {
        try {
            this._scrollSigId = this._adjustment().connect('notify::value',
                () => this._loadVisibleThumbnails());
        } catch(e) {
            Utils.warn('Carousel: scroll signal failed: ' + e.message);
        }
    }

    _scrollToCurrentImage() {
        let idx = this._images.indexOf(this._currentImage);
        if (idx >= 0) this._scrollToIndex(idx);
    }

    _scrollToIndex(idx) {
        this._later(null, () => {
            try {
                let adj = this._adjustment();
                let viewport   = adj.page_size || this._thickness;
                let itemCenter = idx * this._thumbStep + this._thumbStep / 2;
                adj.value = Math.max(0, Math.min(itemCenter - viewport / 2, adj.upper - viewport));
            } catch(e) {}
        });
    }

    // ── Lazy thumbnail loading ─────────────────────────────────────────────────

    _loadVisibleThumbnails() {
        if (this._destroyed || this._collapsed) return;
        try {
            let adj   = this._adjustment();
            let pos   = adj.value;
            let view  = adj.page_size || this._thickness;
            let first = Math.max(0, Math.floor(pos / this._thumbStep) - LOAD_BUFFER);
            let last  = Math.min(this._items.length - 1,
                Math.ceil((pos + view) / this._thumbStep) + LOAD_BUFFER);

            for (let i = first; i <= last; i++) {
                let item = this._items[i];
                if (!item || item.loaded || !item.alive) continue;
                item.loaded = true;
                this._ctx.thumbCache.ensureThumbnail(item.path, this._thumb.w, this._thumb.h,
                    (err, cachePath) => {
                        if (!item.alive || err) return;
                        if (!item.setTexture(cachePath)) {
                            // Cache file was corrupt — delete and retry after a short delay
                            item.loaded = false;
                            try { GLib.unlink(cachePath); } catch(e) {}
                            this._later(500, () => this._loadVisibleThumbnails());
                        }
                    });
            }
        } catch(e) { /* not yet allocated */ }
    }

    // ── Actions ────────────────────────────────────────────────────────────────

    _trashCurrent() {
        let idx = this._images.indexOf(this._currentImage);
        if (idx >= 0) {
            this._images.splice(idx, 1);
            let item = this._items.splice(idx, 1)[0];
            item.alive = false;
            item.actor.destroy();
        }
        this._ctx.onTrash();
    }

    // ── Work area ──────────────────────────────────────────────────────────────

    _findMonitorIndex() {
        let lms = Main.layoutManager.monitors;
        for (let i = 0; i < lms.length; i++) {
            let lm = lms[i];
            if (lm.x === this.monitor.x && lm.y === this.monitor.y &&
                lm.width === this.monitor.width && lm.height === this.monitor.height)
                return i;
        }
        return Main.layoutManager.primaryIndex || 0;
    }

    // The monitor's work area (fixed panels excluded) minus the room auto-hide
    // panels need to slide out; see CarouselLayout.usableArea().
    _usableArea() {
        let idx = this._findMonitorIndex();
        let wa = { x: this.monitor.x, y: this.monitor.y, width: this.monitor.width, height: this.monitor.height };
        try {
            let r = global.display.get_monitor_work_area(idx);
            if (r && r.width > 0 && r.height > 0) wa = { x: r.x, y: r.y, width: r.width, height: r.height };
        } catch(e) {}
        let panels = [];
        try {
            for (let p of Main.panelManager.getPanelsInMonitor(idx)) {
                if (!p) continue;
                let thickness = p.height ||
                    (p.panelPosition > 1 ? p.actor.get_width() : p.actor.get_height());
                panels.push({ position: p.panelPosition, hideable: p.isHideable(), thickness });
            }
        } catch(e) {}
        return Layout.usableArea(wa, panels);
    }
}

// ── ThumbnailItem ──────────────────────────────────────────────────────────────
//
// One thumbnail: a button holding the image (a placeholder icon until it loads),
// a file-name band (always, on hover or never) and, on the current image, an
// accent border and check badge.

class ThumbnailItem {

    constructor(path, thumb, fileNames, colors) {
        this.path    = path;
        this.loaded  = false;
        this.alive   = true;
        this._w      = thumb.w;
        this._h      = thumb.h;
        this._inW    = thumb.w - 2 * THUMB_BORDER;
        this._inH    = thumb.h - 2 * THUMB_BORDER;
        this._names  = fileNames;
        this._current = false;
        this._colors = colors;

        this.actor = new St.Button({ style_class: 'wallshift-carousel-thumb', reactive: true,
                                     track_hover: true, width: this._w, height: this._h });
        this.actor.accessible_name = path.split('/').pop();
        this._frame = new St.Widget({ width: this._inW, height: this._inH });
        this.actor.set_child(this._frame);

        this._placeholder = new St.Bin({ width: this._inW, height: this._inH,
            child: new St.Icon({ icon_name: 'image-loading-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 22 }) });
        this._frame.add_child(this._placeholder);

        this._name = new St.Label({ text: path.split('/').pop(), style_class: 'wallshift-carousel-name',
                                    width: this._inW, height: NAME_HEIGHT, y: this._inH - NAME_HEIGHT });
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._frame.add_child(this._name);

        this._badge = new St.Bin({ width: BADGE_SIZE, height: BADGE_SIZE, x: this._inW - BADGE_SIZE - 5, y: 5,
            child: new St.Icon({ icon_name: 'object-select-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 12 }) });
        this._frame.add_child(this._badge);

        this.actor.connect('notify::hover', () => this._restyle());
        this.applyColors(colors);
    }

    connectClicked(cb) { this.actor.connect('clicked', cb); }

    setCurrent(current) {
        this._current = current;
        this._restyle();
    }

    applyColors(colors) {
        this._colors = colors;
        this._placeholder.set_style('background-color: ' + colors.placeholder + ';');
        this._placeholder.child.set_style('color: ' + colors.fgDim + ';');
        this._name.set_style('background-color: ' + colors.surfaceSoft + '; color: ' + colors.fg + ';');
        this._badge.set_style('background-color: ' + colors.accent + '; border-radius: ' + (BADGE_SIZE / 2) + 'px;');
        this._badge.child.set_style('color: ' + colors.onAccent + ';');
        this._restyle();
    }

    _restyle() {
        let c = this._colors;
        let border = this._current ? c.accent : (this.actor.hover ? c.hoverBorder : 'transparent');
        this.actor.set_style('border: ' + THUMB_BORDER + 'px solid ' + border + ';');
        this._badge.visible = this._current;
        this._name.visible  = this._names === 'always' || (this._names === 'hover' && this.actor.hover);
    }

    // Show the cached thumbnail. Returns false if the file was unreadable.
    setTexture(cachePath) {
        try {
            const GdkPixbuf = imports.gi.GdkPixbuf;
            const Cogl      = imports.gi.Cogl;
            let pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(cachePath, this._inW, this._inH, false);
            let image  = new Clutter.Image();
            image.set_data(
                pixbuf.get_pixels(),
                pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                pixbuf.get_width(), pixbuf.get_height(),
                pixbuf.get_rowstride()
            );
            let imgActor = new Clutter.Actor({ width: this._inW, height: this._inH, reactive: false });
            imgActor.set_content(image);
            this._frame.insert_child_below(imgActor, null);
            this._placeholder.hide();
            return true;
        } catch(e) {
            Utils.warn('ThumbnailItem.setTexture: ' + cachePath + ': ' + e.message);
            return false;
        }
    }
}
