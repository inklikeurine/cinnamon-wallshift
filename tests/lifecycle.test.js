// Lifecycle and loader compatibility (fixes D1 and D2, 2026-09-13):
//  - every module loads through a mirror of Cinnamon's require() — strict mode,
//    regex exports, one instance per path — and exports what applet.js expects;
//  - no file loads siblings through the GJS importer (stale across reloads);
//  - applet.js implements on_applet_removed_from_panel(), the hook Cinnamon calls,
//    and has no destroy() / super.destroy() (which Cinnamon never calls / lacks);
//  - ThumbnailCache.destroy() drops queued jobs and silences in-flight ones;
//  - StateManager.saveSync() cancels the debounced write and writes now.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const GLib = imports.gi.GLib;
const require = T.makeRequire(ARGV[0]);
const appletDir = ARGV[0];

T.run('modules export their classes through Cinnamon-style require()', () => {
    const Utils = require('./modules/Utils');
    T.eq(typeof Utils.normalizePath, 'function', 'Utils.normalizePath');
    T.eq(typeof Utils.absoluteDirOr, 'function', 'Utils.absoluteDirOr');
    T.eq(typeof Utils.spawnAsync, 'function', 'Utils.spawnAsync');
    T.eq(typeof require('./modules/ImagePool').ImagePool, 'function', 'ImagePool');
    T.eq(typeof require('./modules/StateManager').StateManager, 'function', 'StateManager');
    T.eq(typeof require('./modules/Compositor').Compositor, 'function', 'Compositor');
    T.eq(typeof require('./modules/ThumbnailCache').ThumbnailCache, 'function', 'ThumbnailCache');
    T.eq(typeof require('./modules/CarouselLayout').layout, 'function', 'CarouselLayout.layout');
    T.eq(typeof require('./modules/ThemeColors').paletteFrom, 'function', 'ThemeColors.paletteFrom');
    T.eq(typeof Utils._, 'function', 'Utils._ (applet gettext domain)');
    T.ok(require('./modules/Utils') === Utils, 'require() returns one instance per path');
});

T.run('no shipped file uses the GJS importer for local modules', () => {
    const files = ['applet.js'].concat(T.listDir(appletDir + '/modules').map(n => 'modules/' + n));
    for (const f of files) {
        const src  = T.readFile(appletDir + '/' + f);
        const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');   // comments out
        T.ok(!/\bimports\.searchPath\b/.test(code), f + ': no imports.searchPath');
        T.ok(!/\bimports\.modules\b/.test(code), f + ': no imports.modules');
        T.ok(src.endsWith('\n'), f + ': ends with a newline (the loader appends code after the source)');
    }
});

T.run('applet.js implements the removal hook Cinnamon calls, not destroy()', () => {
    const src = T.readFile(appletDir + '/applet.js');
    T.ok(/^ {4}on_applet_removed_from_panel\s*\(/m.test(src), 'on_applet_removed_from_panel() present');
    T.ok(!/^ {4}destroy\s*\(\s*\)\s*\{/m.test(src), 'no destroy() on the applet class');
    T.ok(!/super\.destroy\(\)/.test(src), 'no super.destroy() (Applet.IconApplet has none)');
    for (const call of ['_settings.finalize()', '_monitorManager.destroy()', '_carouselManager.destroy()',
                        '_thumbnailCache.destroy()', '_stateManager.saveSync()', 'menu.destroy()', '_monitorConfigMonitor.cancel()'])
        T.ok(src.includes(call), 'removal calls ' + call);
});

T.runAsync('ThumbnailCache.destroy() drops queued jobs and ignores in-flight results', done => {
    const ThumbnailCache = require('./modules/ThumbnailCache').ThumbnailCache;
    const dir = T.tmpDir('thumbs');
    const tc  = new ThumbnailCache(dir, ARGV[0] + '/imagetool.py');
    let called = 0;
    for (let i = 0; i < 6; i++) {          // MAX_CONCURRENT is 4: four run, two queue
        const p = dir + '/img' + i + '.jpg';
        T.writeFile(p, 'not an image');    // imagetool.py will fail — asynchronously
        tc.ensureThumbnail(p, 250, 140, () => called++);
    }
    T.eq(tc._activeJobs, 4, 'four jobs in flight');
    T.eq(tc._queue.length, 2, 'two jobs queued');
    tc.destroy();
    T.eq(tc._queue.length, 0, 'queue dropped');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        T.eq(called, 0, 'no callback fired after destroy()');
        done();
        return GLib.SOURCE_REMOVE;
    });
}, 10);

T.run('StateManager.saveSync() cancels the debounced write and writes immediately', () => {
    const StateManager = require('./modules/StateManager').StateManager;
    const dir = T.tmpDir('state');
    const sm  = new StateManager(dir);
    sm.load();
    sm.setPaused(true);
    sm.save();
    T.ok(sm._writeTimerId !== null, 'debounce timer armed by save()');
    sm.saveSync();
    T.eq(sm._writeTimerId, null, 'timer cancelled by saveSync()');
    T.ok(T.readFile(dir + '/state.json').includes('"paused": true'), 'state.json written synchronously');
});

T.exit();
