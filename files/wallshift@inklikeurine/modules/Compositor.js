// Compositor.js — Builds the multi-monitor composite wallpaper via imagetool.py.
//
// With one monitor connected, returns the source path directly (no compositing).
// With several, assembles a canvas the size of the full virtual desktop, places
// each monitor's image into its region at +x+y, and writes a JPEG that
// gsettings picture-options:'spanned' maps 1:1 to each physical display.

const Utils = require('./modules/Utils');   // relative to the applet dir, as in applet.js

// Maps our internal scaling mode names to Cinnamon gsettings picture-options values.
// Used for single-monitor mode only (multi-monitor always uses 'spanned').
const SCALING_TO_PICTURE_OPTIONS = {
    'zoom':    'zoom',
    'fit':     'scaled',
    'stretch': 'stretched',
    'center':  'centered',
    'tile':    'wallpaper'
};

var Compositor = class Compositor {

    // toolPath: absolute path of imagetool.py in the applet folder.
    constructor(cacheDir, toolPath) {
        this._cacheDir    = cacheDir;
        this._toolPath    = toolPath;
        this._slot        = 0;
        this._outputPaths = [
            cacheDir + '/current_wallpaper_0.jpg',
            cacheDir + '/current_wallpaper_1.jpg'
        ];
        Utils.ensureDir(cacheDir);
    }

    // Build the composite wallpaper for the given monitors and image assignments.
    //
    // monitors:    Monitor[] — all active monitors with geometry
    // assignments: { 'eDP-1': { path: '/img.jpg', scaling: 'zoom' }, ... }
    // callback:    function(err, outputPath, pictureOptions)
    //
    // Never blocks — always async for multi-monitor.
    compose(monitors, assignments, callback) {
        // Filter to monitors that actually have an assignment
        let active = monitors.filter(m => assignments[m.name] && assignments[m.name].path);

        if (active.length === 0) {
            callback(new Error('No valid assignments'), null, null);
            return;
        }

        // ── Single monitor: hand Cinnamon the image itself ────────────────────
        // Only when exactly one monitor is connected: Cinnamon draws a non-spanned
        // wallpaper on every monitor, so with two connected and one image this
        // would put that image on both.
        if (monitors.length === 1) {
            let asgn = assignments[active[0].name];
            let pictureOptions = SCALING_TO_PICTURE_OPTIONS[asgn.scaling] || 'zoom';
            callback(null, asgn.path, pictureOptions);
            return;
        }

        // ── Multi-monitor: build the composite ────────────────────────────────
        // Monitors without an image stay black.
        // Alternate between two output filenames so picture-uri changes on every
        // write — Cinnamon only redraws the background when the URI value changes.
        this._slot = 1 - this._slot;
        let outputPath = this._outputPaths[this._slot];

        let canvas = this._totalCanvasSize(monitors);
        let job = {
            width:    canvas.width,
            height:   canvas.height,
            output:   outputPath,
            monitors: active.map(mon => ({
                path:    assignments[mon.name].path,
                x:       mon.x,
                y:       mon.y,
                width:   mon.width,
                height:  mon.height,
                scaling: this._scaling(assignments[mon.name].scaling)
            }))
        };

        Utils.spawnAsync(['/usr/bin/python3', this._toolPath, 'compose', JSON.stringify(job)],
            (err, stdout, stderr, exitCode) => {
                if (err || exitCode !== 0) {
                    Utils.error('Compositing failed (exit ' + exitCode + '): ' +
                        ((stderr || '').trim() || (err && err.message)));
                    callback(err || new Error('imagetool exited ' + exitCode), null, null);
                    return;
                }
                callback(null, outputPath, 'spanned');
            });
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    _totalCanvasSize(monitors) {
        let maxX = 0, maxY = 0;
        for (let m of monitors) {
            if (m.x + m.width  > maxX) maxX = m.x + m.width;
            if (m.y + m.height > maxY) maxY = m.y + m.height;
        }
        return {width: maxX, height: maxY};
    }

    _scaling(mode) {
        if (SCALING_TO_PICTURE_OPTIONS[mode]) return mode;
        Utils.warn('Unknown scaling mode "' + mode + '", falling back to zoom');
        return 'zoom';
    }
};
