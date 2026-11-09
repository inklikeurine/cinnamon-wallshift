// MonitorConfig.js — the monitor facts Wallshift shares with configure.py.
//
// configure.py (Python) reads and writes the same things, so the two must agree.
// Both are tested against one set of sample files in the workshop
// (tests/<uuid>/fixtures/edid/ and fixtures/monitor-config/); a change here
// needs the same change in configure.py (_parse_edid_monitor_name,
// _edid_candidates, _parse_monitor_config, _monitor_overrides).
// File format: architecture.md §2.5.
//
// Top-level names must not match a Cinnamon core import (overrides, signals,
// lang, …): Cinnamon's loader silently skips exporting those.

const Utils = require('./modules/Utils');   // relative to the applet dir, as in applet.js

var SCALING_MODES = ['zoom', 'fit', 'stretch', 'center', 'tile'];

// ── EDID (monitor names) ───────────────────────────────────────────────────────

// sysfs names to try for a GDK connector: they match directly except HDMI,
// where GDK says "HDMI-1" and DRM says "card0-HDMI-A-1" (or HDMI-B).
var edidCandidates = function(connector) {
    let candidates = [connector];
    let m = connector.match(/^HDMI-(\d+)$/);
    if (m) candidates.push('HDMI-A-' + m[1], 'HDMI-B-' + m[1]);
    return candidates;
};

// The Monitor Name descriptor (tag 0xFC) from the four 18-byte descriptor
// blocks of a base EDID, as printable ASCII; null when there is none.
var parseEdidName = function(data) {
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
};

// ── monitor-config.json ────────────────────────────────────────────────────────

// File text → config. Anything that is not an object with a "monitors" object
// (missing, empty, corrupt, null, a list…) gives the empty config, never a throw.
var parse = function(text) {
    try {
        let cfg = JSON.parse(text);
        if (cfg && typeof cfg === 'object' && !Array.isArray(cfg) &&
            cfg.monitors && typeof cfg.monitors === 'object' && !Array.isArray(cfg.monitors))
            return cfg;
    } catch(e) { /* fall through */ }
    return { monitors: {} };
};

// One monitor's own settings, before the global-folder fallback:
// { enabled, scaling, folder } — folder is '' when the monitor has none.
var monitorOverrides = function(cfg, monitorName) {
    let o = cfg.monitors[monitorName];
    if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
    return {
        enabled: o.enabled !== false,
        scaling: SCALING_MODES.includes(o.scaling) ? o.scaling : 'zoom',
        folder:  typeof o.folder === 'string' ? Utils.normalizePath(o.folder) : '',
    };
};
