// applet.js class methods, run headless:
//   0.0.4 — B1 pause icon, B2 interval, B3 Sync-mode carousel click, B4 GI imports
//   0.1.0 — menu layouts (one monitor, Sync, per monitor, icons on every row),
//           tooltip, middle-click pause, scroll guard, favorites, notifications
// The real applet.js source is evaluated the way Cinnamon's loader would, with
// small stand-ins for imports.ui.*, for St / Clutter / Pango (Cinnamon-only
// typelibs) and for the two modules that need a running shell (CarouselManager,
// MonitorManager). Methods are called on a bare prototype instance, so nothing
// touches ~/.local/share/wallshift.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const GLib = imports.gi.GLib;
const appletDir = ARGV[0];
const realRequire = T.makeRequire(appletDir);

// ── Stand-ins ──────────────────────────────────────────────────────────────────

const notified = [];
class FakeIconApplet {
    set_applet_icon_symbolic_name(name) { this.iconName = name; }
    set_applet_tooltip(text) { this.tooltip = text; }
}
class FakeLabel {
    constructor(text) { this.text = text; this.clutter_text = {}; this.classes = []; }
    set_style(s) { this.style = s; }
    add_style_class_name(c) { this.classes.push(c); }
}
class FakeItem {
    constructor(kind, text, extra) {
        Object.assign(this, { kind, text, label: new FakeLabel(text), actor: { visible: true },
                              sensitive: true, handlers: {} }, extra || {});
    }
    connect(sig, cb) { this.handlers[sig] = cb; }
    setSensitive(v) { this.sensitive = v; }
    setToggleState(v) { this.state = v; }
}
class FakeSection {
    constructor() { this.items = []; }
    addMenuItem(i) { this.items.push(i); }
    removeAll() { this.items = []; }
}
const FakePopupMenu = {
    PopupMenuItem:  class extends FakeItem { constructor(t, p) { super('plain', t, { reactive: !(p && p.reactive === false) }); } },
    PopupIconMenuItem: class extends FakeItem {
        constructor(t, icon, _type, p) { super('icon', t, { icon, reactive: !(p && p.reactive === false) }); } },
    PopupSwitchIconMenuItem: class extends FakeItem {
        constructor(t, active, icon) { super('switch', t, { icon, state: active, reactive: true }); } },
    PopupSubMenuMenuItem: class extends FakeItem {
        constructor(t) { super('sub', t, { menu: new FakeSection(), icons: [], reactive: true }); }
        addActor(a) { this.icons.push(a.icon_name); } },
    PopupSeparatorMenuItem: class extends FakeItem { constructor() { super('sep', ''); } },
    PopupMenuSection: FakeSection,
};
const FakeSt = {
    Icon: class { constructor(o) { Object.assign(this, o); } },
    IconType: { SYMBOLIC: 1, FULLCOLOR: 0 },
};
const FakeClutter = { EVENT_STOP: true, EVENT_PROPAGATE: false, ScrollDirection: { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3 } };
const FakePango = { EllipsizeMode: { END: 3 } };
const FakeMessageTray = {
    SystemNotificationSource: class { notify(n) { notified.push([n.title, n.body]); } },
    Notification: class { constructor(_s, title, body) { this.title = title; this.body = body; } setTransient() {} },
};
const fakeImports = {
    gi: new Proxy({}, { get: (_t, k) => ({ St: FakeSt, Clutter: FakeClutter, Pango: FakePango })[k] || imports.gi[k] }),
    gettext: imports.gettext,
    ui: { applet: { IconApplet: FakeIconApplet }, popupMenu: FakePopupMenu, settings: {},
          main: { notify(t, b) { notified.push([t, b]); }, messageTray: { add() {} } },
          messageTray: FakeMessageTray },
};
function fakeRequire(path) {
    if (path === './modules/CarouselManager') return { CarouselManager: class {} };
    if (path === './modules/MonitorManager')  return { MonitorManager: class {} };
    return realRequire(path);
}
const src = T.readFile(appletDir + '/applet.js');
const WallshiftApplet = new Function('require', 'imports',
    "'use strict';" + src + '\n;return WallshiftApplet;')(fakeRequire, fakeImports);

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

imports.system.exit(T.summary());
