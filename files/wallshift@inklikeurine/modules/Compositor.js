// Compositor.js — Builds the multi-monitor composite wallpaper via ImageMagick.
//
// For a single monitor, returns the source path directly (no ImageMagick).
// For multiple monitors, assembles a canvas the size of the full virtual desktop,
// places each monitor's image into its region at +x+y, and writes a JPEG that
// gsettings picture-options:'spanned' maps 1:1 to each physical display.

const GLib = imports.gi.GLib;
const Gio  = imports.gi.Gio;

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

    constructor(cacheDir) {
        this._cacheDir    = cacheDir;
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

        // ── Single monitor: skip ImageMagick entirely ─────────────────────────
        if (active.length === 1) {
            let mon = active[0];
            let asgn = assignments[mon.name];
            let pictureOptions = SCALING_TO_PICTURE_OPTIONS[asgn.scaling] || 'zoom';
            callback(null, asgn.path, pictureOptions);
            return;
        }

        // ── Multi-monitor: build ImageMagick composite ────────────────────────
        // Alternate between two output filenames so picture-uri changes on every
        // write — Cinnamon only redraws the background when the URI value changes.
        this._slot = 1 - this._slot;
        let outputPath = this._outputPaths[this._slot];

        let canvas = this._totalCanvasSize(monitors);
        let tmpPath = this._cacheDir + '/compositing_' + Date.now() + '.jpg';
        let argv = this._buildConvertCommand(active, assignments, canvas, tmpPath);

        Utils.spawnAsync(argv, (err, stdout, stderr, exitCode) => {
            if (err || exitCode !== 0) {
                Utils.error('ImageMagick failed (exit ' + exitCode + '): ' + stderr);
                // Clean up temp file if it exists
                try {
                    Gio.File.new_for_path(tmpPath).delete(null);
                } catch(e2) { /* ignore */ }
                callback(err || new Error('convert exited ' + exitCode), null, null);
                return;
            }

            // Atomically replace the output file
            try {
                let tmpFile = Gio.File.new_for_path(tmpPath);
                let outFile = Gio.File.new_for_path(outputPath);
                tmpFile.move(outFile, Gio.FileCopyFlags.OVERWRITE, null, null);
            } catch(e) {
                Utils.error('Failed to move composite output: ' + e.message);
                callback(e, null, null);
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

    // Builds the `convert` argv for ImageMagick 6.x / 7.x (both use same CLI here).
    //
    // Strategy: start with a black canvas, then for each monitor, open the image
    // in a parenthesised group, scale it, then composite it at the monitor's offset.
    _buildConvertCommand(activeMonitors, assignments, canvas, outputPath) {
        let argv = [
            'convert',
            '-size', canvas.width + 'x' + canvas.height,
            'xc:black'
        ];

        for (let mon of activeMonitors) {
            let asgn = assignments[mon.name];
            // Scale the image in an isolated group
            argv.push('(');
            argv.push(...this._scalingArgs(asgn.path, mon.width, mon.height, asgn.scaling));
            argv.push(')');
            // ImageMagick 6: -gravity set inside () persists after the closing ).
            // Reset to NorthWest so +X+Y is measured from the canvas top-left,
            // not from the canvas centre (which would shift every monitor right).
            argv.push('-gravity', 'NorthWest');
            argv.push('-geometry', '+' + mon.x + '+' + mon.y);
            argv.push('-composite');
        }

        // JPEG output: ~10× faster to write than PNG for large canvases, and
        // Cinnamon decodes it faster too. Quality 95 is visually lossless for wallpaper.
        argv.push('-quality', '95');
        argv.push('-strip');    // drop metadata — smaller file, faster write
        argv.push(outputPath);
        return argv;
    }

    // Returns the ImageMagick sub-command arguments to scale `imagePath` to WxH
    // using the named scaling mode. The output is suitable for insertion between
    // `(` and `)` in a convert command.
    _scalingArgs(imagePath, w, h, scalingMode) {
        let size = w + 'x' + h;

        switch (scalingMode) {
            case 'zoom':
                // Fill and crop — scale to fill WxH, centre, then crop to exact size.
                // -thumbnail: fast sampling pre-pass before filtering (much faster than
                // -resize for large sources; same quality for wallpaper use).
                return [imagePath,
                    '-thumbnail', size + '^',
                    '-gravity', 'Center',
                    '-extent', size];

            case 'fit':
                // Letterbox/pillarbox — scale to fit within WxH, pad with black
                return [imagePath,
                    '-thumbnail', size,
                    '-background', 'black',
                    '-gravity', 'Center',
                    '-extent', size];

            case 'stretch':
                // Ignore aspect ratio — scale to exactly WxH
                return [imagePath,
                    '-thumbnail', size + '!'];

            case 'center':
                // No scaling — centre on black canvas; crop if image is larger
                return [imagePath,
                    '-gravity', 'Center',
                    '-background', 'black',
                    '-extent', size];

            case 'tile':
                // Tile the image to fill the area
                return [
                    '(', imagePath, ')',
                    '-write', 'mpr:tile', '+delete',
                    '-size', size,
                    'tile:mpr:tile'
                ];

            default:
                Utils.warn('Unknown scaling mode "' + scalingMode + '", falling back to zoom');
                return this._scalingArgs(imagePath, w, h, 'zoom');
        }
    }
};
