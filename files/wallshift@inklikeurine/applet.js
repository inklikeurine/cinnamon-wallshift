// applet.js — Wallshift: local wallpaper rotation for Cinnamon.
//
// All user-facing settings live in AppletSettings (right-click → Configure).
// StateManager/state.json holds only runtime state: pause flags, current images,
// history, and the trashed-paths exclusion list.

const Applet    = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings  = imports.ui.settings;
const Main      = imports.ui.main;
const GLib      = imports.gi.GLib;
const Gio       = imports.gi.Gio;

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

const ICON_NORMAL = 'preferences-desktop-wallpaper-symbolic';
const ICON_PAUSED = 'media-playback-pause-symbolic';

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

        // ── Panel menu ─────────────────────────────────────────────────────────
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu        = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._buildMenu();

        // ── Monitor detection (async) ──────────────────────────────────────────
        this._monitorManager = new MonitorManager(this);
        this._monitorManager.init(monitors => this._onMonitorsReady(monitors),
            this._detectionInterval);

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
        this._settings.bind('favorites-folder',   '_favoritesFolder',   null);
        this._settings.bind('sync-mode',     '_syncMode',     rebuildAndChange);
        this._settings.bind('global-folder', '_globalFolder', rebuildAndChange);
        this._settings.bind('detection-interval-minutes', '_detectionInterval', () => {
            if (this._monitorManager)
                this._monitorManager.setPollInterval(this._detectionInterval);
        });

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
                        let names = [...new Set(
                            Object.values(monitorImages).map(p => p.split('/').pop())
                        )];
                        Main.notify(_('Wallshift'), names.join(' | '));
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

    _favoriteMonitorImage(monitorName) {
        let rec = this._stateManager.getMonitorRecord(monitorName);
        if (!rec || !rec.currentImage) {
            Utils.warn('Favorite: no current image for ' + monitorName);
            return;
        }
        if (this._copyToFavorites(rec.currentImage)) {
            Main.notify(_('Wallshift'),
                _('Saved to Favorites: ') + rec.currentImage.split('/').pop());
        }
    }

    _trashMonitorImage(monitorName) {
        let rec = this._stateManager.getMonitorRecord(monitorName);
        if (!rec || !rec.currentImage) return;
        this._trashPath(rec.currentImage);
        // Advance just this monitor to the next image.
        this._changeMonitorWallpaper(monitorName);
    }

    // ── Shared helpers ─────────────────────────────────────────────────────────

    _copyToFavorites(src) {
        let favDir = absoluteDirOr(
            normalizePath(this._favoritesFolder || ''),
            GLib.get_home_dir() + '/Pictures/Wallpaper Favorites',
            'Favorites folder');
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

    _buildMenu() {
        let nextItem = new PopupMenu.PopupMenuItem(_('Next Wallpaper'));
        nextItem.connect('activate', () => this._navigateNext());
        this.menu.addMenuItem(nextItem);

        this._prevItem = new PopupMenu.PopupMenuItem(_('Previous Wallpaper'));
        this._prevItem.connect('activate', () => this._navigatePrevious());
        this.menu.addMenuItem(this._prevItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._pauseItem = new PopupMenu.PopupSwitchMenuItem(
            _('Pause All Rotation'), this._stateManager.isPaused());
        this._pauseItem.connect('toggled', () =>
            this._onPauseToggled(this._pauseItem.state));
        this.menu.addMenuItem(this._pauseItem);

        this._swapItem = new PopupMenu.PopupMenuItem(_('Swap Images'));
        this._swapItem.connect('activate', () => {
            this.menu.close();
            this._swapImages();
        });
        this.menu.addMenuItem(this._swapItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Per-monitor submenus — rebuilt on every open from live xrandr data.
        this._monitorSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._monitorSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let refreshItem = new PopupMenu.PopupMenuItem(_('Refresh Monitors'));
        refreshItem.connect('activate', () => {
            this.menu.close();
            this._refreshMonitors();
        });
        this.menu.addMenuItem(refreshItem);

        let openFolderItem = new PopupMenu.PopupMenuItem(_('Open Wallpaper Folder'));
        openFolderItem.connect('activate', () => this._openCurrentFolder());
        this.menu.addMenuItem(openFolderItem);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._updateMenuState();
        });
    }

    _updateMenuState() {
        let canGoBack =
            this._stateManager.getHistoryAt(this._historyPosition + 1) !== null;
        this._prevItem.setSensitive(canGoBack);
        this._pauseItem.setToggleState(this._stateManager.isPaused());

        // Swap is only meaningful in independent mode with 2+ monitors that have images.
        let swappable = !this._syncMode &&
            this._monitorManager.getMonitors().filter(m => {
                let rec = this._stateManager.getMonitorRecord(m.name);
                return rec && rec.currentImage;
            }).length >= 2;
        this._swapItem.setSensitive(swappable);

        // Rebuild per-monitor submenus with live monitor list from xrandr.
        this._monitorSection.removeAll();

        let monitors = this._monitorManager.getMonitors();
        if (monitors.length === 0) {
            this._monitorSection.addMenuItem(
                new PopupMenu.PopupMenuItem(_('(no monitors detected)'),
                    {reactive: false}));
            return;
        }

        for (let mon of monitors) {
            let monName  = mon.name;   // capture for closures
            let rec      = this._stateManager.getMonitorRecord(monName);
            let imgName  = (rec && rec.currentImage)
                ? rec.currentImage.split('/').pop()
                : _('(none)');
            let isPaused = this._stateManager.isMonitorPaused(monName);

            // Use EDID display name ("Acer CB272U") with connector name in parens.
            // mon.name is still used for all logic — it's the stable identifier.
            let label = mon.displayName +
                (mon.displayName !== monName ? ' (' + monName + ')' : '') +
                (mon.primary ? ' \u2605' : '');
            let sub   = new PopupMenu.PopupSubMenuMenuItem(label);

            // ── Carousel toggle ───────────────────────────────────────────────
            let carouselLabel = this._carouselManager.isOpen(monName)
                ? _('Hide Carousel') : _('Show Carousel');
            let carouselItem = new PopupMenu.PopupMenuItem(carouselLabel);
            carouselItem.connect('activate', () => {
                this.menu.close();
                if (this._carouselManager.isOpen(monName)) {
                    this._carouselManager.closeCarousel(monName);
                } else {
                    this._carouselManager.openCarousel(mon);
                }
            });
            sub.menu.addMenuItem(carouselItem);
            sub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Current image (non-interactive info label)
            let infoItem = new PopupMenu.PopupMenuItem(imgName, {reactive: false});
            sub.menu.addMenuItem(infoItem);

            sub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            if (!this._syncMode) {
                // ── Navigation ────────────────────────────────────────────────
                let nextItem = new PopupMenu.PopupMenuItem(_('Next Image'));
                nextItem.connect('activate', () => {
                    this.menu.close();
                    this._changeMonitorWallpaper(monName);
                });
                sub.menu.addMenuItem(nextItem);

                let prevItem = new PopupMenu.PopupMenuItem(_('Previous Image'));
                prevItem.connect('activate', () => {
                    this.menu.close();
                    this._navigateMonitorPrevious(monName);
                });
                sub.menu.addMenuItem(prevItem);

                sub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                // ── Per-monitor pause ─────────────────────────────────────────
                let pauseItem = new PopupMenu.PopupSwitchMenuItem(
                    _('Pause Rotation'), isPaused);
                pauseItem.connect('toggled', () => {
                    this._stateManager.setMonitorPaused(monName, pauseItem.state);
                });
                sub.menu.addMenuItem(pauseItem);
            } else {
                let syncNote = new PopupMenu.PopupMenuItem(
                    _('(synced \u2014 all monitors share one image)'),
                    {reactive: false});
                sub.menu.addMenuItem(syncNote);
            }

            sub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // ── Favorite ──────────────────────────────────────────────────────
            let favItem = new PopupMenu.PopupMenuItem(_('Favorite This Image'));
            favItem.connect('activate', () => {
                this.menu.close();
                this._favoriteMonitorImage(monName);
            });
            sub.menu.addMenuItem(favItem);

            // ── Trash ─────────────────────────────────────────────────────────
            let trashItem = new PopupMenu.PopupMenuItem(_('Trash This Image'));
            trashItem.connect('activate', () => {
                this.menu.close();
                this._trashMonitorImage(monName);
            });
            sub.menu.addMenuItem(trashItem);

            sub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // ── Open in viewer ────────────────────────────────────────────────
            let openItem = new PopupMenu.PopupMenuItem(_('Open in Image Viewer'));
            openItem.connect('activate', () => {
                this.menu.close();
                let r = this._stateManager.getMonitorRecord(monName);
                this._openImageInViewer(r ? r.currentImage : null);
            });
            sub.menu.addMenuItem(openItem);

            this._monitorSection.addMenuItem(sub);
        }
    }

    _onPauseToggled(paused) {
        this._stateManager.setPaused(paused);
        if (paused) this._stopTimer();
        else        this._startTimer();
        this._updatePanelIcon();
    }

    _updatePanelIcon() {
        this.set_applet_icon_symbolic_name(
            this._stateManager.isPaused() ? ICON_PAUSED : ICON_NORMAL);
    }

    _updateTooltip() {
        this.set_applet_tooltip(Utils.tooltipText(this._getTotalImageCount()));
    }

    // ── Applet lifecycle ───────────────────────────────────────────────────────

    on_applet_clicked() {
        this.menu.toggle();
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
