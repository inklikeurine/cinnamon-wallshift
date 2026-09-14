// StateManager.js — Runtime persistence only.
//
// All user settings (interval, order, folders, scaling, etc.) now live in
// AppletSettings / settings-schema.json. StateManager holds only what needs
// to survive a Cinnamon restart but is NOT user-configurable via the settings
// panel: global pause, per-monitor pause, per-monitor current image, history,
// trashed paths.

const GLib = imports.gi.GLib;

const Utils = require('./modules/Utils');   // relative to the applet dir, as in applet.js

var StateManager = class StateManager {

    constructor(stateDir) {
        this._stateDir     = stateDir;
        this._statePath    = stateDir + '/state.json';
        this._state        = null;
        this._writePending = false;
        this._writeTimerId = null;
    }

    // ── Load / Save ────────────────────────────────────────────────────────────

    load() {
        Utils.ensureDir(this._stateDir);

        try {
            let [ok, contents] = GLib.file_get_contents(this._statePath);
            if (ok) {
                this._state = JSON.parse(Utils.bytesToString(contents));
                this._migrate();
                return;
            }
        } catch(e) {
            Utils.warn('Could not load state.json: ' + e.message);
        }

        this._state = this._defaultState();
    }

    // Debounced async write — coalesces rapid bursts into one write per 500 ms.
    save() {
        if (this._writePending) return;
        this._writePending = true;
        this._writeTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._writePending = false;
            this._writeTimerId = null;
            this._writeSync();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Synchronous write — call in destroy() only.
    saveSync() {
        if (this._writeTimerId) {
            GLib.source_remove(this._writeTimerId);
            this._writeTimerId = null;
            this._writePending = false;
        }
        this._writeSync();
    }

    _writeSync() {
        try {
            GLib.file_set_contents(this._statePath,
                JSON.stringify(this._state, null, 2));
        } catch(e) {
            Utils.error('Failed to write state.json: ' + e.message);
        }
    }

    // ── Global pause ───────────────────────────────────────────────────────────

    isPaused()   { return this._state.paused; }
    setPaused(v) { this._state.paused = v; this.save(); }

    // ── Per-monitor pause ──────────────────────────────────────────────────────

    isMonitorPaused(name) {
        return this._state.pausedMonitors.includes(name);
    }

    setMonitorPaused(name, paused) {
        let idx = this._state.pausedMonitors.indexOf(name);
        if (paused && idx === -1) {
            this._state.pausedMonitors.push(name);
            this.save();
        } else if (!paused && idx !== -1) {
            this._state.pausedMonitors.splice(idx, 1);
            this.save();
        }
    }

    // ── Trashed paths ──────────────────────────────────────────────────────────

    getTrashedPaths() { return this._state.trashedPaths.slice(); }

    addTrashedPath(path) {
        if (!this._state.trashedPaths.includes(path)) {
            this._state.trashedPaths.push(path);
            this.save();
        }
    }

    // ── Per-monitor current image ──────────────────────────────────────────────

    // Returns { currentImage } for the named monitor, or null if never set.
    getMonitorRecord(name) {
        return this._state.monitors[name] || null;
    }

    // Records the current image path for a monitor (creates the record if needed).
    // Caller must call save() once after updating all monitors.
    setMonitorCurrentImage(name, path) {
        if (!this._state.monitors[name]) {
            this._state.monitors[name] = { currentImage: null };
        }
        this._state.monitors[name].currentImage = path;
    }

    // ── History ────────────────────────────────────────────────────────────────

    getHistoryLength() { return this._state.history.length; }

    // Push a new history snapshot. monitorImages: { 'eDP-1': '/path/img.jpg', ... }
    pushHistory(monitorImages) {
        this._state.history.push({
            timestamp: Date.now(),
            monitors:  Object.assign({}, monitorImages)
        });
        if (this._state.history.length > 100) this._state.history.shift();
        this.save();
    }

    // Returns the history entry `stepsBack` positions from the tip.
    // 0 = most recent (current), 1 = previous, etc. Returns null if out of range.
    getHistoryAt(stepsBack) {
        let idx = this._state.history.length - 1 - stepsBack;
        return idx >= 0 ? this._state.history[idx] : null;
    }

    // ── Internals ──────────────────────────────────────────────────────────────

    _defaultState() {
        return {
            version:        1,
            paused:         false,
            pausedMonitors: [],
            monitors:       {},
            history:        [],
            trashedPaths:   []
        };
    }

    _migrate() {
        let d = this._defaultState();
        for (let key of Object.keys(d)) {
            if (!(key in this._state)) this._state[key] = d[key];
        }
        // Drop old keys that are now owned by AppletSettings
        let obsolete = ['syncMode', 'intervalMinutes', 'intervalSeconds',
                        'imageOrder', 'showNotifications', 'favoritesFolder',
                        'globalFolders', 'lastWallpaperTime', 'previousPictureOptions'];
        for (let key of obsolete) delete this._state[key];
        this._state.version = 1;
    }
};
