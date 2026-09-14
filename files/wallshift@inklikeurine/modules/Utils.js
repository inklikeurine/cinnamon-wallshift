// Utils.js — Shared utilities for the Wallshift applet.
// All exported symbols use `var` so they are accessible via the CJS module namespace.

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

var IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif'];

var log = function(msg) {
    global.log('[wallshift] ' + msg);
};

var warn = function(msg) {
    global.logWarning('[wallshift] WARN: ' + msg);
};

var error = function(msg) {
    global.logError('[wallshift] ERROR: ' + msg);
};

// Convert a GLib bytes result (Uint8Array or string) to a plain JS string.
var bytesToString = function(bytes) {
    if (!bytes) return '';
    if (typeof bytes === 'string') return bytes;
    try {
        return new TextDecoder().decode(bytes);
    } catch(e) {
        try {
            return imports.byteArray.toString(bytes);
        } catch(e2) {
            return '' + bytes;
        }
    }
};

// Async subprocess. argv is string[]. callback(err, stdout, stderr, exitCode).
var spawnAsync = function(argv, callback) {
    try {
        let proc = new Gio.Subprocess({
            argv: argv,
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        });
        proc.init(null);
        proc.communicate_utf8_async(null, null, function(proc, res) {
            try {
                let [ok, stdout, stderr] = proc.communicate_utf8_finish(res);
                callback(null, stdout || '', stderr || '', proc.get_exit_status());
            } catch(e) {
                callback(e, null, null, -1);
            }
        });
    } catch(e) {
        callback(e, null, null, -1);
    }
};

// Check if a path is a regular file.
var fileExists = function(path) {
    return GLib.file_test(path, GLib.FileTest.IS_REGULAR);
};

// Check if a path is a directory.
var dirExists = function(path) {
    return GLib.file_test(path, GLib.FileTest.IS_DIR);
};

// Get lowercase file extension including the dot, e.g. '.jpg'.
var getExtension = function(path) {
    let dot = path.lastIndexOf('.');
    return dot >= 0 ? path.substring(dot).toLowerCase() : '';
};

// Return true if the path is a supported image file (not hidden).
var isImageFile = function(path) {
    let basename = path.split('/').pop();
    if (basename.startsWith('.')) return false;
    return IMAGE_EXTENSIONS.includes(getExtension(path));
};

// Create a directory and all parents. Silently ignores if already exists.
var ensureDir = function(dirPath) {
    let dir = Gio.File.new_for_path(dirPath);
    try {
        dir.make_directory_with_parents(null);
    } catch(e) {
        // Already exists — fine.
    }
};

// Fisher-Yates shuffle in place. Returns the array.
var shuffle = function(array) {
    for (let i = array.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

// Normalize a folder value from AppletSettings / monitor-config.json to a plain path.
// Cinnamon's native filechooser widget stores a percent-encoded file:// URI
// (e.g. file:///home/me/Wallpaper%20Favorites); configure.py stores plain paths;
// a hand-edited file may contain ~. All three must resolve to the same directory —
// a URI that slips through unconverted would be created literally as "./file:/…".
var normalizePath = function(p) {
    if (!p || !p.length) return '';
    p = p.trim();
    if (p.startsWith('file:')) {
        try {
            let [path] = GLib.filename_from_uri(p);
            if (path) return path;
        } catch(e) { /* fall through to manual decode */ }
        let stripped = p.replace(/^file:\/\/(localhost)?/, '');
        try { return decodeURIComponent(stripped); } catch(e) { return stripped; }
    }
    if (p === '~' || p.startsWith('~/')) return GLib.get_home_dir() + p.slice(1);
    return p;
};

// Absolute-path guard for directories we are about to create or write into.
// Returns `fallback` (with a warning) for anything relative, so a bad setting can
// never create directories under Cinnamon's working directory.
var absoluteDirOr = function(path, fallback, what) {
    if (path && path.startsWith('/')) return path;
    if (path) warn(what + ' is not an absolute path ("' + path + '") — using ' + fallback);
    return fallback;
};
