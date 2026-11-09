// Compositor (0.2.1): one connected monitor short-circuits to the source image;
// two or more always build a composite with imagetool.py (GdkPixbuf), checked
// here by size and pixel colour. No ImageMagick anywhere, in the applet or here.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);   // loads modules the way Cinnamon does
const GLib = imports.gi.GLib;
imports.gi.versions.GdkPixbuf = '2.0';
const GdkPixbuf = imports.gi.GdkPixbuf;
const Utils = require('./modules/Utils');
const Compositor = require('./modules/Compositor').Compositor;

const TOOL = ARGV[0] + '/imagetool.py';
let dir = T.tmpDir('comp');
let cacheDir = dir + '/cache';

function makeImage(path, w, h, rgba) {
    let pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, w, h);
    pb.fill(rgba);
    pb.savev(path, 'png', [], []);
    return path;
}
function info(path) {
    let [fmt, w, h] = GdkPixbuf.Pixbuf.get_file_info(path);
    return fmt ? w + ' ' + h + ' ' + fmt.get_name() : 'unreadable';
}
function pixel(path, x, y) {
    let pb = GdkPixbuf.Pixbuf.new_from_file(path);
    let d = pb.get_pixels(), i = y * pb.get_rowstride() + x * pb.get_n_channels();
    return [d[i], d[i + 1], d[i + 2]];
}
function near(c, want) { return c.every((v, i) => Math.abs(v - want[i]) <= 40); }
const RED = [255, 0, 0], BLUE = [0, 0, 255], BLACK = [0, 0, 0];

const monitors = [
    { name: 'DP-1',   x: 0,   y: 0,  width: 320, height: 200, primary: true  },
    { name: 'HDMI-1', x: 320, y: 40, width: 160, height: 120, primary: false }
];

T.runAsync('one connected monitor: source path returned, picture-options mapped, no subprocess', done => {
    let comp = new Compositor(cacheDir, TOOL);
    let spawned = 0;
    let orig = Utils.spawnAsync;
    Utils.spawnAsync = function() { spawned++; return orig.apply(null, arguments); };
    let modes = { zoom: 'zoom', fit: 'scaled', stretch: 'stretched', center: 'centered', tile: 'wallpaper', bogus: 'zoom' };
    let keys = Object.keys(modes), i = 0;
    let next = () => {
        if (i === keys.length) { Utils.spawnAsync = orig; T.eq(spawned, 0, 'imagetool.py never run'); done(); return; }
        let mode = keys[i++];
        comp.compose([monitors[0]], { 'DP-1': { path: '/src/a.jpg', scaling: mode } }, (err, out, opts) => {
            T.eq(err, null, mode + ' no error');
            T.eq(out, '/src/a.jpg', mode + ' returns source path');
            T.eq(opts, modes[mode], mode + ' picture-options');
            next();
        });
    };
    next();
});

T.runAsync('no valid assignments → error callback', done => {
    new Compositor(cacheDir, TOOL).compose(monitors, {}, (err, out) => {
        T.ok(err instanceof Error); T.eq(out, null); done();
    });
});

T.runAsync('runs imagetool.py with /usr/bin/python3 and a JSON job; never ImageMagick', done => {
    let comp = new Compositor(cacheDir, TOOL);
    let orig = Utils.spawnAsync, argv = null;
    Utils.spawnAsync = function(a, cb) { argv = a; cb(null, '', '', 0); };
    comp.compose(monitors, {
        'DP-1':   { path: '/w/a.jpg', scaling: 'fit' },
        'HDMI-1': { path: '/w/b.jpg', scaling: 'nonsense' }
    }, (err, out, opts) => {
        Utils.spawnAsync = orig;
        T.eq(argv.slice(0, 3), ['/usr/bin/python3', TOOL, 'compose'], 'absolute python3, tool path, compose');
        let job = JSON.parse(argv[3]);
        T.eq([job.width, job.height], [480, 200], 'canvas = max(x+w) × max(y+h)');
        T.eq(job.monitors.map(m => [m.path, m.x, m.y, m.width, m.height, m.scaling]),
             [['/w/a.jpg', 0, 0, 320, 200, 'fit'], ['/w/b.jpg', 320, 40, 160, 120, 'zoom']],
             'geometry per monitor; unknown scaling falls back to zoom');
        T.eq(job.output, out, 'callback gets the file the job wrote');
        T.eq(opts, 'spanned');
        done();
    });
});

T.runAsync('multi-monitor: composite is a JPEG the size of the virtual desktop, alternating output files', done => {
    let a = makeImage(dir + '/a.png', 640, 480, 0xff0000ff);   // red
    let b = makeImage(dir + '/b.png', 200, 400, 0x0000ffff);   // blue
    let comp = new Compositor(cacheDir, TOOL);
    let modes = ['zoom', 'fit', 'stretch', 'center', 'tile'];
    let outputs = [];
    let i = 0;
    let next = () => {
        if (i === modes.length) {
            T.eq(new Set(outputs).size, 2, 'alternates between two output files');
            T.ok(outputs[0] !== outputs[1], 'consecutive composites use different files');
            done(); return;
        }
        let mode = modes[i++];
        comp.compose(monitors, {
            'DP-1':   { path: a, scaling: mode },
            'HDMI-1': { path: b, scaling: mode }
        }, (err, out, opts) => {
            T.eq(err, null, mode + ': no error');
            T.eq(opts, 'spanned', mode + ': spanned');
            outputs.push(out);
            T.eq(info(out), '480 200 jpeg', mode + ': canvas = max(x+w) × max(y+h), JPEG');
            T.ok(near(pixel(out, 160, 100), RED), mode + ': DP-1 region shows its image');
            T.ok(near(pixel(out, 400, 100), BLUE), mode + ': HDMI-1 region shows its image');
            T.ok(near(pixel(out, 400, 10), BLACK), mode + ': above HDMI-1 (outside every monitor) is black');
            next();
        });
    };
    next();
}, 60);

T.runAsync('two connected, one with an image: composite with the other black, not the bare image', done => {
    let a = makeImage(dir + '/solo.png', 640, 480, 0xff0000ff);
    new Compositor(cacheDir, TOOL).compose(monitors, { 'DP-1': { path: a, scaling: 'zoom' } }, (err, out, opts) => {
        T.eq(err, null);
        T.eq(opts, 'spanned', 'spanned, so Cinnamon does not repeat the image on HDMI-1');
        T.ok(out !== a, 'a composite, not the source file');
        T.ok(near(pixel(out, 160, 100), RED), 'DP-1 shows the image');
        T.ok(near(pixel(out, 400, 100), BLACK), 'HDMI-1 stays black');
        done();
    });
}, 30);

T.runAsync('imagetool failure (missing source) → error, no output, no temp file left', done => {
    let comp = new Compositor(cacheDir, TOOL);
    comp.compose(monitors, {
        'DP-1':   { path: dir + '/missing.png', scaling: 'zoom' },
        'HDMI-1': { path: dir + '/b.png',       scaling: 'zoom' }
    }, (err, out) => {
        T.ok(err instanceof Error, 'error surfaced');
        T.eq(out, null);
        T.eq(T.listDir(cacheDir).filter(n => n.endsWith('.part') || n.startsWith('compositing_')), [],
             'no temp files left behind');
        done();
    });
}, 30);

T.run('no shipped file runs ImageMagick', () => {
    let hits = [];
    let walk = d => {
        for (let n of T.listDir(d)) {
            let p = d + '/' + n;
            if (GLib.file_test(p, GLib.FileTest.IS_DIR)) { walk(p); continue; }
            if (!/\.(js|py)$/.test(n)) continue;
            let src = T.readFile(p);
            if (/['"](convert|identify|magick|mogrify|composite)['"]/.test(src) || /imagemagick/i.test(src))
                hits.push(p.slice(ARGV[0].length + 1));
        }
    };
    walk(ARGV[0]);
    T.eq(hits, [], 'no convert/identify/magick command and no ImageMagick mention in .js/.py');
});

imports.system.exit(T.summary());
