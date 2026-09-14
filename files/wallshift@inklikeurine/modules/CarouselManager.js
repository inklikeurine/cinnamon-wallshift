// CarouselManager.js — Per-monitor wallpaper carousel overlay.
//
// Layout (landscape, expanded):
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ [▼ collapse] ·····spacer····· [★ fav] [🗑 trash] [✕ close] │ ← CONTROLS_H px
//   └──────────────────────────────────────────────────────────────┘  floating bar
//          CONTROLS_GAP px gap
//   ┌──────────────────────────────────────────────────────────────┐
//   │ [thumb] [thumb] [thumb] [thumb] [thumb] ···                 │ ← CAROUSEL_THICK px
//   └──────────────────────────────────────────────────────────────┘  thumbnail strip
//   [bottom panel OR screen edge]
//
// Layout (landscape, collapsed):
//   ┌──────────────────────────────────────────────────────────────┐
//   │                      [▲ expand]                             │ ← COLLAPSED_THICK px
//   └──────────────────────────────────────────────────────────────┘
//   [bottom panel OR screen edge]
//
// TWO separate chrome actors:
//   _container        — thumbnail strip only (no controls inside)
//   _controlsContainer — floating bar above the strip
//
// Both are registered with Main.layoutManager.addChrome(), the canonical Cinnamon
// API for overlays. This ensures correct event routing and z-ordering above panels.
//
// Work area: global.display.get_monitor_work_area(idx) is trusted directly.
//   • With a panel: returns reduced area → carousel sits above the panel.
//   • No panel:     returns full monitor → carousel snaps to the screen edge.
// Fallback path (if the API throws) inspects panelManager without assuming any
// panel height — if nothing is found, botH = 0 (snap to edge).
//
// Collapse animation: tweens _container.height AND _container.y simultaneously
// so the strip folds DOWN toward the panel (top edge moves down, bottom stays fixed).

const St      = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Tweener = imports.ui.tweener;
const Main    = imports.ui.main;
const GLib    = imports.gi.GLib;

const Utils = require('./modules/Utils');   // relative to the applet dir, as in applet.js

// ── Constants ──────────────────────────────────────────────────────────────────

// CAROUSEL_THICK equals THUMB_H_LAND (landscape) / THUMB_W_PORT (portrait) so
// the strip is exactly as tall/wide as its content — no empty space below thumbnails.
const THUMB_H_LAND    = 140;
const THUMB_W_LAND    = 250;  // 16∶9 at 250 px wide
const THUMB_H_PORT    = 250;
const THUMB_W_PORT    = 140;
const CAROUSEL_THICK  = 140;  // = THUMB_H_LAND = THUMB_W_PORT
const COLLAPSED_THICK = 32;   // Collapsed bar height/width
const CONTROLS_H      = 36;   // Floating controls bar height (2×3 px padding + 30 px buttons)
const CONTROLS_GAP    = 6;    // Gap between controls bar bottom and thumbnail strip top
const THUMB_SPACING   = 4;
const LOAD_BUFFER     = 8;    // Extra items loaded beyond the visible viewport
const ANIM_TIME       = 0.18; // Collapse/expand animation duration, seconds

// ── CarouselManager ────────────────────────────────────────────────────────────

var CarouselManager = class CarouselManager {

    constructor(stateManager, thumbnailCache, applet) {
        this._stateManager = stateManager;
        this._thumbCache   = thumbnailCache;
        this._applet       = applet;
        this._carousels    = new Map();
        this._imagePools   = new Map();
        this._syncPool     = null;
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

    openCarousel(monitor) {
        let existing = this._carousels.get(monitor.name);
        if (existing) { existing.expand(); return; }
        let c = new Carousel(
            monitor,
            this._getImagesFor(monitor.name),
            this._getCurrentImage(monitor.name),
            this._thumbCache, this._applet,
            () => this._onCarouselClosed(monitor.name)
        );
        this._carousels.set(monitor.name, c);
        this._applet._updateMenuState();
    }

    closeCarousel(monitorName) {
        let c = this._carousels.get(monitorName);
        if (!c) return;
        c.destroy();
        this._carousels.delete(monitorName);
        this._applet._updateMenuState();
    }

    isOpen(monitorName) { return this._carousels.has(monitorName); }

    destroy() {
        for (let name of [...this._carousels.keys()]) this.closeCarousel(name);
    }

    _onCarouselClosed(monitorName) {
        this._carousels.delete(monitorName);
        this._applet._updateMenuState();
    }

    _getImagesFor(monitorName) {
        let pool = this._syncPool || this._imagePools.get(monitorName);
        return pool ? pool.getImages() : [];
    }

    _getCurrentImage(monitorName) {
        let rec = this._stateManager.getMonitorRecord(monitorName);
        return rec ? rec.currentImage : null;
    }
};

// ── Carousel ───────────────────────────────────────────────────────────────────

class Carousel {

    constructor(monitor, images, currentImage, thumbCache, applet, onClosed) {
        this._mon          = monitor;
        this._images       = images;
        this._currentImage = currentImage;
        this._thumbCache   = thumbCache;
        this._applet       = applet;
        this._onClosed     = onClosed;
        this._isPortrait   = (monitor.width < monitor.height);
        this._thumbW       = this._isPortrait ? THUMB_W_PORT : THUMB_W_LAND;
        this._thumbH       = this._isPortrait ? THUMB_H_PORT : THUMB_H_LAND;
        this._thumbStep    = (this._isPortrait ? this._thumbH : this._thumbW) + THUMB_SPACING;
        this._items        = [];
        this._collapsed    = false;
        this._scrollSigId  = null;
        this._chromeActors = []; // [{actor, usingChrome}]
        this._wa           = null;
        this._build();
    }

    // ── Public ─────────────────────────────────────────────────────────────────

    setCurrentImage(imagePath) {
        let oldIdx = this._images.indexOf(this._currentImage);
        if (oldIdx >= 0 && this._items[oldIdx]) this._items[oldIdx].clearCurrent();
        this._currentImage = imagePath;
        this._updateActionButtons();
        let newIdx = this._images.indexOf(imagePath);
        if (newIdx >= 0 && this._items[newIdx]) {
            this._items[newIdx].markCurrent();
            this._scrollToIndex(newIdx);
        }
    }

    refreshImages(images) {
        this._images = images;
        this._rebuildStrip();
        this._scrollToCurrentImage();
    }

    expand() {
        if (!this._collapsed) return;
        this._collapsed = false;

        this._container.remove_style_class_name('wallshift-carousel-collapsed');
        this._scrollView.show();
        this._expandBtn.hide();

        let wa = this._wa;
        if (this._isPortrait) {
            // Portrait: strip grows wider (left edge stays, right edge expands)
            Tweener.addTween(this._container, {
                width: CAROUSEL_THICK,
                time: ANIM_TIME,
                transition: 'easeOutQuad',
                onComplete: () => {
                    this._controlsContainer.show();
                    this._loadVisibleThumbnails();
                }
            });
        } else {
            // Landscape: strip grows taller — tween height AND y together so the
            // top edge moves UP while the bottom stays fixed at the panel/edge.
            let targetY = wa.y + wa.height - CAROUSEL_THICK;
            Tweener.addTween(this._container, {
                height: CAROUSEL_THICK,
                y: targetY,
                time: ANIM_TIME,
                transition: 'easeOutQuad',
                onComplete: () => {
                    this._controlsContainer.show();
                    this._loadVisibleThumbnails();
                }
            });
        }
    }

    collapse() {
        if (this._collapsed) return;
        this._collapsed = true;

        // Hide controls immediately — the strip collapses down to a thin bar
        this._controlsContainer.hide();

        let wa = this._wa;
        if (this._isPortrait) {
            // Portrait: strip shrinks to COLLAPSED_THICK width
            Tweener.addTween(this._container, {
                width: COLLAPSED_THICK,
                time: ANIM_TIME,
                transition: 'easeInQuad',
                onComplete: () => {
                    this._scrollView.hide();
                    this._expandBtn.show();
                    this._container.add_style_class_name('wallshift-carousel-collapsed');
                }
            });
        } else {
            // Landscape: tween height AND y so the top edge slides DOWN toward
            // the panel — the bottom stays fixed, the strip folds downward.
            let targetY = wa.y + wa.height - COLLAPSED_THICK;
            Tweener.addTween(this._container, {
                height: COLLAPSED_THICK,
                y: targetY,
                time: ANIM_TIME,
                transition: 'easeInQuad',
                onComplete: () => {
                    this._scrollView.hide();
                    this._expandBtn.show();
                    this._container.add_style_class_name('wallshift-carousel-collapsed');
                }
            });
        }
    }

    destroy() {
        if (this._scrollSigId !== null) {
            try {
                let adj = this._adjustment();
                adj.disconnect(this._scrollSigId);
            } catch(e) {}
            this._scrollSigId = null;
        }
        for (let item of this._items) item.alive = false;
        this._items = [];
        Tweener.removeTweens(this._container);
        this._removeAllActors();
        this._container.destroy();
        this._controlsContainer.destroy();
    }

    // ── Build ──────────────────────────────────────────────────────────────────

    _build() {
        let wa = this._getWorkArea();
        this._wa = wa;
        this._darkMode = this._detectDarkMode();

        // ── Thumbnail strip container ──────────────────────────────────────────
        // Landscape: full-width, CAROUSEL_THICK px tall, anchored to bottom of
        //            work area (just above panel, or at screen bottom if no panel).
        // Portrait:  CAROUSEL_THICK px wide, full work-area height below controls.
        let cW, cH, cX, cY;
        if (this._isPortrait) {
            cW = CAROUSEL_THICK;
            cH = wa.height - CONTROLS_H - CONTROLS_GAP;
            cX = wa.x;
            cY = wa.y + CONTROLS_H + CONTROLS_GAP;
        } else {
            cW = wa.width;
            cH = CAROUSEL_THICK;
            cX = wa.x;
            cY = wa.y + wa.height - CAROUSEL_THICK;
        }

        // St.Widget uses ClutterFixedLayout — children must be positioned explicitly.
        this._container = new St.Widget({
            style_class: 'wallshift-carousel',
            reactive: true,
            clip_to_allocation: true
        });
        this._container.set_size(cW, cH);
        this._container.set_position(cX, cY);

        // ScrollView fills the entire container — no space consumed by a controls bar
        this._scrollView = new St.ScrollView({
            style_class: 'wallshift-carousel-scroll',
            reactive: true
        });
        this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.NEVER);
        this._scrollView.set_position(0, 0);
        this._scrollView.set_size(cW, cH);

        this._strip = new St.BoxLayout({
            style_class: 'wallshift-carousel-strip',
            vertical: this._isPortrait,
            reactive: true
        });
        this._scrollView.add_actor(this._strip);

        // Connect scroll on the strip — it fires before St.ScrollView's built-in
        // handler (deepest reactive), so we can return EVENT_STOP to prevent
        // St.ScrollView from double-handling the event.
        this._strip.connect('scroll-event', (_a, e) => this._onScrollWheel(e));

        this._container.add_child(this._scrollView);

        // Expand button: shown only when collapsed; same styling as controls bar buttons.
        let expandIcon = this._isPortrait ? 'go-next-symbolic' : 'go-up-symbolic';
        this._expandBtn = this._mkBtn(expandIcon, 'wallshift-carousel-btn', () => this.expand());
        // Small centered button — NOT full-width/height.
        // The container still fills the full span so scroll events are captured,
        // but the expand button itself is compact and centered within it.
        if (this._isPortrait) {
            let ebH = 80;
            this._expandBtn.set_size(COLLAPSED_THICK, ebH);
            this._expandBtn.set_position(0, Math.floor((cH - ebH) / 2));
        } else {
            let ebW = 80;
            this._expandBtn.set_size(ebW, COLLAPSED_THICK);
            this._expandBtn.set_position(Math.floor((cW - ebW) / 2), 0);
        }
        this._expandBtn.hide();
        this._container.add_child(this._expandBtn);

        // ── Floating controls bar (separate chrome actor, centered above the strip) ─
        // Width is NOT set explicitly — St.BoxLayout auto-sizes to its button content.
        // An idle callback reads the natural width after layout and recenters the bar.
        //
        // Landscape: centered over the full monitor width, CONTROLS_GAP px above strip.
        // Portrait:  centered over the CAROUSEL_THICK-wide strip, at top of work area.
        let ctY = this._isPortrait ? wa.y : (cY - CONTROLS_H - CONTROLS_GAP);

        this._controlsContainer = new St.BoxLayout({
            style_class: 'wallshift-carousel-controls',
            vertical: false,
            reactive: true
        });
        // Position Y now; X is a temporary left-edge value corrected to center below.
        this._controlsContainer.set_position(wa.x, ctY);
        // No set_size — natural width comes from button content; height from CSS min-height.

        this._controlsContainer.connect('scroll-event', (_a, e) => this._onScrollWheel(e));

        // Buttons are grouped together (no spacer) — the whole bar is centered.
        let collapseIcon = this._isPortrait ? 'go-previous-symbolic' : 'go-down-symbolic';
        this._collapseBtn = this._mkBtn(collapseIcon, 'wallshift-carousel-btn',
            () => this.collapse());
        this._controlsContainer.add_child(this._collapseBtn);

        this._favBtn = this._mkBtn('emblem-favorite-symbolic', 'wallshift-carousel-btn',
            () => {
                if (this._currentImage)
                    this._applet._favoriteMonitorImage(this._mon.name);
            });
        this._controlsContainer.add_child(this._favBtn);

        this._trashBtn = this._mkBtn('user-trash-symbolic', 'wallshift-carousel-btn',
            () => {
                if (this._currentImage) this._trashCurrent();
            });
        this._controlsContainer.add_child(this._trashBtn);

        this._closeBtn = this._mkBtn('window-close-symbolic', 'wallshift-carousel-btn',
            () => { this.destroy(); this._onClosed(); });
        this._controlsContainer.add_child(this._closeBtn);

        this._updateActionButtons();

        // ── Register actors with Cinnamon's chrome layer ────────────────────────
        this._rebuildStrip();
        this._addActor(this._container);
        this._addActor(this._controlsContainer);

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            // Center the controls bar horizontally over the carousel strip.
            // get_preferred_width works on unmapped St actors once children are added.
            try {
                let [, natW] = this._controlsContainer.get_preferred_width(-1);
                let spanW    = this._isPortrait ? CAROUSEL_THICK : wa.width;
                let centeredX = wa.x + Math.max(0, Math.floor((spanW - natW) / 2));
                this._controlsContainer.set_position(centeredX, ctY);
            } catch(e) {}

            this._connectScrollSignal();
            this._scrollToCurrentImage();
            this._loadVisibleThumbnails();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Chrome actor management ────────────────────────────────────────────────

    // Registers an actor with addChrome (with uiGroup/stage fallbacks).
    // Tracks each actor + its registration method in _chromeActors for cleanup.
    _addActor(actor) {
        let usingChrome = false;
        try {
            Main.layoutManager.addChrome(actor, {
                affectsStruts: false,
                visibleInFullscreen: true
            });
            usingChrome = true;
        } catch(e) {
            Utils.warn('Carousel: addChrome unavailable (' + e.message +
                '), falling back to uiGroup');
            try {
                Main.uiGroup.add_actor(actor);
                Main.uiGroup.set_child_above_sibling(actor, null);
            } catch(e2) {
                global.stage.add_child(actor);
            }
        }
        this._chromeActors.push({ actor, usingChrome });
    }

    _removeAllActors() {
        for (let { actor, usingChrome } of this._chromeActors) {
            if (usingChrome) {
                try { Main.layoutManager.removeChrome(actor); continue; } catch(e) {}
            }
            try { Main.uiGroup.remove_actor(actor); continue; } catch(e) {}
            try { global.stage.remove_child(actor); } catch(e) {}
        }
        this._chromeActors = [];
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    // Detect whether the active Cinnamon theme is dark.
    // Primary: check the panel actor's computed background luminance (the panel
    //          IS properly themed, so its color reliably indicates the mode).
    // Fallback: check the org.cinnamon.theme name for the word "dark".
    _detectDarkMode() {
        try {
            let panelActor = Main.panel ? (Main.panel.actor || Main.panel) : null;
            if (panelActor) {
                let node = panelActor.get_theme_node();
                let bg   = node.get_background_color(); // Clutter.Color, 0–255 per channel
                if (bg.alpha > 0) {
                    let luma = (0.299 * bg.red + 0.587 * bg.green + 0.114 * bg.blue) / 255;
                    return luma < 0.5;
                }
            }
        } catch(e) {}
        try {
            let s = new Gio.Settings({ schema_id: 'org.cinnamon.theme' });
            return s.get_string('name').toLowerCase().indexOf('dark') !== -1;
        } catch(e) {}
        return false;
    }

    _mkBtn(iconName, styleClass, onClick) {
        // Append a theme-variant class so the button gets system-appropriate colors.
        // The 'button' class from Cinnamon's theme CSS is only effective inside
        // popup/dialog parent contexts; standalone chrome actors don't inherit it.
        // Instead we apply our own light/dark variant computed from the panel color.
        let variant = this._darkMode
            ? 'wallshift-carousel-btn-dark'
            : 'wallshift-carousel-btn-light';
        let btn = new St.Button({
            style_class: styleClass + ' ' + variant,
            child: new St.Icon({ icon_name: iconName, icon_size: 16 }),
            reactive: true
        });
        btn.connect('clicked', onClick);
        return btn;
    }

    // Dims fav/trash buttons when no current image is known (they still exist in
    // the controls bar but give visual feedback that they have nothing to act on).
    _updateActionButtons() {
        let has = !!this._currentImage;
        for (let btn of [this._favBtn, this._trashBtn]) {
            if (!btn) continue;
            btn.reactive = has;
            btn.set_opacity(has ? 255 : 80);
        }
    }

    // ── Strip management ───────────────────────────────────────────────────────

    _rebuildStrip() {
        for (let item of this._items) item.alive = false;
        this._items = [];
        this._strip.destroy_all_children();

        let currentIdx = this._images.indexOf(this._currentImage);
        for (let i = 0; i < this._images.length; i++) {
            let path = this._images[i];
            let item = new ThumbnailItem(path, this._thumbW, this._thumbH);

            if (i === currentIdx) item.markCurrent();

            let cap = path;
            item.connectClicked(() => {
                if (item.alive)
                    this._applet._applyImageToMonitor(this._mon.name, cap);
            });

            this._items.push(item);
            this._strip.add_child(item.actor);
        }
    }

    // ── Scroll ─────────────────────────────────────────────────────────────────

    // The scrollable axis depends on orientation: portrait strips scroll
    // vertically, landscape strips horizontally. Every scroll operation goes
    // through this one accessor. May throw if the ScrollView isn't allocated yet —
    // callers that run before layout wrap it in try/catch.
    _adjustment() {
        return this._isPortrait
            ? this._scrollView.vscroll.adjustment
            : this._scrollView.hscroll.adjustment;
    }

    _onScrollWheel(event) {
        let dir = event.get_scroll_direction();
        let adj = this._adjustment();
        let step = this._thumbStep;
        if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            adj.value = Math.min(adj.value + step, Math.max(0, adj.upper - adj.page_size));
        else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            adj.value = Math.max(adj.value - step, 0);
        return Clutter.EVENT_STOP;
    }

    _connectScrollSignal() {
        try {
            let adj = this._adjustment();
            this._scrollSigId = adj.connect('notify::value',
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
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                let adj = this._adjustment();
                let viewport   = adj.page_size || CAROUSEL_THICK;
                let itemCenter = idx * this._thumbStep + this._thumbStep / 2;
                adj.value = Math.max(0,
                    Math.min(itemCenter - viewport / 2, adj.upper - viewport));
            } catch(e) {}
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Lazy thumbnail loading ─────────────────────────────────────────────────

    _loadVisibleThumbnails() {
        try {
            let adj = this._adjustment();
            let pos   = adj.value;
            let view  = adj.page_size || CAROUSEL_THICK;
            let first = Math.max(0,
                Math.floor(pos / this._thumbStep) - LOAD_BUFFER);
            let last  = Math.min(this._items.length - 1,
                Math.ceil((pos + view) / this._thumbStep) + LOAD_BUFFER);

            for (let i = first; i <= last; i++) {
                let item = this._items[i];
                if (!item || item.loaded || !item.alive) continue;
                item.loaded = true;
                let cap = item;
                this._thumbCache.ensureThumbnail(item.path, this._isPortrait,
                    (err, cachePath) => {
                        if (!cap.alive) return;
                        if (err) return;
                        let ok = cap.setTexture(cachePath, this._thumbW, this._thumbH);
                        if (!ok) {
                            // Cache file was corrupt — delete and retry after a short delay
                            cap.loaded = false;
                            try { GLib.unlink(cachePath); } catch(e) {}
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                                this._loadVisibleThumbnails();
                                return GLib.SOURCE_REMOVE;
                            });
                        }
                    });
            }
        } catch(e) { /* not yet allocated */ }
    }

    // ── Actions ────────────────────────────────────────────────────────────────

    _trashCurrent() {
        let path = this._currentImage;
        let idx  = this._images.indexOf(path);
        if (idx >= 0) {
            this._images.splice(idx, 1);
            let item = this._items.splice(idx, 1)[0];
            item.alive = false;
            try { this._strip.remove_child(item.actor); } catch(e) {}
            item.actor.destroy();
        }
        this._applet._trashMonitorImage(this._mon.name);
    }

    // ── Work area ──────────────────────────────────────────────────────────────

    _findMonitorIndex() {
        let lms = Main.layoutManager.monitors;
        for (let i = 0; i < lms.length; i++) {
            let lm = lms[i];
            if (lm.x === this._mon.x && lm.y === this._mon.y &&
                lm.width === this._mon.width && lm.height === this._mon.height)
                return i;
        }
        return Main.layoutManager.primaryIndex !== undefined
            ? Main.layoutManager.primaryIndex : 0;
    }

    // Returns the usable area of the monitor (excluding panels).
    //
    // Strategy:
    //   1. Trust global.display.get_monitor_work_area() directly. When no panel
    //      is present it returns the full monitor — that is the correct answer
    //      (carousel snaps to screen edge). No additional "is it smaller?"
    //      check, which previously caused false-negatives on panel-less monitors.
    //   2. If the API throws, fall back to inspecting panelManager. Only panels
    //      whose x-range overlaps this monitor are counted. If none are found,
    //      topH/botH remain 0 — NO 40 px assumption.
    _getWorkArea() {
        try {
            let idx = this._findMonitorIndex();
            let wa  = global.display.get_monitor_work_area(idx);
            if (wa && wa.width > 0 && wa.height > 0) {
                return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
            }
        } catch(e) {}

        // Fallback: manual panel inspection
        let topH = 0, botH = 0;
        try {
            for (let p of this._getPanelList()) {
                if (!p || !p.actor || !p.actor.visible) continue;
                let pos = p.panelPosition !== undefined ? p.panelPosition : p._position;
                let h   = p.actor.get_height ? p.actor.get_height() : (p.actor.height || 0);
                // Filter to panels that overlap this monitor's x-range
                let px = p.actor.get_x ? p.actor.get_x() : (p.actor.x || 0);
                let pw = p.actor.get_width ? p.actor.get_width() : (p.actor.width || 0);
                if (px + pw <= this._mon.x || px >= this._mon.x + this._mon.width) continue;
                if (pos === 0) topH = Math.max(topH, h);
                if (pos === 1) botH = Math.max(botH, h);
            }
        } catch(e) {}

        return {
            x:      this._mon.x,
            y:      this._mon.y + topH,
            width:  this._mon.width,
            height: this._mon.height - topH - botH
        };
    }

    _getPanelList() {
        let mgr = Main.panelManager;
        if (!mgr) return [];
        if (typeof mgr.getPanels === 'function') return mgr.getPanels();
        if (Array.isArray(mgr._panels))
            return mgr._panels.flat ? mgr._panels.flat() : [].concat(...mgr._panels);
        if (Array.isArray(mgr.panels)) return mgr.panels;
        return [];
    }
}

// ── ThumbnailItem ──────────────────────────────────────────────────────────────
//
// A single thumbnail slot. Uses a plain Clutter.Actor as the root (fixed layout)
// containing one St.Button. No fav/trash overlay — those are in the controls bar.
// markCurrent() only adds a CSS highlight; clearCurrent() removes it.

class ThumbnailItem {

    constructor(path, thumbW, thumbH) {
        this.path    = path;
        this.loaded  = false;
        this.alive   = true;
        this._thumbW = thumbW;
        this._thumbH = thumbH;

        // Non-reactive root actor (fixed layout container)
        this.actor = new Clutter.Actor({
            width: thumbW, height: thumbH, reactive: false
        });

        this._btn = new St.Button({
            style_class: 'wallshift-carousel-thumb',
            width: thumbW, height: thumbH,
            reactive: true
        });

        this._placeholder = new St.Bin({
            style_class: 'wallshift-carousel-placeholder',
            width: thumbW, height: thumbH
        });
        this._btn.set_child(this._placeholder);
        this.actor.add_child(this._btn);
    }

    connectClicked(cb) { this._btn.connect('clicked', cb); }

    // Replace the placeholder with a real image texture.
    // Returns true on success, false if the cache file was unreadable.
    setTexture(cachePath, w, h) {
        try {
            const GdkPixbuf = imports.gi.GdkPixbuf;
            const Cogl      = imports.gi.Cogl;
            let pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(cachePath, w, h, false);
            let image  = new Clutter.Image();
            image.set_data(
                pixbuf.get_pixels(),
                pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                pixbuf.get_width(), pixbuf.get_height(),
                pixbuf.get_rowstride()
            );
            let imgActor = new Clutter.Actor({ width: w, height: h, reactive: false });
            imgActor.set_content(image);
            this._btn.set_child(imgActor);
            return true;
        } catch(e) {
            Utils.warn('ThumbnailItem.setTexture: ' + cachePath + ': ' + e.message);
            return false;
        }
    }

    // Add a highlight border to indicate this is the current wallpaper.
    markCurrent() {
        this._btn.add_style_class_name('wallshift-carousel-current');
    }

    clearCurrent() {
        this._btn.remove_style_class_name('wallshift-carousel-current');
    }
}
