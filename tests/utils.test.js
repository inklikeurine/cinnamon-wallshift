// Utils: folder-value normalisation (URI / ~ / whitespace) and the absolute-path guard.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);   // loads modules the way Cinnamon does
const GLib = imports.gi.GLib;
const Utils = require('./modules/Utils');
const home = GLib.get_home_dir();

T.run('normalizePath: file:// URIs (Cinnamon native chooser) decode to plain paths', () => {
    T.eq(Utils.normalizePath('file:///home/u/Wallpaper%20Favorites'), '/home/u/Wallpaper Favorites', 'percent-encoded');
    T.eq(Utils.normalizePath('file:///home/u/Wallpaper Favorites'), '/home/u/Wallpaper Favorites', 'raw space');
    T.eq(Utils.normalizePath('file://localhost/home/u/x'), '/home/u/x', 'localhost authority');
    T.eq(Utils.normalizePath('file:/home/u/y'), '/home/u/y', 'single-slash form');
    T.eq(Utils.normalizePath('file:///home/u/%E2%9C%93'), '/home/u/✓', 'utf-8 escapes');
});

T.run('normalizePath: plain paths, ~, whitespace, empty', () => {
    T.eq(Utils.normalizePath('/home/u/plain'), '/home/u/plain');
    T.eq(Utils.normalizePath('  /home/u/z  '), '/home/u/z', 'trimmed');
    T.eq(Utils.normalizePath('~/Pictures/Favs'), home + '/Pictures/Favs', '~ expanded');
    T.eq(Utils.normalizePath('~'), home);
    T.eq(Utils.normalizePath('~user/x'), '~user/x', '~user is not expanded');
    T.eq(Utils.normalizePath(''), '');
    T.eq(Utils.normalizePath(null), '');
    T.eq(Utils.normalizePath(undefined), '');
});

T.run('absoluteDirOr: relative or empty results fall back', () => {
    T.eq(Utils.absoluteDirOr('/abs/dir', '/fb', 'x'), '/abs/dir', 'absolute kept');
    T.eq(Utils.absoluteDirOr('rel/dir', '/fb', 'x'), '/fb', 'relative → fallback');
    T.eq(Utils.absoluteDirOr('file:/oops', '/fb', 'x'), '/fb', 'unconverted URI → fallback');
    T.eq(Utils.absoluteDirOr('', '/fb', 'x'), '/fb', 'empty → fallback');
    T.eq(Utils.absoluteDirOr(Utils.normalizePath('file:///home/u/F%20avs'), '/fb', 'x'), '/home/u/F avs', 'pipeline');
});

T.run('isImageFile / getExtension', () => {
    T.eq(Utils.isImageFile('/a/b.JPG'), true);
    T.eq(Utils.isImageFile('/a/b.jpeg'), true);
    T.eq(Utils.isImageFile('/a/.hidden.jpg'), false, 'dotfile');
    T.eq(Utils.isImageFile('/a/b.txt'), false);
    T.eq(Utils.isImageFile('/a/noext'), false);
    T.eq(Utils.getExtension('/a/b.PNG'), '.png');
});

T.run('shuffle keeps the multiset', () => {
    let a = [1,2,3,4,5,6,7,8,9,10];
    let s = Utils.shuffle(a.slice()).sort((x,y)=>x-y);
    T.eq(s, a);
});

T.run('intervalSeconds: 0 minutes means seconds only; 10 s floor; missing → 5 min (0.0.4 B2)', () => {
    T.eq(Utils.intervalSeconds(0, 30), 30, '0 min 30 s is 30 s, not 5 min 30 s');
    T.eq(Utils.intervalSeconds(0, 5), 10, 'below the floor → 10 s');
    T.eq(Utils.intervalSeconds(0, 0), 10, '0 / 0 → 10 s');
    T.eq(Utils.intervalSeconds(2, 15), 135);
    T.eq(Utils.intervalSeconds(undefined, undefined), 300, 'unset → 5 min default');
    T.eq(Utils.intervalSeconds(null, 20), 320, 'unset minutes, 20 s');
});

T.run('tooltipText: next change, count, paused monitors, empty pool (0.1.0 P1)', () => {
    T.eq(Utils.tooltipText({ count: 412, paused: false, pausedNames: [], secondsLeft: 170 }),
        'Wallshift \u2014 next change in 3 min\n412 images');
    T.eq(Utils.tooltipText({ count: 1, paused: false, pausedNames: [], secondsLeft: 40 }),
        'Wallshift \u2014 next change in 40 s\n1 image', 'singular');
    T.eq(Utils.tooltipText({ count: 412, paused: false, pausedNames: ['Contoso U32'], secondsLeft: 60 }),
        'Wallshift \u2014 next change in 1 min\n412 images \u00b7 Contoso U32 paused');
    T.eq(Utils.tooltipText({ count: 412, paused: true, pausedNames: ['Contoso U32'], secondsLeft: 60 }),
        'Wallshift \u2014 paused\n412 images', 'all paused: no per-monitor list');
    T.eq(Utils.tooltipText({ count: 9, paused: false, pausedNames: [], secondsLeft: null }),
        'Wallshift\n9 images', 'no timer yet');
    T.ok(/No images found/.test(Utils.tooltipText({ count: 0 })), '0 → configure hint');
});

T.run('formatDuration rounds up to whole minutes past 60 s', () => {
    T.eq(Utils.formatDuration(0), '0 s');
    T.eq(Utils.formatDuration(59.4), '59 s');
    T.eq(Utils.formatDuration(61), '2 min');
    T.eq(Utils.formatDuration(3600), '1 h');
    T.eq(Utils.formatDuration(3900), '1 h 5 min');
});

T.run('secondsUntilNext follows a repeating timer', () => {
    T.eq(Utils.secondsUntilNext(0, 300, 1e9), null, 'no timer');
    T.eq(Utils.secondsUntilNext(1e6, 300, 1e6 + 100e6), 200);
    T.eq(Utils.secondsUntilNext(1e6, 300, 1e6 + 400e6), 200, 'second period');
});

T.run('changeNotificationBody: a line per changed monitor, one line for Sync (0.1.0 X2)', () => {
    T.eq(Utils.changeNotificationBody([
        { displayName: 'ACME 27Q', path: '/w/alpine.jpg' },
        { displayName: 'Contoso U32', path: '/w/forest.jpg' }]),
        'ACME 27Q: alpine.jpg\nContoso U32: forest.jpg');
    T.eq(Utils.changeNotificationBody([
        { displayName: 'ACME 27Q', path: '/w/same.jpg' },
        { displayName: 'Contoso U32', path: '/w/same.jpg' }]), 'same.jpg (all monitors)');
    T.eq(Utils.changeNotificationBody([{ displayName: 'ACME 27Q', path: '/w/a.jpg' }]), 'ACME 27Q: a.jpg');
});

T.runAsync('launch passes each argument intact and reports a missing program (0.2.3)', done => {
    const dir = T.tmpDir('launch');
    const odd = 'it\'s "quoted" $HOME & co.jpg';
    T.ok(Utils.launch(['/bin/sh', '-c', 'printf %s "$1" > "$2"', 'sh', odd, dir + '/out']), 'started');
    T.eq(Utils.launch(['/nonexistent/wallshift-viewer', odd]), false, 'missing program → false, no throw');
    let tries = 0;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        if (!GLib.file_test(dir + '/out', GLib.FileTest.EXISTS) && ++tries < 40) return GLib.SOURCE_CONTINUE;
        T.eq(T.readFile(dir + '/out'), odd, 'the program received the argument unchanged');
        done();
        return GLib.SOURCE_REMOVE;
    });
}, 10);

imports.system.exit(T.summary());
