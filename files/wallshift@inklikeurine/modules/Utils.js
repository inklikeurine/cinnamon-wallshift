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

// Async subprocess read line by line: onLine(line) for each line of stdout (stderr
// merged in) as soon as it arrives, then onExit(err, exitCode) once the process has
// exited. argv is string[]. Never throws; a process that cannot start gives
// onExit(err, -1) and no lines.
var spawnLines = function(argv, onLine, onExit) {
    let proc;
    try {
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    } catch(e) {
        onExit(e, -1);
        return;
    }
    let stream = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe(), close_base_stream: true });
    let finish = () => {
        proc.wait_async(null, (p, res) => {
            try { p.wait_finish(res); } catch(e) { /* exit status below */ }
            try { stream.close(null); } catch(e) { /* already closed */ }
            onExit(null, p.get_if_exited() ? p.get_exit_status() : -1);
        });
    };
    let read = () => {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
            let line = null;
            try { [line] = s.read_line_finish_utf8(res); } catch(e) { line = null; }
            if (line === null) { finish(); return; }
            try { onLine(line); } catch(e) { error('spawnLines: ' + e.message); }
            read();
        });
    };
    read();
};

// Fire-and-forget launch (viewer, file manager, settings window). argv is string[],
// passed straight to the program — never through a shell — so a path containing
// quotes, `$` or spaces reaches it intact. GLib reaps the child. Returns false (and
// logs) when the program could not be started.
var launch = function(argv) {
    try {
        GLib.spawn_async(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
        return true;
    } catch(e) {
        warn('Could not start ' + argv[0] + ': ' + e.message);
        return false;
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

// Rotation interval in seconds from the two interval settings. 0 minutes is a
// real value ("use seconds only"), so only a missing setting falls back to the
// 5-minute default. Never below 10 s, to avoid back-to-back compositing runs.
var MIN_INTERVAL_SECONDS = 10;
var intervalSeconds = function(minutes, seconds) {
    let m = Number.isFinite(minutes) ? minutes : 5;
    let s = Number.isFinite(seconds) ? seconds : 0;
    return Math.max(MIN_INTERVAL_SECONDS, m * 60 + s);
};

// ── Translations ───────────────────────────────────────────────────────────────
// Strings go through the applet's own gettext domain (po/ next to applet.js,
// installed to ~/.local/share/locale), falling back to Cinnamon's catalogue.

var UUID = 'wallshift@inklikeurine';
const Gettext = imports.gettext;
Gettext.bindtextdomain(UUID, GLib.get_home_dir() + '/.local/share/locale');

var _ = function(str) {
    let t = Gettext.dgettext(UUID, str);
    if (t !== str) return t;
    return typeof globalThis._ === 'function' ? globalThis._(str) : str;
};

var ngettext = function(singular, plural, n) {
    return Gettext.dngettext(UUID, singular, plural, n);
};

// ── Panel tooltip ──────────────────────────────────────────────────────────────

// "45 s", "3 min", "1 h 5 min" — rounded up to the next minute past 60 s, so
// "next change in 1 min" never shows while 90 s are still left.
var formatDuration = function(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    if (seconds < 60) return ngettext('%d s', '%d s', seconds).replace('%d', seconds);
    let minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return ngettext('%d min', '%d min', minutes).replace('%d', minutes);
    let h = Math.floor(minutes / 60), m = minutes % 60;
    let hours = ngettext('%d h', '%d h', h).replace('%d', h);
    return m ? hours + ' ' + ngettext('%d min', '%d min', m).replace('%d', m) : hours;
};

// Two-line panel tooltip. state: { count, paused, pausedNames[], secondsLeft }
// secondsLeft is null while no timer runs yet (startup, monitors not ready).
var tooltipText = function(state) {
    let count = state.count || 0;
    if (!count) return _('Wallshift \u2014 No images found. Right-click \u2192 Configure.');
    let first = _('Wallshift');
    if (state.paused)
        first += ' \u2014 ' + _('paused');
    else if (state.secondsLeft !== null && state.secondsLeft !== undefined)
        first += ' \u2014 ' + _('next change in %s').replace('%s', formatDuration(state.secondsLeft));
    let second = ngettext('%d image', '%d images', count).replace('%d', count);
    let names = state.paused ? [] : (state.pausedNames || []);
    if (names.length)
        second += ' \u00b7 ' + _('%s paused').replace('%s', names.join(', '));
    return first + '\n' + second;
};

// Seconds until a repeating timer of `interval` s, armed at `startedUs`
// (GLib monotonic µs), fires next.
var secondsUntilNext = function(startedUs, interval, nowUs) {
    if (!startedUs || !interval) return null;
    let elapsed = Math.max(0, (nowUs - startedUs) / 1e6);
    let left = interval - (elapsed % interval);
    return left;
};

// ── Change notification ────────────────────────────────────────────────────────

// Body of the "Wallpaper changed" notification: one line per monitor that got a
// new image, "Display Name: file.jpg". The same image on every monitor (Sync
// mode) is one line.  entries: [{ displayName, path }]
var changeNotificationBody = function(entries) {
    let files = entries.map(e => e.path.split('/').pop());
    if (entries.length > 1 && files.every(f => f === files[0]))
        return _('%s (all monitors)').replace('%s', files[0]);
    return entries.map((e, i) => e.displayName + ': ' + files[i]).join('\n');
};
