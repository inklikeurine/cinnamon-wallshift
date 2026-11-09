// Shared by the suites (and bench/) that run applet.js headless: evaluates the
// real applet.js source the way Cinnamon's loader would, with small stand-ins for
// imports.ui.*, for St / Clutter / Pango (Cinnamon-only typelibs) and for the two
// modules that need a running shell (CarouselManager, MonitorManager).
// Load with: imports.searchPath.unshift(ARGV[2] + '/support'); const L = imports.appletLoader;
// (GJS importer: only top-level var / function are exported.)

var notified = [];

var FakeIconApplet = class {
    set_applet_icon_symbolic_name(name) { this.iconName = name; }
    set_applet_tooltip(text) { this.tooltip = text; }
};
var FakeLabel = class {
    constructor(text) { this.text = text; this.clutter_text = {}; this.classes = []; }
    set_style(s) { this.style = s; }
    add_style_class_name(c) { this.classes.push(c); }
};
var FakeItem = class {
    constructor(kind, text, extra) {
        Object.assign(this, { kind, text, label: new FakeLabel(text), actor: { visible: true },
                              sensitive: true, handlers: {} }, extra || {});
    }
    connect(sig, cb) { this.handlers[sig] = cb; }
    setSensitive(v) { this.sensitive = v; }
    setToggleState(v) { this.state = v; }
};
var FakeSection = class {
    constructor() { this.items = []; }
    addMenuItem(i) { this.items.push(i); }
    removeAll() { this.items = []; }
};
var FakePopupMenu = {
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
var FakeSt = {
    Icon: class { constructor(o) { Object.assign(this, o); } },
    IconType: { SYMBOLIC: 1, FULLCOLOR: 0 },
};
var FakeClutter = { EVENT_STOP: true, EVENT_PROPAGATE: false, ScrollDirection: { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3 } };
var FakePango = { EllipsizeMode: { END: 3 } };
var FakeMessageTray = {
    SystemNotificationSource: class { notify(n) { notified.push([n.title, n.body]); } },
    Notification: class { constructor(_s, title, body) { this.title = title; this.body = body; } setTransient() {} },
};

// Returns { WallshiftApplet, src, require } — `require` is the Cinnamon-style
// loader the applet used, so a caller can reach (and patch) the very module
// objects applet.js holds, e.g. require('./modules/Utils').spawnAsync.
function load(T, appletDir) {
    const realRequire = T.makeRequire(appletDir);
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
    return { WallshiftApplet, src, require: realRequire };
}
