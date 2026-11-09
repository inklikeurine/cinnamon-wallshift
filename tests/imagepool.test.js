// ImagePool: order modes, no-repeat guarantee, trash removal, async scan.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);   // loads modules the way Cinnamon does
const GLib = imports.gi.GLib;
const ImagePool = require('./modules/ImagePool').ImagePool;

const N = 12;
let dir = T.tmpDir('pool');
T.mkdirp(dir + '/sub dir');
T.mkdirp(dir + '/.hidden');
let names = [];
for (let i = 0; i < N; i++) {
    let name = (i % 2 ? 'sub dir/' : '') + 'img' + String(i).padStart(2, '0') + (i % 3 ? '.jpg' : '.PNG');
    T.writeFile(dir + '/' + name, 'x');
    names.push(dir + '/' + name);
}
T.writeFile(dir + '/notes.txt', 'x');          // non-image: ignored
T.writeFile(dir + '/.hidden/h.jpg', 'x');      // hidden dir: ignored
T.writeFile(dir + '/.dotfile.jpg', 'x');       // hidden file: ignored

function makePool(order, cb) {
    let p = new ImagePool('t');
    p.setFolders([dir]);
    p.setOrder(order);
    p.scan(() => cb(p));
    return p;
}

T.runAsync('scan finds exactly the visible image files (recursive, case-insensitive ext)', done => {
    makePool('no-repeat', p => {
        T.eq(p.getCount(), N, 'count');
        T.eq(p.getImages(), names.slice().sort(), 'getImages() is sorted and complete');
        done();
    });
});

T.runAsync('no-repeat: every image appears exactly once per cycle, for 3 cycles', done => {
    makePool('no-repeat', p => {
        for (let cycle = 0; cycle < 3; cycle++) {
            let seen = new Set();
            for (let i = 0; i < N; i++) seen.add(p.next());
            T.eq(seen.size, N, 'cycle ' + cycle + ' has no repeats');
        }
        done();
    });
});

T.runAsync('sequential: alphabetical by full path and wraps', done => {
    makePool('sequential', p => {
        let sorted = names.slice().sort();
        let out = [];
        for (let i = 0; i < N + 2; i++) out.push(p.next());
        T.eq(out.slice(0, N), sorted, 'first pass is sorted');
        T.eq(out.slice(N), sorted.slice(0, 2), 'wraps to the start');
        done();
    });
});

T.runAsync('random: always returns a pool member', done => {
    makePool('random', p => {
        for (let i = 0; i < 50; i++) T.ok(names.includes(p.next()), 'member');
        done();
    });
});

T.runAsync('removePath drops the image from pool and current cycle; trashed paths excluded on rescan', done => {
    makePool('no-repeat', p => {
        let victim = names[3];
        p.removePath(victim);
        T.eq(p.getCount(), N - 1, 'count after removal');
        let seen = new Set();
        for (let i = 0; i < (N - 1) * 2; i++) seen.add(p.next());
        T.ok(!seen.has(victim), 'removed path never returned');
        p.scan(() => {
            T.eq(p.getCount(), N - 1, 'rescan still excludes trashed path');
            done();
        });
    });
});

T.runAsync('empty / missing folder yields an empty pool and next() === null', done => {
    let p = new ImagePool('e');
    p.setFolders(['/nonexistent/folder', dir + '/.hidden']);
    p.scan(() => { T.eq(p.getCount(), 0); T.eq(p.next(), null); done(); });
});

T.runAsync('a scan superseded by a newer scan never fires its callback', done => {
    let p = new ImagePool('s');
    p.setFolders([dir]);
    let fired = [];
    p.scan(() => fired.push(1));
    p.scan(() => { fired.push(2); T.eq(fired, [2]); done(); });
});

imports.system.exit(T.summary());
