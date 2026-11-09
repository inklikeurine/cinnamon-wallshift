// Resource bench, headless part (driven by bench.py, not a test suite — run.py
// only picks up *.test.js / *.test.py at the top of the tests dir).
// ARGV: applet dir, harness dir, tests dir, image dir, thumbnail count.
// Prints one JSON line: process launches for a pool setup (two monitors, one
// folder) and for a batch of carousel thumbnails on a cold cache.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const GLib = imports.gi.GLib;
const appletDir = ARGV[0];
imports.searchPath.unshift(ARGV[2] + '/support');
const L = imports.appletLoader;
const { WallshiftApplet, require } = L.load(T, appletDir);
const imgDir = ARGV[3];
const thumbCount = parseInt(ARGV[4] || '24', 10);

const Utils = require('./modules/Utils');
const ThumbnailCache = require('./modules/ThumbnailCache').ThumbnailCache;

// Count every subprocess the modules start, by argv[0] / script.
const launches = {};
const realSpawn = Utils.spawnAsync;
Utils.spawnAsync = function(argv, cb) {
    const key = argv[0] === '/usr/bin/python3' ? 'python3 ' + argv[2] : argv[0];
    launches[key] = (launches[key] || 0) + 1;
    return realSpawn(argv, cb);
};
if (Utils.spawnLines) {            // 0.2.3: streamed launches (batch thumbnails)
    const realLines = Utils.spawnLines;
    Utils.spawnLines = function(argv, onLine, onExit) {
        const key = argv[0] === '/usr/bin/python3' ? 'python3 ' + argv[2] : argv[0];
        launches[key] = (launches[key] || 0) + 1;
        return realLines(argv, onLine, onExit);
    };
}

const loop = new GLib.MainLoop(null, false);
function waitFor(start) {
    let done = false;
    start(() => { done = true; loop.quit(); });
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
    if (!done) loop.run();
    return done;
}
function snapshot() { const s = Object.assign({}, launches); for (const k in launches) delete launches[k]; return s; }

const result = {};

// ── 1. Pool setup: two monitors in independent mode, both on the global folder ──
{
    const a = Object.create(WallshiftApplet.prototype);
    Object.assign(a, {
        _syncMode: false, _imageOrder: 'no-repeat', _globalFolder: imgDir, _poolGen: 0,
        _monitorConfig: { monitors: {} }, _carouselManager: null, _imagePools: new Map(),
        _monitorManager: { getMonitors: () => [{ name: 'HDMI-1' }, { name: 'DP-2' }] },
        _stateManager: { getTrashedPaths: () => [] },
        _updateTooltip() {},
    });
    const t0 = GLib.get_monotonic_time();
    const ok = waitFor(done => a._setupImagePools(done));
    const pools = [...a._imagePools.values()];
    const lists = pools.map(p => p.getImages());
    result.pools = {
        ok, ms: Math.round((GLib.get_monotonic_time() - t0) / 1000),
        launches: snapshot(),
        images: lists.map(l => l.length),
        pathsHeld: lists.reduce((n, l) => n + l.length, 0),
    };
}

// ── 2. Carousel thumbnails on a cold cache ────────────────────────────────────
{
    const stateDir = T.tmpDir('bench-thumbs');
    const tc = new ThumbnailCache(stateDir, appletDir + '/imagetool.py');
    const images = T.listDir(imgDir).filter(n => Utils.isImageFile(n)).slice(0, thumbCount)
        .map(n => imgDir + '/' + n);
    let left = images.length, failed = 0;
    const t0 = GLib.get_monotonic_time();
    const ok = waitFor(done => {
        for (const p of images)
            tc.ensureThumbnail(p, 250, 140, err => { if (err) failed++; if (--left === 0) done(); });
    });
    result.thumbnails = {
        ok, count: images.length, failed, ms: Math.round((GLib.get_monotonic_time() - t0) / 1000),
        launches: snapshot(),
    };
}

print(JSON.stringify(result));
