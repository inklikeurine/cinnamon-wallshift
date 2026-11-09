// ThumbnailCache.js + `imagetool.py thumbs` (0.2.3): many thumbnails per Python
// process, results streamed one line each, failures isolated per image, cache
// names unchanged, duplicates joined, a worker that cannot start reported.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const GLib = imports.gi.GLib;
const GdkPixbuf = imports.gi.GdkPixbuf;
const require = T.makeRequire(ARGV[0]);
const Utils = require('./modules/Utils');
const ThumbnailCache = require('./modules/ThumbnailCache').ThumbnailCache;
const tool = ARGV[0] + '/imagetool.py';

// Count worker launches.
let launches = 0;
const realLines = Utils.spawnLines;
Utils.spawnLines = function(argv, onLine, onExit) {
    if (argv[2] === 'thumbs') launches++;
    return realLines(argv, onLine, onExit);
};

function image(dir, name, w, h) {
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, w, h);
    pb.fill(0x2266aaff);
    pb.savev(dir + '/' + name, 'jpeg', ['quality'], ['90']);
    return dir + '/' + name;
}

T.runAsync('a screenful of thumbnails: two workers, every callback, bad files isolated', done => {
    const dir = T.tmpDir('thumbs-batch');
    const tc = new ThumbnailCache(dir, tool);
    const imgs = [];
    for (let i = 0; i < 10; i++) imgs.push(image(dir, 'p' + i + '.jpg', 640, 360));
    T.writeFile(dir + '/bad.jpg', 'not an image');
    imgs.splice(4, 0, dir + '/bad.jpg');
    launches = 0;
    const results = new Map();
    let left = imgs.length + 1;
    const finish = () => {
        T.ok(launches <= 2, 'at most two python3 processes for ' + imgs.length + ' thumbnails (was one each)');
        for (const p of imgs) {
            const r = results.get(p);
            if (p.endsWith('bad.jpg')) { T.ok(r.err && !r.path, 'bad image → error'); continue; }
            T.ok(!r.err && r.path === tc.getThumbnailPath(p, 250, 140), 'ok: ' + p.split('/').pop());
            const [, w, h] = GdkPixbuf.Pixbuf.get_file_info(r.path);
            T.eq([w, h], [250, 140], 'size');
        }
        T.eq(results.get('dup'), 'joined', 'duplicate request joined the same job');
        T.ok(!GLib.file_test(tc.getThumbnailPath(dir + '/bad.jpg', 250, 140) + '.part', GLib.FileTest.EXISTS), 'no .part left');
        done();
    };
    for (const p of imgs)
        tc.ensureThumbnail(p, 250, 140, (err, path) => { results.set(p, { err, path }); if (--left === 0) finish(); });
    tc.ensureThumbnail(imgs[0], 250, 140, (err, path) => { results.set('dup', !err && path ? 'joined' : 'failed'); if (--left === 0) finish(); });
    T.eq(tc._queue.length, imgs.length, 'duplicate did not add a job');
}, 30);

T.runAsync('cached thumbnail: answered at once, no process; cache names unchanged', done => {
    const dir = T.tmpDir('thumbs-cached');
    const tc = new ThumbnailCache(dir, tool);
    const p = image(dir, 'c.jpg', 320, 200);
    T.ok(/_l250\.jpg$/.test(tc.getThumbnailPath(p, 250, 140)) && /_p250\.jpg$/.test(tc.getThumbnailPath(p, 140, 250)) &&
         /_180x100\.jpg$/.test(tc.getThumbnailPath(p, 180, 100)), 'pre-0.2.3 cache suffixes kept');
    tc.ensureThumbnail(p, 250, 140, (err) => {
        T.ok(!err, 'made');
        launches = 0;
        let sync = true;
        tc.ensureThumbnail(p, 250, 140, (err2, path) => {
            T.ok(sync && !err2 && path, 'second request answered synchronously from the cache');
            T.eq(launches, 0, 'no process for a cached thumbnail');
            done();
        });
        sync = false;
    });
}, 15);

T.runAsync('requests arriving while workers are busy run after them', done => {
    const dir = T.tmpDir('thumbs-late');
    const tc = new ThumbnailCache(dir, tool);
    const a = image(dir, 'a.jpg', 320, 200), b = image(dir, 'b.jpg', 320, 200), c = image(dir, 'c.jpg', 320, 200);
    let got = [];
    tc.ensureThumbnail(a, 250, 140, () => got.push('a'));
    tc.ensureThumbnail(b, 250, 140, () => got.push('b'));
    GLib.idle_add(GLib.PRIORITY_LOW, () => {
        T.eq(tc._workers, 2, 'both workers busy');
        tc.ensureThumbnail(c, 250, 140, () => {
            got.push('c');
            T.eq(got.sort(), ['a', 'b', 'c'], 'all three made');
            done();
        });
        return GLib.SOURCE_REMOVE;
    });
}, 15);

T.runAsync('a worker that cannot run reports every job as failed, with the reason', done => {
    const dir = T.tmpDir('thumbs-broken');
    const tc = new ThumbnailCache(dir, dir + '/no-such-imagetool.py');
    const p = image(dir, 'x.jpg', 320, 200);
    const warns = [];
    const realWarn = Utils.warn;
    Utils.warn = m => warns.push(m);
    tc.ensureThumbnail(p, 250, 140, (err, path) => {
        Utils.warn = realWarn;
        T.ok(err && !path, 'error callback');
        T.ok(warns.length === 1 && /no-such-imagetool\.py/.test(warns[0]), 'reason logged: ' + warns[0]);
        T.eq([tc._workers, tc._inFlight.size], [0, 0], 'worker count and in-flight list back to zero');
        done();
    });
}, 15);

T.exit();
