// MonitorManager.js — Detects monitors via GDK + EDID sysfs.
// GDK provides geometry and connector names; /sys/class/drm/.../edid provides
// friendly names. All operations are plain sysfs reads — no subprocesses, no
// blocking library initialisation.
//
// Each monitor object has:
//   name:        connector name, e.g. "eDP-1", "HDMI-1"
//   displayName: EDID model name, e.g. "Acer CB272U" — falls back to `name`
//   width, height, x, y: geometry in logical pixels
//   primary: true if this is the primary output

const Gdk  = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;

var MonitorManager = class MonitorManager {

    constructor(applet) {
        this._applet      = applet;
        this._monitors    = [];
        this._signalId    = null;
        this._signature   = '';
        this._pollMinutes = 30;
        this._pollEnabled = true;
        this._pollId      = null;
    }

    // pollMinutes: how often to re-query the topology as a fallback for cases
    // where the 'monitors-changed' signal does not fire (e.g. ports swapped
    // between same-resolution outputs, or GDK's monitor view lagging the server).
    // pollEnabled false: rely on the signal (and Refresh Monitors) alone.
    init(onReady, pollMinutes, pollEnabled) {
        if (pollMinutes) this._pollMinutes = pollMinutes;
        if (pollEnabled === false) this._pollEnabled = false;
        this._signalId = Main.layoutManager.connect('monitors-changed',
            () => this._onMonitorsChanged());
        this._query();
        this._signature = this._topologySignature();
        this._startPolling();
        if (onReady) onReady(this._monitors);
    }

    destroy() {
        if (this._signalId) {
            Main.layoutManager.disconnect(this._signalId);
            this._signalId = null;
        }
        this._stopPolling();
    }

    getMonitors() {
        return this._monitors.slice();
    }

    // Change the polling cadence at runtime (bound to the settings spinbutton).
    setPollInterval(minutes, enabled) {
        this._pollMinutes = minutes || 30;
        if (enabled !== undefined) this._pollEnabled = !!enabled;
        this._startPolling();   // restarts (or, when disabled, just stops) the timer
    }

    // Force an immediate re-detection and recompose — used by the manual
    // "Refresh Monitors" actions. Always notifies the applet so the user sees
    // an effect even when the topology turns out to be unchanged.
    refresh() {
        this._query();
        this._signature = this._topologySignature();
        this._applet.onMonitorsChanged(this._monitors);
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    _query() {
        let display  = Gdk.Display.get_default();
        let screen   = Gdk.Screen.get_default();
        let n        = display.get_n_monitors();
        let monitors = [];

        for (let i = 0; i < n; i++) {
            let mon  = display.get_monitor(i);
            let geom = mon.get_geometry();

            // get_connector() was added in GDK 3.22 but may not be bound in all
            // Cinnamon GJS environments — fall back to the older Screen API.
            let connector = null;
            try { connector = mon.get_connector(); } catch(e) {}
            if (!connector) {
                try { connector = screen.get_monitor_plug_name(i); } catch(e) {}
            }
            connector = connector || ('Monitor-' + i);

            monitors.push({
                name:        connector,
                displayName: this._readEdidName(connector) || connector,
                width:       geom.width,
                height:      geom.height,
                x:           geom.x,
                y:           geom.y,
                primary:     mon.is_primary()
            });
        }

        this._monitors = monitors;
    }

    // Read the monitor's friendly name from /sys/class/drm/.../edid.
    // GDK connector names (e.g. "HDMI-1") differ from DRM sysfs names
    // (e.g. "card0-HDMI-A-1") only for HDMI — everything else matches directly.
    _readEdidName(connector) {
        let candidates = [connector];
        let m = connector.match(/^HDMI-(\d+)$/);
        if (m) candidates.push('HDMI-A-' + m[1], 'HDMI-B-' + m[1]);

        for (let card = 0; card < 4; card++) {
            for (let cand of candidates) {
                try {
                    let path = '/sys/class/drm/card' + card + '-' + cand + '/edid';
                    let [ok, data] = GLib.file_get_contents(path);
                    if (!ok || !data || data.length < 128) continue;
                    let name = this._parseEdidMonitorName(data);
                    if (name) return name;
                } catch(e) {}
            }
        }
        return null;
    }

    // Scan the four 18-byte descriptor blocks in the base EDID for a
    // Monitor Name descriptor (tag 0xFC) and return its ASCII string.
    _parseEdidMonitorName(data) {
        for (let block = 0; block < 4; block++) {
            let o = 54 + block * 18;
            if (data[o]   === 0x00 && data[o+1] === 0x00 &&
                data[o+2] === 0x00 && data[o+3] === 0xFC) {
                let name = '';
                for (let j = 5; j < 18; j++) {
                    let c = data[o + j];
                    if (c === 0x0A) break;          // 0x0A = end-of-name marker
                    if (c >= 0x20 && c < 0x7F) name += String.fromCharCode(c);
                }
                return name.trim() || null;
            }
        }
        return null;
    }

    // A stable string describing the current topology: connector, EDID name,
    // geometry and primary flag of every monitor. Recomposing is only worth
    // doing when this changes, which keeps both the signal- and poll-driven
    // paths free of redundant ImageMagick work.
    _topologySignature() {
        return this._monitors.map(m =>
            m.name + ':' + m.displayName + ':' +
            m.x + ',' + m.y + ',' + m.width + 'x' + m.height +
            (m.primary ? ':P' : '')
        ).join('|');
    }

    _startPolling() {
        this._stopPolling();
        if (!this._pollEnabled) return;
        let secs = Math.max(60, (this._pollMinutes || 30) * 60);
        // PRIORITY_DEFAULT_IDLE: this is a background sanity check, never urgent.
        this._pollId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE, secs, () => {
                this._reconcile();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopPolling() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }
    }

    // Re-query and only notify the applet if the topology actually changed.
    // Shared by the 'monitors-changed' signal and the periodic poll.
    _reconcile() {
        this._query();
        let sig = this._topologySignature();
        if (sig === this._signature) return;
        this._signature = sig;
        this._applet.onMonitorsChanged(this._monitors);
    }

    _onMonitorsChanged() {
        this._reconcile();
    }
};
