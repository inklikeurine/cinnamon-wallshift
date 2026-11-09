// StateManager: defaults, corrupt-file recovery, migration, history cap, persistence.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);   // loads modules the way Cinnamon does
const GLib = imports.gi.GLib;
const StateManager = require('./modules/StateManager').StateManager;

function fresh(contents) {
    let dir = T.tmpDir('state');
    if (contents !== undefined) T.writeFile(dir + '/state.json', contents);
    let sm = new StateManager(dir);
    sm.load();
    return [sm, dir];
}

T.run('no state.json → defaults', () => {
    let [sm] = fresh();
    T.eq(sm.isPaused(), false);
    T.eq(sm.getTrashedPaths(), []);
    T.eq(sm.getHistoryLength(), 0);
    T.eq(sm.getMonitorRecord('HDMI-1'), null);
});

T.run('corrupted state.json → defaults, no throw', () => {
    for (let junk of ['{ this is not json', '', '[]', '42', '{"history": "nope"}']) {
        let [sm] = fresh(junk);
        T.ok(Array.isArray(sm.getTrashedPaths()), 'trashedPaths is array for ' + JSON.stringify(junk));
        T.eq(sm.isPaused(), false, 'paused default for ' + JSON.stringify(junk));
        T.ok(typeof sm.getHistoryLength() === 'number', 'history usable for ' + JSON.stringify(junk));
    }
});

T.run('migration fills missing keys and drops obsolete ones', () => {
    let [sm, dir] = fresh(JSON.stringify({
        version: 1, paused: true, syncMode: true, intervalMinutes: 3,
        monitors: { 'DP-1': { currentImage: '/a.jpg', folders: ['/x'], scaling: 'zoom' } }
    }));
    T.eq(sm.isPaused(), true, 'existing value kept');
    T.eq(sm.getMonitorRecord('DP-1').currentImage, '/a.jpg');
    sm.saveSync();
    let [, raw] = GLib.file_get_contents(dir + '/state.json');
    let obj = JSON.parse(new TextDecoder().decode(raw));
    T.eq('syncMode' in obj, false, 'obsolete syncMode dropped');
    T.eq('intervalMinutes' in obj, false, 'obsolete intervalMinutes dropped');
    T.eq(obj.pausedMonitors, [], 'missing pausedMonitors added');
    T.eq(obj.history, [], 'missing history added');
});

T.run('history is capped at 100, newest last, getHistoryAt indexes from the tip', () => {
    let [sm] = fresh();
    for (let i = 0; i < 130; i++) sm.pushHistory({ 'DP-1': '/img' + i + '.jpg' });
    T.eq(sm.getHistoryLength(), 100);
    T.eq(sm.getHistoryAt(0).monitors['DP-1'], '/img129.jpg', 'tip');
    T.eq(sm.getHistoryAt(99).monitors['DP-1'], '/img30.jpg', 'oldest kept');
    T.eq(sm.getHistoryAt(100), null, 'beyond range');
});

T.run('per-monitor pause and trashed paths are idempotent', () => {
    let [sm] = fresh();
    sm.setMonitorPaused('DP-1', true); sm.setMonitorPaused('DP-1', true);
    T.eq(sm.isMonitorPaused('DP-1'), true);
    sm.setMonitorPaused('DP-1', false);
    T.eq(sm.isMonitorPaused('DP-1'), false);
    sm.addTrashedPath('/t.jpg'); sm.addTrashedPath('/t.jpg');
    T.eq(sm.getTrashedPaths(), ['/t.jpg']);
});

T.runAsync('debounced save() writes within ~1 s and survives a reload', done => {
    let [sm, dir] = fresh();
    sm.setMonitorCurrentImage('HDMI-1', '/cur.png');
    sm.setPaused(true);           // triggers save()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
        let sm2 = new StateManager(dir); sm2.load();
        T.eq(sm2.isPaused(), true, 'paused persisted');
        T.eq(sm2.getMonitorRecord('HDMI-1').currentImage, '/cur.png', 'current image persisted');
        done();
        return GLib.SOURCE_REMOVE;
    });
});

imports.system.exit(T.summary());
