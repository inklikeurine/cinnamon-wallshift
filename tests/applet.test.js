// applet.js class methods, run headless:
//   0.0.4 — B1 pause icon, B2 interval, B3 Sync-mode carousel click, B4 GI imports
//   0.1.0 — menu layouts (one monitor, Sync, per monitor, icons on every row),
//           tooltip, middle-click pause, scroll guard, favorites, notifications
// The real applet.js source is evaluated by support/appletLoader.js the way
// Cinnamon's loader would, with stand-ins for the shell. Methods are called on a
// bare prototype instance, so nothing touches ~/.local/share/wallshift.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const GLib = imports.gi.GLib;
const appletDir = ARGV[0];
imports.searchPath.unshift(ARGV[2] + '/support');
const L = imports.appletLoader;
const { notified, FakeItem, FakeSection, FakePango, FakeClutter } = L;
const { WallshiftApplet, src, require } = L.load(T, appletDir);

// ── Fixture applet ─────────────────────────────────────────────────────────────

// Monitors DP-1 (primary), HDMI-1 and DP-2; DP-2 is disabled in monitor-config.json.
const MONS = [
    { name: 'DP-1',   displayName: 'ACME 27Q', primary: true },
    { name: 'HDMI-1', displayName: 'Contoso U32' },
    { name: 'DP-2',   displayName: 'DP-2' },
];
function fakeApplet(opts) {
    const a = Object.create(WallshiftApplet.prototype);
    const current = { 'DP-1': '/w/one.jpg', 'HDMI-1': '/w/two.jpg', 'DP-2': '/w/three.jpg' };
    const paused = new Set(opts.pausedMonitors || []);
    a._syncMode = !!opts.sync;
    a._compositeInProgress = false;
    a._monitorsReady = true;
    a._historyPosition = 0;
    a._monitorConfig = { monitors: { 'DP-2': { enabled: false } } };
    a._globalFolder = '/w';
    a._favoritesFolder = opts.favDir || '/nonexistent-favs';
    a._monitorManager = { getMonitors: () => (opts.monitors || MONS) };
    a._stateManager = {
        _paused: !!opts.paused,
        isPaused() { return this._paused; },
        setPaused(v) { this._paused = v; },
        isMonitorPaused: n => paused.has(n),
        getMonitorRecord: name => ({ currentImage: current[name] }),
        setMonitorCurrentImage: (n, p) => { current[n] = p; },
        getHistoryAt: () => null,
        pushHistory() {}, save() {},
    };
    a._carouselManager = { isOpen: () => false, onWallpaperChanged() {}, refreshFavorite() {} };
    a._imagePools = new Map([['DP-1', { getCount: () => 400 }], ['HDMI-1', { getCount: () => 12 }]]);
    a._syncPool = null;
    a._resetTimer = () => {};
    a._startTimer = () => { a.started = true; };
    a._stopTimer = () => { a.stopped = true; };
    a._compose = (monitors, assignments, isNew, images) => { a.composed = { assignments, isNew, images }; };
    a.menu = { close() {} };
    a._monitorSection = new FakeSection();
    a._prevItem = new FakeItem('icon', 'Previous Wallpaper');
    a._pauseItem = new FakeItem('switch', 'Pause Rotation');
    a._swapItem = new FakeItem('icon', 'Swap Images');
    return a;
}
const texts = items => items.map(i => i.kind === 'sep' ? '—' : i.text);

// ── 0.0.4 ──────────────────────────────────────────────────────────────────────

T.run('_updatePanelIcon follows the persisted pause state (B1)', () => {
    const a = fakeApplet({ paused: true });
    a._updatePanelIcon();
    T.eq(a.iconName, 'wallshift-paused-symbolic', 'paused → paused Wallshift icon');
    const b = fakeApplet({ paused: false });
    b._updatePanelIcon();
    T.eq(b.iconName, 'wallshift-symbolic', 'running → normal icon');
    const ctor = src.slice(src.indexOf('constructor('), src.indexOf('_bindSettings() {'));
    T.ok(ctor.indexOf('this._updatePanelIcon()') > ctor.indexOf('this._stateManager.load()'),
        'constructor sets the icon after state.json is loaded');
});

T.run('_getIntervalSeconds honours 0 minutes (B2)', () => {
    const a = fakeApplet({});
    a._intervalMinutes = 0; a._intervalSeconds = 30;
    T.eq(a._getIntervalSeconds(), 30);
});

T.run('_applyImageToMonitor: Sync mode applies to every enabled monitor (B3)', () => {
    const a = fakeApplet({ sync: true });
    a._applyImageToMonitor('DP-1', '/w/new.jpg');
    const imgs = a.composed.images;
    T.eq(imgs['DP-1'], '/w/new.jpg', 'clicked monitor');
    T.eq(imgs['HDMI-1'], '/w/new.jpg', 'other enabled monitor follows');
    T.eq(imgs['DP-2'], '/w/three.jpg', 'disabled monitor keeps its image');
    T.eq(a.composed.isNew, true, 'recorded as a change');
});

T.run('_applyImageToMonitor: independent mode changes only that monitor', () => {
    const a = fakeApplet({ sync: false });
    a._applyImageToMonitor('HDMI-1', '/w/new.jpg');
    T.eq(a.composed.images['HDMI-1'], '/w/new.jpg');
    T.eq(a.composed.images['DP-1'], '/w/one.jpg', 'other monitor unchanged');
});

T.run('every GI namespace a shipped file uses is imported in that file (B4)', () => {
    const files = ['applet.js'].concat(T.listDir(appletDir + '/modules').map(n => 'modules/' + n));
    for (const f of files) {
        const code = T.readFile(appletDir + '/' + f)
            .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
        for (const ns of ['GLib', 'Gio', 'St', 'Clutter', 'Pango', 'GdkPixbuf', 'Cogl', 'Gdk']) {
            if (!new RegExp('\\b' + ns + '\\.').test(code)) continue;
            T.ok(new RegExp('\\b(const|let|var)\\s+' + ns + '\\s*=').test(code), f + ' declares ' + ns);
        }
    }
});

// ── 0.1.0: menu ────────────────────────────────────────────────────────────────

T.run('one monitor: its items sit in the menu, no submenu, no Swap (M4)', () => {
    const a = fakeApplet({ monitors: [MONS[0]] });
    a._updateMenuState();
    const items = a._monitorSection.items;
    T.eq(texts(items), ['Carousel', '—', 'one.jpg', '—', 'Favorite This Image', 'Trash This Image', '—',
                        'Open in Image Viewer']);
    T.ok(!items.some(i => i.kind === 'sub'), 'no submenu');
    T.eq(a._swapItem.actor.visible, false, 'Swap hidden');
});

T.run('Sync mode: one "All monitors" submenu acting on the primary monitor (M5)', () => {
    const a = fakeApplet({ sync: true });
    a._updateMenuState();
    const items = a._monitorSection.items;
    T.eq(items.length, 1, 'one entry');
    T.eq(items[0].text, 'All monitors');
    T.eq(items[0].icons, ['video-display-symbolic'], 'submenu row has an icon');
    T.eq(texts(items[0].menu.items)[0], 'Carousel (on ACME 27Q)');
    T.eq(a._swapItem.sensitive, false, 'Swap greyed in Sync mode');
});

T.run('several monitors: a submenu each, "· paused" marks, Next above Previous (M3, M2)', () => {
    const a = fakeApplet({ pausedMonitors: ['HDMI-1'] });
    a._updateMenuState();
    const subs = a._monitorSection.items;
    T.eq(subs.map(s => s.text), ['ACME 27Q (DP-1) ★', 'Contoso U32 (HDMI-1) · paused', 'DP-2']);
    const rows = texts(subs[1].menu.items);
    T.eq(rows, ['Carousel', '—', 'two.jpg', '—', 'Next Image', 'Previous Image', 'Pause Rotation', '—',
                'Favorite This Image', 'Trash This Image', '—', 'Open in Image Viewer']);
    T.eq(subs[1].menu.items.find(i => i.text === 'Pause Rotation').state, true, 'pause switch on');
});

T.run('icons on every action row; the file-name row is the only one without (M2, M7)', () => {
    for (const opts of [{}, { sync: true }, { monitors: [MONS[0]] }]) {
        const a = fakeApplet(opts);
        a._updateMenuState();
        const all = [];
        const walk = list => { for (const i of list) { all.push(i); if (i.menu) walk(i.menu.items); } };
        walk(a._monitorSection.items);
        for (const i of all) {
            if (i.kind === 'sep') continue;
            if (i.kind === 'sub') { T.ok(i.icons.length === 1, i.text + ': icon'); continue; }
            if (i.reactive) T.ok(!!i.icon, i.text + ': icon');
            else T.ok(i.label.clutter_text.ellipsize === FakePango.EllipsizeMode.END, i.text + ': ellipsized');
        }
    }
    T.ok(/new PopupMenu\.PopupIconMenuItem|this\._iconItem\(/.test(src) && !/new PopupMenu\.PopupMenuItem\(_\('(Next|Previous|Refresh|Open)/.test(src),
        'static rows are icon items');
});

T.run('favorite row turns into "Remove from Favorites" when the image is already there', () => {
    const favDir = T.tmpDir('favs');
    T.writeFile(favDir + '/one.jpg', 'x');
    const a = fakeApplet({ monitors: [MONS[0]], favDir });
    a._updateMenuState();
    const fav = a._monitorSection.items.find(i => /Favorite/.test(i.text));
    T.eq(fav.text, 'Remove from Favorites');
    T.eq(fav.icon, 'starred-symbolic');
});

// ── 0.1.0: panel icon ──────────────────────────────────────────────────────────

T.run('tooltip: next change, count, paused monitors (P1)', () => {
    const a = fakeApplet({ pausedMonitors: ['HDMI-1'] });
    a._timerId = 7;
    a._timerInterval = 300;
    a._timerStartedAt = GLib.get_monotonic_time() - 130e6;
    a._updateTooltip();
    T.eq(a.tooltip, 'Wallshift — next change in 3 min\n412 images · Contoso U32 paused');
    a._timerId = null;
    a._stateManager.setPaused(true);
    a._updateTooltip();
    T.eq(a.tooltip, 'Wallshift — paused\n412 images');
});

T.run('middle-click pauses and resumes (P2)', () => {
    const a = fakeApplet({});
    a.on_applet_middle_clicked();
    T.eq(a._stateManager.isPaused(), true);
    T.eq(a.stopped, true, 'timer stopped');
    T.eq(a.iconName, 'wallshift-paused-symbolic');
    a.on_applet_middle_clicked();
    T.eq(a._stateManager.isPaused(), false);
    T.eq(a.started, true, 'timer restarted');
});

T.run('scroll: up = previous, down = next, ignored mid-composite (P2)', () => {
    const a = fakeApplet({});
    const calls = [];
    a._navigatePrevious = () => calls.push('prev');
    a._navigateNext = () => calls.push('next');
    const ev = d => ({ get_scroll_direction: () => d });
    a._onPanelScroll(ev(FakeClutter.ScrollDirection.UP));
    a._onPanelScroll(ev(FakeClutter.ScrollDirection.DOWN));
    a._compositeInProgress = true;
    a._onPanelScroll(ev(FakeClutter.ScrollDirection.DOWN));
    T.eq(calls, ['prev', 'next']);
});

// ── 0.1.0: favorites, trash, notifications ─────────────────────────────────────

T.run('removing a favorite never touches an image that lives in the favorites folder', () => {
    const favDir = T.tmpDir('favs2');
    const a = fakeApplet({ favDir });
    a._stateManager.getMonitorRecord = () => ({ currentImage: favDir + '/kept.jpg' });
    T.writeFile(favDir + '/kept.jpg', 'x');
    notified.length = 0;
    a._toggleFavorite('DP-1');
    T.ok(GLib.file_test(favDir + '/kept.jpg', GLib.FileTest.EXISTS), 'file still there');
    T.eq(notified[0][1], 'kept.jpg is in your Favorites folder');
});

T.run('Trash says what it did (M9)', () => {
    const a = fakeApplet({});
    a._trashPath = () => {};
    a._changeMonitorWallpaper = () => {};
    notified.length = 0;
    a._trashMonitorImage('DP-1');
    T.eq(notified[0], ['Wallshift', 'Moved to Trash: one.jpg']);
});

T.run('change notification lists only monitors whose image changed (X2)', () => {
    const a = fakeApplet({});
    a._showNotifications = true;
    a._destroyed = false;
    a._compose = WallshiftApplet.prototype._compose;
    a._compositor = { compose: (m, as, cb) => cb(null, '/out.jpg', 'spanned') };
    a._applyWallpaper = () => {};
    a._updateTooltip = () => {};
    a._checkPending = () => {};
    notified.length = 0;
    const mons = MONS.slice(0, 2);
    a._compose(mons, {}, true, { 'DP-1': '/w/new.jpg', 'HDMI-1': '/w/two.jpg' });
    T.eq(notified, [['Wallpaper changed', 'ACME 27Q: new.jpg']]);
});

T.run('carousel options are sanitised before they reach the carousel', () => {
    const a = fakeApplet({});
    T.eq(a._carouselOptions(), { edge: 'bottom', thumbSize: 'medium', fileNames: 'hover', closeOnPick: false });
    Object.assign(a, { _carouselEdge: 'top', _carouselThumbSize: 'large', _carouselFileNames: 'never',
                       _carouselCloseOnPick: true });
    T.eq(a._carouselOptions(), { edge: 'top', thumbSize: 'large', fileNames: 'never', closeOnPick: true });
    a._carouselThumbSize = 'huge';
    T.eq(a._carouselOptions().thumbSize, 'medium');
});

// ── 0.2.3: programs are started from an argument list, never a shell string ────

T.run('viewer, folder and settings window get the path as one argument (0.2.3)', () => {
    const Utils = require('./modules/Utils');
    const real = Utils.launch;
    const calls = [];
    Utils.launch = argv => { calls.push(argv); return true; };
    try {
        const odd = '/w/it\'s "quoted" $HOME & co.jpg';
        const a = fakeApplet({});
        a._openImageInViewer(odd);
        T.eq(calls[0], ['xdg-open', odd], 'viewer gets the path untouched');
        a._stateManager.getMonitorRecord = () => ({ currentImage: odd });
        a._openCurrentFolder();
        T.eq(calls[1], ['xdg-open', '/w'], 'folder of the current image');
        a._metadata = { path: '/apps/my applets/wallshift@inklikeurine', uuid: 'wallshift@inklikeurine' };
        a._instanceId = 42;
        a.configureApplet();
        T.eq(calls[2], ['/usr/bin/python3', '/apps/my applets/wallshift@inklikeurine/configure.py',
                        'wallshift@inklikeurine', '42'], 'settings window: path with a space stays one argument');
    } finally {
        Utils.launch = real;
    }
    T.ok(!/spawn_command_line/.test(src), 'applet.js builds no shell command lines');
});

// ── 0.2.3: named actions (modules/Actions.js) ─────────────────────────────────

const Actions = require('./modules/Actions');

// The whole menu, static rows included, for one layout.
function builtMenu(opts) {
    const a = fakeApplet(opts);
    a.menu = new FakeSection();
    a.menu.connect = () => {};
    a.menu.close = () => { a.closed = (a.closed || 0) + 1; };
    a._buildMenu();
    a._updateMenuState();
    const rows = [];
    const walk = list => { for (const i of list) { if (i.menu) walk(i.menu.items); else if (i.items) walk(i.items); else rows.push(i); } };
    walk(a.menu.items);
    return { a, rows: rows.filter(i => i.kind !== 'sep' && i.reactive !== false) };
}

T.run('every clickable menu row runs a named action; every action is in the menu (0.2.3)', () => {
    const seen = new Set();
    for (const opts of [{}, { sync: true }, { monitors: [MONS[0]] }]) {
        const { rows } = builtMenu(opts);
        for (const r of rows) {
            T.ok(r.actionId in Actions.ACTIONS, '"' + r.text + '" → ' + r.actionId);
            seen.add(r.actionId);
        }
    }
    T.eq([...seen].sort(), Object.keys(Actions.ACTIONS).sort(), 'no action without a menu row');
    for (const [id, def] of Object.entries(Actions.ACTIONS))
        T.ok(def.label().length > 0 && /-symbolic$/.test(def.icon) && typeof def.run === 'function', id + ': label, icon, run');
});

T.run('menu rows call the same applet methods as before, for their own monitor (0.2.3)', () => {
    const { a, rows } = builtMenu({});
    const calls = [];
    for (const m of ['_navigateNext', '_navigatePrevious', '_swapImages', '_refreshMonitors', '_openCurrentFolder',
                     '_changeMonitorWallpaper', '_navigateMonitorPrevious', '_toggleFavorite', '_trashMonitorImage',
                     '_openImageInViewer', '_onPauseToggled'])
        a[m] = (...args) => calls.push([m].concat(args));
    a._carouselManager = { isOpen: () => false, openCarousel: m => calls.push(['open', m.name]),
                           closeCarousel: n => calls.push(['close', n]) };
    const pick = (id, i) => rows.filter(r => r.actionId === id)[i || 0];
    const fire = (row, state) => { if (row.kind === 'switch') { row.state = state; row.handlers.toggled(); } else row.handlers.activate(); };
    a.closed = 0;
    fire(pick('next'));                    T.eq(calls.pop(), ['_navigateNext']);
    fire(pick('previous'));                T.eq(calls.pop(), ['_navigatePrevious']);
    fire(pick('pause'), true);             T.eq(calls.pop(), ['_onPauseToggled', true]);
    T.eq(a.closed, 0, 'Next / Previous / Pause leave the menu open, as before');
    fire(pick('swap'));                    T.eq(calls.pop(), ['_swapImages']);
    fire(pick('refresh-monitors'));        T.eq(calls.pop(), ['_refreshMonitors']);
    fire(pick('open-folder'));             T.eq(calls.pop(), ['_openCurrentFolder']);
    fire(pick('monitor-next', 1));         T.eq(calls.pop(), ['_changeMonitorWallpaper', 'HDMI-1']);
    fire(pick('monitor-previous', 1));     T.eq(calls.pop(), ['_navigateMonitorPrevious', 'HDMI-1']);
    fire(pick('favorite', 0));             T.eq(calls.pop(), ['_toggleFavorite', 'DP-1']);
    fire(pick('trash', 2));                T.eq(calls.pop(), ['_trashMonitorImage', 'DP-2']);
    fire(pick('open-viewer', 1));          T.eq(calls.pop(), ['_openImageInViewer', '/w/two.jpg']);
    fire(pick('carousel', 1), true);       T.eq(calls.pop(), ['open', 'HDMI-1']);
    fire(pick('carousel', 1), false);      T.eq(calls.pop(), ['close', 'HDMI-1']);
    T.eq(a.closed, 9, 'the other rows close the menu first, as before');
    const paused = [];
    a._stateManager.setMonitorPaused = (n, v) => paused.push([n, v]);
    fire(pick('monitor-pause', 0), true);
    T.eq(paused, [['DP-1', true]], 'per-monitor pause');
});

T.run('Actions.run: unknown ids, missing monitors and a removed applet are ignored (0.2.3)', () => {
    const a = fakeApplet({});
    T.eq(Actions.run(a, 'no-such-action'), false, 'unknown id → false, no throw');
    T.eq(Actions.run(a, 'trash'), false, 'per-monitor action without a monitor → false');
    let ran = false;
    a._navigateNext = () => { ran = true; };
    a._destroyed = true;
    T.eq(a._runAction('next'), false, 'removed applet: nothing runs');
    T.eq(ran, false);
    a._destroyed = false;
    T.eq(a._runAction('next'), true);
    T.eq(ran, true);
});

// ── 0.2.3: rotation decisions come from modules/Rotation.js ────────────────────

T.run('timer tick, swap and history steps still reach the compositor (0.2.3)', () => {
    const a = fakeApplet({});
    const next = { 'DP-1': ['/w/p1.jpg'], 'HDMI-1': ['/w/p2.jpg'] };
    a._imagePools = new Map(Object.keys(next).map(k => [k, { next: () => next[k].shift() || null, getCount: () => 1 }]));
    a._changeWallpaper();
    T.eq(a.composed.images, { 'DP-1': '/w/p1.jpg', 'HDMI-1': '/w/p2.jpg' }, 'enabled monitors advance');
    T.eq(a.composed.assignments['DP-2'].path, '/w/three.jpg', 'disabled DP-2 keeps its image in the composite');
    a.composed = null;
    a._compositeInProgress = true;
    a._changeWallpaper();
    T.eq([a.composed, a._pendingChange], [null, true], 'mid-composite: queued, not composed');
    a._compositeInProgress = false;

    a._swapImages();
    T.eq(a.composed.images, { 'DP-1': '/w/two.jpg', 'HDMI-1': '/w/three.jpg', 'DP-2': '/w/one.jpg' }, 'swap rotates left');

    const view = a._rotationView.bind(a);
    a._rotationView = () => Object.assign(view(), { exists: () => true });   // the /w/ paths are not real files
    const hist = [{ monitors: { 'DP-1': '/w/h1.jpg' } }];
    a._stateManager.getHistoryAt = i => hist[i - 1] || null;
    a._historyPosition = 0;
    a._navigatePrevious();
    T.eq([a._historyPosition, a.composed.isNew, a.composed.assignments['DP-1'].path], [1, false, '/w/h1.jpg'], 'back one step');
    a._navigatePrevious();
    T.eq(a._historyPosition, 1, 'nothing older: position unchanged');
    let advanced = false;
    a._navigateNext();
    T.eq(a._historyPosition, 0, 'forward to the tip');
    a._changeWallpaper = () => { advanced = true; };
    a._navigateNext();
    T.eq(advanced, true, 'at the tip, Next changes the wallpaper');
});

T.runAsync('Favorite copies in the background, then says so (0.2.3)', done => {
    const srcDir = T.tmpDir('fav-src'), favDir = T.tmpDir('fav-dst') + '/Wallpaper Favorites';
    const img = srcDir + '/it\'s a "pic".jpg';
    T.writeFile(img, 'image bytes');
    const a = fakeApplet({ favDir });
    a._destroyed = false;
    a._stateManager.getMonitorRecord = () => ({ currentImage: img });
    let refreshed = 0;
    a._carouselManager.refreshFavorite = () => refreshed++;
    notified.length = 0;
    a._toggleFavorite('DP-1');
    T.eq(notified.length, 0, 'nothing announced before the copy finished');
    const t0 = GLib.get_monotonic_time();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        if (!notified.length && GLib.get_monotonic_time() - t0 < 5e6) return GLib.SOURCE_CONTINUE;
        T.eq(T.readFile(favDir + '/it\'s a "pic".jpg'), 'image bytes', 'copied, folder created, odd name intact');
        T.eq(notified[0], ['Wallshift', 'Saved to Favorites: it\'s a "pic".jpg']);
        T.eq(refreshed, 1, 'carousel star refreshed');
        const copyFn = src.slice(src.indexOf('    _copyToFavorites('), src.indexOf('    _trashPath('));
        T.ok(copyFn.length > 0 && !/file_get_contents|file_set_contents/.test(copyFn), 'no synchronous read or write of the image');
        done();
        return GLib.SOURCE_REMOVE;
    });
}, 10);

imports.system.exit(T.summary());
