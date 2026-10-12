// applet.js — Wallshift: local wallpaper rotation for Cinnamon.
//
// All user-facing settings live in AppletSettings (right-click → Configure).
// StateManager/state.json holds only runtime state: pause flags, current images,
// history, and the trashed-paths exclusion list.

const Applet    = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings  = imports.ui.settings;
const Main      = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const GLib      = imports.gi.GLib;
const Gio       = imports.gi.Gio;
const St        = imports.gi.St;
const Clutter   = imports.gi.Clutter;
const Pango     = imports.gi.Pango;

// Local modules, loaded through Cinnamon's own require() so that reloading the
// applet re-evaluates them as well. (The GJS importer — the search path plus
// imports.<dir>.<Module> — caches a module for the life of the Cinnamon process,
// so after a reload the new applet.js would run against the old modules.) Paths
// are relative to the applet directory, from here and from inside modules/ alike.
const Utils           = require('./modules/Utils');
const StateManager    = require('./modules/StateManager').StateManager;
const MonitorManager  = require('./modules/MonitorManager').MonitorManager;
const ImagePool       = require('./modules/ImagePool').ImagePool;
const Compositor      = require('./modules/Compositor').Compositor;
const CarouselManager = require('./modules/CarouselManager').CarouselManager;
const ThumbnailCache  = require('./modules/ThumbnailCache').ThumbnailCache;

// normalizePath / absoluteDirOr live in Utils.js (testable outside Cinnamon).
const normalizePath = Utils.normalizePath;
const absoluteDirOr = Utils.absoluteDirOr;

// Strings go through the applet's own gettext domain (Utils._).
const _ = Utils._;

const ICON_NORMAL = 'preferences-desktop-wallpaper-symbolic';
const ICON_PAUSED = 'media-playback-pause-symbolic';

// Symbolic icons for the menu rows (all present in Adwaita, Mint-Y's fallback).
const ICONS = {
    next:     'go-next-symbolic',
    previous: 'go-previous-symbolic',
    pause:    'media-playback-pause-symbolic',
    swap:     'object-flip-horizontal-symbolic',
    monitor:  'video-display-symbolic',
    carousel: 'view-grid-symbolic',
    favorite: 'non-starred-symbolic',
    starred:  'starred-symbolic',
    trash:    'user-trash-symbolic',
    viewer:   'image-x-generic-symbolic',
    refresh:  'view-refresh-symbolic',
    folder:   'folder-open-symbolic',
};

class WallshiftApplet extends Applet.IconApplet {

    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight);

        this._metadata    = metadata;
        this._instanceId  = instanceId;

        // ── Panel appearance (icon follows the pause state once state is loaded) ─
        this.set_applet_icon_symbolic_name(ICON_NORMAL);
        this.set_applet_tooltip(_('Wallshift'));

        // ── Runtime state ──────────────────────────────────────────────────────
        this._destroyed            = false;  // set by on_applet_removed_from_panel()
        this._timerId              = null;
        this._timerStartedAt       = 0;      // GLib monotonic µs when the timer was armed
        this._timerInterval        = 0;      // seconds
        this._compositeInProgress  = false;
        this._pendingChange        = false;
        this._historyPosition      = 0;
        this._imagePools           = new Map();  // monitorName → ImagePool
        this._syncPool             = null;
        this._imagemagickAvailable = false;
        this._monitorsReady        = false;
        this._poolGen              = 0;      // Invalidates a superseded _setupImagePools()

        // ── Directories ────────────────────────────────────────────────────────
        this._stateDir = GLib.get_home_dir() + '/.local/share/wallshift';
        this._cacheDir = this._stateDir + '/cache';

        // ── Per-monitor config (written by configure.py, watched via FileMonitor) ──
        this._monitorConfigPath    = this._stateDir + '/monitor-config.json';
        this._monitorConfig        = { monitors: {} };
        this._monitorConfigMonitor = null;
        this._monitorConfigTimer   = null;
        this._loadMonitorConfig();
        // The settings dialog signals a manual "Refresh Monitors" by bumping
        // refreshToken in monitor-config.json (which we already watch below).
        this._lastRefreshToken     = this._monitorConfig.refreshToken || 0;
        this._watchMonitorConfig();

        // ── AppletSettings (right-click → Configure) ───────────────────────────
        this._settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this._bindSettings();

        // ── Modules ────────────────────────────────────────────────────────────
        this._stateManager = new StateManager(this._stateDir);
        this._stateManager.load();
        this._updatePanelIcon();   // rotation may have been paused before a reload

        this._compositor = new Compositor(this._cacheDir);

        this._imagemagickAvailable = GLib.find_program_in_path('convert') !== null;
        if (!this._imagemagickAvailable) {
            Utils.warn('ImageMagick (convert) not found — multi-monitor compositing disabled');
        }

        // ── Carousel ───────────────────────────────────────────────────────────
        this._thumbnailCache  = new ThumbnailCache(this._stateDir);
        this._carouselManager = new CarouselManager(
            this._stateManager, this._thumbnailCache, this);
        this._carouselManager.setOptions(this._carouselOptions());

        // ── Panel menu ─────────────────────────────────────────────────────────
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu        = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._buildMenu();

        // ── Panel icon: scroll = previous / next; tooltip refreshed on hover ───
        this._scrollSigId = this.actor.connect('scroll-event', (_a, e) => this._onPanelScroll(e));
        this._enterSigId  = this.actor.connect('enter-event', () => { this._updateTooltip(); });

        // ── Monitor detection (async) ──────────────────────────────────────────
        this._monitorManager = new MonitorManager(this);
        this._monitorManager.init(monitors => this._onMonitorsReady(monitors),
            this._detectionInterval, this._detectionPollEnabled !== false);

    }

    // ── Settings binding ───────────────────────────────────────────────────────

    _bindSettings() {
        let rebuildTimer = () => {
            if (this._monitorsReady && !this._stateManager.isPaused()) this._startTimer();
        };

        // Any change to pool-affecting settings: rebuild pools then immediately
        // apply a new wallpaper so the change is visible at once.
        let rebuildAndChange = () => {
            this._setupImagePools(() => {
                if (this._monitorsReady) {
                    this._historyPosition = 0;
                    this._changeWallpaper();
                }
            });
        };

        this._settings.bind('interval-minutes',   '_intervalMinutes',   rebuildTimer);
        this._settings.bind('interval-seconds',   '_intervalSeconds',   rebuildTimer);
        this._settings.bind('image-order',        '_imageOrder',        rebuildAndChange);
        this._settings.bind('show-notifications', '_showNotifications', null);
        this._settings.bind('favorites-folder',   '_favoritesFolder',   () => {
            if (this._carouselManager) this._carouselManager.refreshFavorite();
        });
        this._settings.bind('sync-mode',     '_syncMode',     rebuildAndChange);
        this._settings.bind('global-folder', '_globalFolder', rebuildAndChange);
        let repoll = () => {
            if (this._monitorManager)
                this._monitorManager.setPollInterval(this._detectionInterval,
                    this._detectionPollEnabled !== false);
        };
        this._settings.bind('detection-interval-minutes', '_detectionInterval', repoll);
        this._settings.bind('detection-poll-enabled', '_detectionPollEnabled', repoll);

        let carousel = () => {
            if (this._carouselManager) this._carouselManager.setOptions(this._carouselOptions());
        };
        this._settings.bind('carousel-edge',          '_carouselEdge',        carousel);
        this._settings.bind('carousel-thumb-size',    '_carouselThumbSize',   carousel);
        this._settings.bind('carousel-file-names',    '_carouselFileNames',   carousel);
        this._settings.bind('carousel-close-on-pick', '_carouselCloseOnPick', carousel);

    }

    _carouselOptions() {
        return {
            edge:        this._carouselEdge === 'top' ? 'top' : 'bottom',
            thumbSize:   ['small', 'medium', 'large'].includes(this._carouselThumbSize)
                             ? this._carouselThumbSize : 'medium',
            fileNames:   ['hover', 'always', 'never'].includes(this._carouselFileNames)
                             ? this._carouselFileNames : 'hover',
            closeOnPick: !!this._carouselCloseOnPick,
        };
    }

    // Opens configure.py — the single settings window for this applet.
    configureApplet() {
        GLib.spawn_command_line_async(
            '/usr/bin/python3 ' + this._metadata.path + '/configure.py ' +
            this._metadata.uuid + ' ' + this._instanceId
        );
    }

    // Returns the config for a given monitor.
    // Enabled/Scaling come from monitor-config.json (written by configure.py).
    // Per-monitor folder overrides are deferred (F12).
    _getSlotConfig(monitorName) {
        let override = (this._monitorConfig.monitors || {})[monitorName] || {};
        let folder = override.folder || this._globalFolder || '';
        return {
            enabled: override.enabled !== false,
            scaling: override.scaling || 'zoom',
            folder:  normalizePath(folder)
        };
    }

    // ── monitor-config.json ────────────────────────────────────────────────────

    _loadMonitorConfig() {
        try {
            let [ok, contents] = GLib.file_get_contents(this._monitorConfigPath);
            if (ok && contents) {
                this._monitorConfig = JSON.parse(Utils.bytesToString(contents));
            }
        } catch(e) {
            this._monitorConfig = { monitors: {} };
        }
    }

    _watchMonitorConfig() {
        try {
            let file = Gio.File.new_for_path(this._monitorConfigPath);
            this._monitorConfigMonitor = file.monitor_file(
                Gio.FileMonitorFlags.NONE, null);
            this._monitorConfigMonitor.connect('changed', () => {
                if (this._monitorConfigTimer) {
                    GLib.source_remove(this._monitorConfigTimer);
                }
                this._monitorConfigTimer = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, 200, () => {
                        this._monitorConfigTimer = null;
                        this._onMonitorConfigChanged();
                        return GLib.SOURCE_REMOVE;
                    }
                );
            });
        } catch(e) {
            Utils.warn('Could not watch monitor-config.json: ' + e.message);
        }
    }

    _onMonitorConfigChanged() {
        this._loadMonitorConfig();

        // A manual "Refresh Monitors" from the settings dialog: re-detect the
        // topology and recompose the saved images, without advancing wallpapers.
        let token = this._monitorConfig.refreshToken || 0;
        if (token !== this._lastRefreshToken) {
            this._lastRefreshToken = token;
            if (this._monitorsReady && this._monitorManager) {
                this._monitorManager.refresh();
            }
            return;
        }

        if (this._monitorsReady) {
            this._setupImagePools(() => this._changeWallpaper());
        }
    }

    // Manual monitor refresh (panel menu + settings dialog). Re-detects the
    // current topology and recomposes immediately.
    _refreshMonitors() {
        if (this._monitorManager) this._monitorManager.refresh();
    }

    _getIntervalSeconds() {
        return Utils.intervalSeconds(this._intervalMinutes, this._intervalSeconds);
    }

    // ── Monitor ready ──────────────────────────────────────────────────────────

    _onMonitorsReady(_monitors) {
        this._monitorsReady = true;
        this._setupImagePools(() => this._restoreOrStart());
    }

    // ── Image pool management ──────────────────────────────────────────────────

    // (Re)build the per-monitor pools (or the single sync pool) from the current
    // settings and scan their folders asynchronously. `onDone()` fires once every
    // pool is populated. Pools are swapped in immediately (empty), so a timer tick
    // that lands mid-scan simply carries the current images forward. A newer call
    // supersedes an older one still in flight.
    _setupImagePools(onDone) {
        if (!this._monitorManager) return;
        let gen      = ++this._poolGen;
        let monitors = this._monitorManager.getMonitors();
        let trashed  = this._stateManager.getTrashedPaths();
        let order    = this._imageOrder || 'no-repeat';

        // The global folder is the source for sync mode and the per-monitor fallback.
        let globalFolder = normalizePath(this._globalFolder || '');
        let fallback     = (globalFolder && Utils.dirExists(globalFolder))
            ? globalFolder
            : GLib.get_home_dir() + '/Pictures';

        let pools = [];
        if (this._syncMode) {
            this._syncPool = new ImagePool('sync');
            this._syncPool.setFolders([fallback]);
            this._syncPool.setTrashedPaths(trashed);
            this._syncPool.setOrder(order);
            this._imagePools = new Map();
            pools.push(this._syncPool);
        } else {
            this._syncPool = null;
            this._imagePools = new Map();
            for (let mon of monitors) {
                let slot   = this._getSlotConfig(mon.name);
                if (!slot.enabled) continue;
                let folder = (slot.folder && Utils.dirExists(slot.folder))
                    ? slot.folder
                    : fallback;
                let pool = new ImagePool(mon.name);
                pool.setFolders([folder]);
                pool.setTrashedPaths(trashed);
                pool.setOrder(order);
                this._imagePools.set(mon.name, pool);
                pools.push(pool);
            }
        }

        let pending = pools.length;
        let finish = () => {
            if (gen !== this._poolGen) return;   // superseded
            this._updateTooltip();
            if (this._carouselManager) {
                this._carouselManager.updatePools(this._imagePools, this._syncPool);
            }
            if (this._getTotalImageCount() === 0) {
                Utils.warn('No images found in any configured folder');
            }
            if (onDone) onDone();
        };

        if (pending === 0) { finish(); return; }
        for (let pool of pools) {
            pool.scan(() => { if (--pending === 0) finish(); });
        }
    }

    _getTotalImageCount() {
        if (this._syncPool) return this._syncPool.getCount();
        let total = 0;
        for (let pool of this._imagePools.values()) total += pool.getCount();
        return total;
    }

    // ── Timer ──────────────────────────────────────────────────────────────────

    _startTimer() {
        this._stopTimer();
        let interval = this._getIntervalSeconds();
        if (interval <= 0) return;
        this._timerStartedAt = GLib.get_monotonic_time();
        this._timerInterval  = interval;
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            if (!this._stateManager.isPaused()) {
                this._historyPosition = 0;
                this._changeWallpaper();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        this._timerStartedAt = 0;
    }

    _resetTimer() {
        if (!this._stateManager.isPaused()) this._startTimer();
    }

    // ── Assignment builders ────────────────────────────────────────────────────
    //
    // An "assignment" is { path, scaling } keyed by monitor name — the input the
    // Compositor consumes. These helpers centralize the per-monitor scaling lookup
    // and the saved-record access that the wallpaper pipeline below relies on.

    // One assignment for a known image path, with the monitor's configured scaling.
    _assignment(monName, path) {
        return { path, scaling: this._getSlotConfig(monName).scaling };
    }

    // Assignments restored from each monitor's last-saved image (skipping any whose
    // file no longer exists). Used to redraw without advancing the rotation.
    _restoreAssignments(monitors) {
        let assignments = {};
        for (let mon of monitors) {
            let rec = this._stateManager.getMonitorRecord(mon.name);
            if (rec && rec.currentImage && Utils.fileExists(rec.currentImage)) {
                assignments[mon.name] = this._assignment(mon.name, rec.currentImage);
            }
        }
        return assignments;
    }

    // Assignments drawn from a history snapshot's monitor→path map.
    _historyAssignments(entry, monitors) {
        let assignments = {};
        for (let mon of monitors) {
            let path = entry.monitors[mon.name];
            if (path && Utils.fileExists(path)) {
                assignments[mon.name] = this._assignment(mon.name, path);
            }
        }
        return assignments;
    }

    // Fill in any monitor missing from `assignments` with its saved current image,
    // so the composite includes paused/disabled/unchanged monitors. When a
    // `monitorImages` map is passed, carried-forward paths are recorded there too.
    _carryForwardCurrent(assignments, monitors, monitorImages) {
        for (let mon of monitors) {
            if (assignments[mon.name]) continue;
            let rec = this._stateManager.getMonitorRecord(mon.name);
            if (rec && rec.currentImage) {
                assignments[mon.name] = this._assignment(mon.name, rec.currentImage);
                if (monitorImages) monitorImages[mon.name] = rec.currentImage;
            }
        }
    }

    // ── Wallpaper change pipeline ──────────────────────────────────────────────

    _restoreOrStart() {
        let monitors    = this._monitorManager.getMonitors();
        let assignments = this._restoreAssignments(monitors);

        if (Object.keys(assignments).length > 0) {
            this._compose(monitors, assignments, false, null);
        } else {
            this._changeWallpaper();
        }

        if (!this._stateManager.isPaused()) this._startTimer();
    }

    // Advance all eligible monitors (timer-driven or explicit "Next Wallpaper").
    _changeWallpaper() {
        if (this._compositeInProgress) {
            this._pendingChange = true;
            return;
        }

        let allMonitors   = this._monitorManager.getMonitors();
        let assignments   = {};
        let monitorImages = {};

        if (this._syncMode) {
            // All enabled monitors get the same image from the sync pool.
            let eligible = allMonitors.filter(m => this._getSlotConfig(m.name).enabled);
            if (eligible.length === 0) return;

            let pool = this._syncPool;
            if (!pool || pool.getCount() === 0) {
                Utils.warn('Sync pool is empty — skipping change');
                return;
            }
            let path = pool.next();
            for (let mon of eligible) {
                assignments[mon.name]   = this._assignment(mon.name, path);
                monitorImages[mon.name] = path;
            }
        } else {
            // Each monitor advances independently, skipping globally- or
            // individually-paused monitors.
            let eligible = allMonitors.filter(m => {
                let slot = this._getSlotConfig(m.name);
                return slot.enabled && !this._stateManager.isMonitorPaused(m.name);
            });
            if (eligible.length === 0) return;

            for (let mon of eligible) {
                let pool = this._imagePools.get(mon.name);
                let path = pool ? pool.next() : null;
                if (!path) {
                    let rec = this._stateManager.getMonitorRecord(mon.name);
                    path = rec ? rec.currentImage : null;
                }
                if (path) {
                    assignments[mon.name]   = this._assignment(mon.name, path);
                    monitorImages[mon.name] = path;
                }
            }

            // Carry forward the current image for paused/disabled monitors so the
            // composite includes them unchanged (not recorded as a new change).
            this._carryForwardCurrent(assignments, allMonitors);
        }

        if (Object.keys(monitorImages).length === 0) {
            Utils.warn('No images available on any eligible monitor');
            return;
        }

        this._compose(allMonitors, assignments, true, monitorImages);
    }

    // Apply a specific image to one monitor, leaving all others at their current image.
    // In Sync mode every enabled monitor shows the same image, so the image goes to
    // all of them (a carousel click is the only caller that reaches here in Sync mode).
    _applyImageToMonitor(monitorName, path) {
        if (this._compositeInProgress) return;
        let allMonitors = this._monitorManager.getMonitors();
        let assignments = {};
        let monImages   = {};

        let targets = [monitorName];
        if (this._syncMode) {
            let enabled = allMonitors
                .filter(m => this._getSlotConfig(m.name).enabled)
                .map(m => m.name);
            if (enabled.length > 0) targets = enabled;
        }
        for (let name of targets) {
            assignments[name] = this._assignment(name, path);
            monImages[name]   = path;
        }

        // All other monitors keep their current image — recorded so the resulting
        // history snapshot captures the full desktop, not just the changed monitor.
        this._carryForwardCurrent(assignments, allMonitors, monImages);

        this._compose(allMonitors, assignments, true, monImages);
        this._resetTimer();
    }

    // Advance a single monitor to its next image from its pool.
    _changeMonitorWallpaper(monitorName) {
        if (this._syncMode) {
            // In sync mode all monitors are locked together — do a global change.
            this._changeWallpaper();
            return;
        }
        let pool = this._imagePools.get(monitorName);
        let path = pool ? pool.next() : null;
        if (!path) {
            Utils.warn('Pool empty for ' + monitorName);
            return;
        }
        this._applyImageToMonitor(monitorName, path);
    }

    // Step one monitor back through history.
    _navigateMonitorPrevious(monitorName) {
        if (this._syncMode) {
            // In sync mode, history navigation is global.
            this._navigatePrevious();
            return;
        }

        let rec     = this._stateManager.getMonitorRecord(monitorName);
        let current = rec ? rec.currentImage : null;
        let len     = this._stateManager.getHistoryLength();

        for (let i = 1; i <= len; i++) {
            let entry = this._stateManager.getHistoryAt(i);
            if (!entry) break;
            let path = entry.monitors[monitorName];
            if (path && path !== current && Utils.fileExists(path)) {
                this._applyImageToMonitor(monitorName, path);
                return;
            }
        }
        Utils.warn('No previous image in history for ' + monitorName);
    }

    // Core async pipeline: compositor → apply → save state → notify.
    _compose(monitors, assignments, isNewChange, monitorImages) {
        this._compositeInProgress = true;

        // Only need ImageMagick when 2+ monitors actually have images to composite.
        // Count active assignments, not total connected monitors — a disabled or
        // image-less monitor doesn't require compositing.
        let activeCount = monitors.filter(
            m => assignments[m.name] && assignments[m.name].path).length;

        if (activeCount > 1 && !this._imagemagickAvailable) {
            Utils.warn('ImageMagick missing — applying first monitor image only');
            let first = monitors.find(m => assignments[m.name] && assignments[m.name].path);
            let asgn  = first ? assignments[first.name] : null;
            if (asgn) this._applyWallpaper(asgn.path, 'zoom');
            this._compositeInProgress = false;
            this._checkPending();
            return;
        }

        this._compositor.compose(monitors, assignments, (err, outputPath, pictureOptions) => {
            this._compositeInProgress = false;
            if (this._destroyed) return;   // removed from the panel while ImageMagick ran

            if (err) {
                Utils.error('Compositor failed: ' + err.message);
            } else {
                this._applyWallpaper(outputPath, pictureOptions);

                if (isNewChange && monitorImages) {
                    // Monitors whose image actually changed (the rest were carried forward).
                    let changed = monitors.filter(m => {
                        if (!monitorImages[m.name]) return false;
                        let rec = this._stateManager.getMonitorRecord(m.name);
                        return !rec || rec.currentImage !== monitorImages[m.name];
                    });
                    for (let name in monitorImages) {
                        this._stateManager.setMonitorCurrentImage(name, monitorImages[name]);
                    }
                    if (this._historyPosition === 0) {
                        this._stateManager.pushHistory(monitorImages);
                    }
                    this._stateManager.save();

                    for (let name in monitorImages) {
                        this._carouselManager.onWallpaperChanged(
                            name, monitorImages[name]);
                    }

                    if (this._showNotifications) {
                        let entries = changed.map(m =>
                            ({ displayName: m.displayName || m.name, path: monitorImages[m.name] }));
                        if (entries.length)
                            this._notify(_('Wallpaper changed'), Utils.changeNotificationBody(entries));
                    }
                }

                this._updateTooltip();
            }

            this._checkPending();
        });
    }

    _checkPending() {
        if (this._destroyed) return;
        if (this._pendingChange) {
            this._pendingChange = false;
            this._changeWallpaper();
        }
    }

    _applyWallpaper(imagePath, pictureOptions) {
        try {
            let bgSettings = new Gio.Settings({schema_id: 'org.cinnamon.desktop.background'});
            bgSettings.set_string('picture-uri',     'file://' + imagePath);
            bgSettings.set_string('picture-options', pictureOptions);
        } catch(e) {
            Utils.error('_applyWallpaper failed: ' + e.message);
        }
    }

    // ── Global history navigation ──────────────────────────────────────────────

    _navigatePrevious() {
        let entry = this._stateManager.getHistoryAt(this._historyPosition + 1);
        if (!entry) return;
        this._historyPosition++;
        this._applyHistoryEntry(entry);
        this._resetTimer();
    }

    _navigateNext() {
        if (this._historyPosition === 0) {
            this._changeWallpaper();
        } else {
            this._historyPosition--;
            if (this._historyPosition === 0) {
                let monitors    = this._monitorManager.getMonitors();
                let assignments = this._restoreAssignments(monitors);
                if (Object.keys(assignments).length > 0) {
                    this._compose(monitors, assignments, false, null);
                }
            } else {
                let entry = this._stateManager.getHistoryAt(this._historyPosition);
                if (entry) this._applyHistoryEntry(entry);
            }
        }
        this._resetTimer();
    }

    _applyHistoryEntry(entry) {
        if (!entry) return;
        let monitors    = this._monitorManager.getMonitors();
        let assignments = this._historyAssignments(entry, monitors);
        if (Object.keys(assignments).length > 0) {
            this._compose(monitors, assignments, false, null);
        }
    }

    // ── Per-monitor favorites & trash ──────────────────────────────────────────

    // Favorite: copy the image into the favorites folder; on an image that is
    // already there, remove that copy (to the system trash) instead.
    _toggleFavorite(monitorName) {
        let rec = this._stateManager.getMonitorRecord(monitorName);
        if (!rec || !rec.currentImage) {
            Utils.warn('Favorite: no current image for ' + monitorName);
            return;
        }
        let src  = rec.currentImage;
        let name = src.split('/').pop();
        let favDir = this._favoritesDir();
        if (!this._isFavorite(src)) {
            if (this._copyToFavorites(src)) {
                this._notify(_('Wallshift'), _('Saved to Favorites: %s').replace('%s', name));
                if (this._carouselManager) this._carouselManager.refreshFavorite();
            }
            return;
        }
        // The image itself lives in the favorites folder: removing "the copy"
        // would remove the original, so leave it alone.
        if (src.substring(0, src.lastIndexOf('/')) === favDir) {
            this._notify(_('Wallshift'), _('%s is in your Favorites folder').replace('%s', name));
            return;
        }
        let copy = favDir + '/' + name;
        Utils.spawnAsync(['gio', 'trash', copy], (err, _out, stderr, code) => {
            if (this._destroyed) return;
            if (err || code !== 0) {
                Utils.error('gio trash failed for ' + copy + ': ' + (stderr || (err && err.message) || ''));
                return;
            }
            this._notify(_('Wallshift'), _('Removed from Favorites: %s').replace('%s', name));
            if (this._carouselManager) this._carouselManager.refreshFavorite();
        });
    }

    _favoritesDir() {
        return absoluteDirOr(
            normalizePath(this._favoritesFolder || ''),
            GLib.get_home_dir() + '/Pictures/Wallpaper Favorites',
            'Favorites folder');
    }

    // A file of the same name in the favorites folder counts as favorited.
    _isFavorite(path) {
        if (!path) return false;
        return Utils.fileExists(this._favoritesDir() + '/' + path.split('/').pop());
    }

    _trashMonitorImage(monitorName) {
        let rec = this._stateManager.getMonitorRecord(monitorName);
        if (!rec || !rec.currentImage) return;
        this._notify(_('Wallshift'), _('Moved to Trash: %s').replace('%s', rec.currentImage.split('/').pop()));
        this._trashPath(rec.currentImage);
        // Advance just this monitor to the next image.
        this._changeMonitorWallpaper(monitorName);
    }

    // The folder a monitor's images come from (for the carousel's empty message).
    _folderFor(monitorName) {
        let globalFolder = normalizePath(this._globalFolder || '');
        let fallback = (globalFolder && Utils.dirExists(globalFolder))
            ? globalFolder : GLib.get_home_dir() + '/Pictures';
        if (this._syncMode) return fallback;
        let slot = this._getSlotConfig(monitorName);
        return (slot.folder && Utils.dirExists(slot.folder)) ? slot.folder : fallback;
    }

    // Main.notify() with the applet's icon.
    _notify(title, body) {
        try {
            let source = new MessageTray.SystemNotificationSource();
            Main.messageTray.add(source);
            let icon = new St.Icon({ icon_name: ICON_NORMAL, icon_type: St.IconType.SYMBOLIC, icon_size: 24 });
            let n = new MessageTray.Notification(source, title, body, { icon });
            n.setTransient(true);
            source.notify(n);
        } catch(e) {
            Main.notify(title, body);
        }
    }

    // ── Shared helpers ─────────────────────────────────────────────────────────

    _copyToFavorites(src) {
        let favDir = this._favoritesDir();
        try {
            Utils.ensureDir(favDir);
            let dest = favDir + '/' + src.split('/').pop();

            // Use GLib read/write instead of Gio.File.copy() — the GIO binding in
            // Cinnamon's CJS runtime can silently no-op without throwing.
            let [ok, contents] = GLib.file_get_contents(src);
            if (!ok || !contents) {
                Utils.error('Favorite: could not read source file: ' + src);
                return false;
            }
            if (!GLib.file_set_contents(dest, contents)) {
                Utils.error('Favorite: could not write destination: ' + dest);
                return false;
            }

            return true;
        } catch(e) {
            Utils.error('Favorite copy failed for ' + src + ': ' + e.message);
            return false;
        }
    }

    _trashPath(path) {
        for (let pool of this._imagePools.values()) pool.removePath(path);
        if (this._syncPool) this._syncPool.removePath(path);
        this._stateManager.addTrashedPath(path);
        Utils.spawnAsync(['gio', 'trash', path], (err, _out, stderr, code) => {
            if (err || code !== 0) {
                Utils.error('gio trash failed for ' + path + ': ' +
                    (stderr || (err && err.message) || ''));
            }
        });
    }

    // ── Swap images across monitors ────────────────────────────────────────────

    // Rotate the current image of each monitor onto the next monitor.
    // With 2 monitors this is a pure swap (A↔B).
    // With 3+ it's a left rotation (A→B→C→A).
    _swapImages() {
        let allMonitors = this._monitorManager.getMonitors();

        // Build ordered list of monitors that have a current image.
        let eligible = allMonitors.filter(m => {
            let rec = this._stateManager.getMonitorRecord(m.name);
            return rec && rec.currentImage;
        });
        if (eligible.length < 2) return;

        // Collect paths in order, then rotate left by one position.
        let paths   = eligible.map(m => this._stateManager.getMonitorRecord(m.name).currentImage);
        let rotated = paths.slice(1).concat(paths[0]);

        // Build assignments: eligible monitors get the rotated images.
        let assignments  = {};
        let monitorImages = {};
        for (let i = 0; i < eligible.length; i++) {
            let mon = eligible[i];
            assignments[mon.name]   = this._assignment(mon.name, rotated[i]);
            monitorImages[mon.name] = rotated[i];
        }

        // Carry forward any monitors that had no image (shouldn't happen, but safe).
        this._carryForwardCurrent(assignments, allMonitors);

        this._compose(allMonitors, assignments, true, monitorImages);
        this._resetTimer();
    }

    // ── Open actions ───────────────────────────────────────────────────────────

    _openImageInViewer(path) {
        if (path) GLib.spawn_command_line_async('xdg-open "' + path + '"');
    }

    _openCurrentFolder() {
        let monitors = this._monitorManager.getMonitors();
        let fallback = null;
        for (let mon of monitors) {
            let rec = this._stateManager.getMonitorRecord(mon.name);
            if (!rec || !rec.currentImage) continue;
            if (mon.primary) { fallback = rec.currentImage; break; }
            if (!fallback) fallback = rec.currentImage;
        }
        if (!fallback) return;
        let folder = fallback.substring(0, fallback.lastIndexOf('/'));
        GLib.spawn_command_line_async('xdg-open "' + folder + '"');
    }

    // ── Monitor topology changes ───────────────────────────────────────────────

    onMonitorsChanged(newMonitors) {
        if (this._carouselManager) this._carouselManager.reopenAll(newMonitors);
        this._setupImagePools(() => {
            let assignments = this._restoreAssignments(newMonitors);
            if (Object.keys(assignments).length > 0) {
                this._compose(newMonitors, assignments, false, null);
            } else {
                this._changeWallpaper();
            }
        });
    }

    // ── Panel menu ─────────────────────────────────────────────────────────────
    //
    // Every action row carries a symbolic icon. Static rows (Next, Previous,
    // Pause, Swap, Refresh, Open Image Folder) are built once; the monitor
    // section is rebuilt on every open:
    //   one monitor  → its items sit directly in the menu, no submenu, no Swap
    //   Sync mode    → one "All monitors" submenu (2+ monitors share one image)
    //   otherwise    → one submenu per monitor, "· paused" on paused ones

    _buildMenu() {
        let nextItem = this._iconItem(_('Next Wallpaper'), ICONS.next, () => this._navigateNext());
        this.menu.addMenuItem(nextItem);

        this._prevItem = this._iconItem(_('Previous Wallpaper'), ICONS.previous, () => this._navigatePrevious());
        this.menu.addMenuItem(this._prevItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._pauseItem = new PopupMenu.PopupSwitchIconMenuItem(
            _('Pause Rotation'), this._stateManager.isPaused(), ICONS.pause, St.IconType.SYMBOLIC);
        this._pauseItem.connect('toggled', () => this._onPauseToggled(this._pauseItem.state));
        this.menu.addMenuItem(this._pauseItem);

        this._swapItem = this._iconItem(_('Swap Images'), ICONS.swap, () => {
            this.menu.close();
            this._swapImages();
        });
        this.menu.addMenuItem(this._swapItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._monitorSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._monitorSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addMenuItem(this._iconItem(_('Refresh Monitors'), ICONS.refresh, () => {
            this.menu.close();
            this._refreshMonitors();
        }));
        this.menu.addMenuItem(this._iconItem(_('Open Image Folder'), ICONS.folder,
            () => this._openCurrentFolder()));

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._updateMenuState();
        });
    }

    _iconItem(label, icon, onActivate) {
        let item = new PopupMenu.PopupIconMenuItem(label, icon, St.IconType.SYMBOLIC);
        item.connect('activate', onActivate);
        return item;
    }

    // Non-clickable file-name row, cut with "…" so a long name never widens the
    // menu; an empty icon slot keeps it lined up with the labels.
    _fileRow(path) {
        let name = path ? path.split('/').pop() : _('(none)');
        let item = new PopupMenu.PopupIconMenuItem(name, null, St.IconType.SYMBOLIC, { reactive: false });
        item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        item.label.set_style('max-width: 22em;');
        item.label.add_style_class_name('popup-inactive-menu-item');
        return item;
    }

    _updateMenuState() {
        if (!this.menu || !this._monitorManager) return;
        let monitors = this._monitorManager.getMonitors();
        let single   = monitors.length === 1;

        let canGoBack = this._stateManager.getHistoryAt(this._historyPosition + 1) !== null;
        this._prevItem.setSensitive(canGoBack);
        this._pauseItem.setToggleState(this._stateManager.isPaused());

        // Swap needs 2+ monitors with images, in independent mode; hidden with one monitor.
        this._swapItem.actor.visible = !single;
        this._swapItem.setSensitive(!this._syncMode && monitors.filter(m => {
            let rec = this._stateManager.getMonitorRecord(m.name);
            return rec && rec.currentImage;
        }).length >= 2);

        this._monitorSection.removeAll();
        if (monitors.length === 0) {
            this._monitorSection.addMenuItem(
                new PopupMenu.PopupMenuItem(_('(no monitors detected)'), { reactive: false }));
            return;
        }

        if (single) {
            this._addImageItems(this._monitorSection, monitors[0], { carouselLabel: _('Carousel') });
            return;
        }

        if (this._syncMode) {
            let target = monitors.find(m => m.primary) || monitors[0];
            let sub = this._subMenu(_('All monitors'), ICONS.monitor);
            this._addImageItems(sub.menu, target, {
                carouselLabel: _('Carousel (on %s)').replace('%s', target.displayName) });
            this._monitorSection.addMenuItem(sub);
            return;
        }

        for (let mon of monitors) {
            let monName = mon.name;   // the stable identifier; displayName is the EDID name
            let label = mon.displayName +
                (mon.displayName !== monName ? ' (' + monName + ')' : '') +
                (mon.primary ? ' ★' : '');
            if (this._stateManager.isMonitorPaused(monName)) label += ' · ' + _('paused');
            let sub = this._subMenu(label, ICONS.monitor);
            this._addImageItems(sub.menu, mon, { carouselLabel: _('Carousel'), perMonitor: true });
            this._monitorSection.addMenuItem(sub);
        }
    }

    _subMenu(label, icon) {
        let sub = new PopupMenu.PopupSubMenuMenuItem(label);
        sub.addActor(new St.Icon({ style_class: 'popup-menu-icon', icon_name: icon,
                                   icon_type: St.IconType.SYMBOLIC }), { span: 0, position: 0 });
        return sub;
    }

    // The image actions for one monitor. perMonitor adds that monitor's own
    // Next / Previous / Pause (left out when they would repeat the top rows).
    _addImageItems(menu, mon, opts) {
        let monName = mon.name;
        let rec     = this._stateManager.getMonitorRecord(monName);
        let current = rec ? rec.currentImage : null;

        let carousel = new PopupMenu.PopupSwitchIconMenuItem(opts.carouselLabel,
            this._carouselManager.isOpen(monName), ICONS.carousel, St.IconType.SYMBOLIC);
        carousel.connect('toggled', () => {
            this.menu.close();
            if (carousel.state) this._carouselManager.openCarousel(mon);
            else                this._carouselManager.closeCarousel(monName);
        });
        menu.addMenuItem(carousel);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        menu.addMenuItem(this._fileRow(current));

        if (opts.perMonitor) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addMenuItem(this._iconItem(_('Next Image'), ICONS.next, () => {
                this.menu.close();
                this._changeMonitorWallpaper(monName);
            }));
            menu.addMenuItem(this._iconItem(_('Previous Image'), ICONS.previous, () => {
                this.menu.close();
                this._navigateMonitorPrevious(monName);
            }));
            let pause = new PopupMenu.PopupSwitchIconMenuItem(_('Pause Rotation'),
                this._stateManager.isMonitorPaused(monName), ICONS.pause, St.IconType.SYMBOLIC);
            pause.connect('toggled', () => {
                this._stateManager.setMonitorPaused(monName, pause.state);
                this._updateTooltip();
            });
            menu.addMenuItem(pause);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let fav = current && this._isFavorite(current);
        menu.addMenuItem(this._iconItem(fav ? _('Remove from Favorites') : _('Favorite This Image'),
            fav ? ICONS.starred : ICONS.favorite, () => {
                this.menu.close();
                this._toggleFavorite(monName);
            }));
        menu.addMenuItem(this._iconItem(_('Trash This Image'), ICONS.trash, () => {
            this.menu.close();
            this._trashMonitorImage(monName);
        }));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addMenuItem(this._iconItem(_('Open in Image Viewer'), ICONS.viewer, () => {
            this.menu.close();
            let r = this._stateManager.getMonitorRecord(monName);
            this._openImageInViewer(r ? r.currentImage : null);
        }));
    }

    _onPauseToggled(paused) {
        this._stateManager.setPaused(paused);
        if (paused) this._stopTimer();
        else        this._startTimer();
        this._updatePanelIcon();
        this._updateTooltip();
    }

    _updatePanelIcon() {
        this.set_applet_icon_symbolic_name(
            this._stateManager.isPaused() ? ICON_PAUSED : ICON_NORMAL);
    }

    // Rebuilt on every pointer entry, so "next change in …" is current without a timer.
    _updateTooltip() {
        if (!this._stateManager) return;
        let pausedNames = [];
        if (this._monitorManager && !this._syncMode) {
            for (let m of this._monitorManager.getMonitors())
                if (this._stateManager.isMonitorPaused(m.name)) pausedNames.push(m.displayName);
        }
        this.set_applet_tooltip(Utils.tooltipText({
            count:       this._getTotalImageCount(),
            paused:      this._stateManager.isPaused(),
            pausedNames,
            secondsLeft: this._timerId
                ? Utils.secondsUntilNext(this._timerStartedAt, this._timerInterval, GLib.get_monotonic_time())
                : null,
        }));
    }

    // Scroll on the panel icon: up = previous, down = next. Ignored while a
    // composite is being built, so a fast scroll cannot pile up ImageMagick runs.
    _onPanelScroll(event) {
        if (this._compositeInProgress || !this._monitorsReady) return Clutter.EVENT_STOP;
        let dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP)        this._navigatePrevious();
        else if (dir === Clutter.ScrollDirection.DOWN) this._navigateNext();
        return Clutter.EVENT_STOP;
    }

    // ── Applet lifecycle ───────────────────────────────────────────────────────

    on_applet_clicked() {
        this.menu.toggle();
    }

    // Middle-click: pause / resume rotation.
    on_applet_middle_clicked() {
        if (!this._stateManager) return;
        this._onPauseToggled(!this._stateManager.isPaused());
    }

    // Cinnamon calls this when the applet is removed from a panel and, before
    // main() runs again, when it is reloaded. Nothing else tears an applet down:
    // a destroy() method is never invoked. Everything created in the constructor
    // or later — timers, file monitor, monitors-changed signal, chrome actors,
    // settings bindings, the popup menu — is released here, and in-flight async
    // work (ImageMagick, folder scans, thumbnails) is told to drop its results.
    on_applet_removed_from_panel(deleteConfig) {
        this._destroyed = true;
        this._poolGen++;                 // any folder scan still running is superseded
        this._pendingChange = false;

        this._stopTimer();
        if (this._scrollSigId) { this.actor.disconnect(this._scrollSigId); this._scrollSigId = 0; }
        if (this._enterSigId)  { this.actor.disconnect(this._enterSigId);  this._enterSigId  = 0; }
        if (this._monitorConfigTimer) {
            GLib.source_remove(this._monitorConfigTimer);
            this._monitorConfigTimer = null;
        }
        if (this._monitorConfigMonitor) {
            this._monitorConfigMonitor.cancel();
            this._monitorConfigMonitor = null;
        }
        if (this._monitorManager) {      // monitors-changed signal + poll timer
            this._monitorManager.destroy();
            this._monitorManager = null;
        }
        if (this._carouselManager) {     // chrome actors, tweens, scroll signals
            this._carouselManager.destroy();
            this._carouselManager = null;
        }
        if (this._thumbnailCache) {      // queued convert jobs; in-flight results ignored
            this._thumbnailCache.destroy();
            this._thumbnailCache = null;
        }
        if (this._stateManager) {        // flush the debounced state.json write
            this._stateManager.saveSync();
        }
        if (this._settings) {            // unbind keys, unregister from the settings manager
            this._settings.finalize();
            this._settings = null;
        }
        if (this.menu) {                 // the popup actor lives in Main.uiGroup
            this.menu.destroy();
            this.menu = null;
        }
        if (this.menuManager) {
            this.menuManager.destroy();
            this.menuManager = null;
        }
    }
}


function main(metadata, orientation, panelHeight, instanceId) {
    return new WallshiftApplet(metadata, orientation, panelHeight, instanceId);
}
