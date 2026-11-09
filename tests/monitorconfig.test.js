// MonitorConfig.js (0.2.3) against the shared samples that configure.test.py also
// reads: EDID monitor names (fixtures/edid/), sysfs candidates, and
// monitor-config.json parsing + per-monitor settings (fixtures/monitor-config/).
// If this suite and configure.test.py both pass, the applet and the settings
// window agree on every sample.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const GLib = imports.gi.GLib;
const require = T.makeRequire(ARGV[0]);
const MC = require('./modules/MonitorConfig');

const edid = T.fixtureJson('edid/expected.json');

T.run('EDID monitor name from every sample file', () => {
    for (const [file, want] of Object.entries(edid.names)) {
        const [ok, data] = GLib.file_get_contents(T.fixturesDir() + '/edid/' + file);
        T.ok(ok && data.length === 128, file + ': 128 bytes');
        T.eq(MC.parseEdidName(data), want, file);
    }
});

T.run('sysfs candidates for a connector', () => {
    for (const [connector, want] of Object.entries(edid.candidates))
        T.eq(MC.edidCandidates(connector), want, connector);
});

const cases = T.fixtureJson('monitor-config/cases.json').cases;

T.run('monitor-config.json: every sample parses to the expected config', () => {
    for (const c of cases)
        T.eq(MC.parse(c.text === null ? '' : c.text), c.config, c.name);
});

T.run('per-monitor settings resolve the same as in the settings window', () => {
    for (const c of cases) {
        const cfg = MC.parse(c.text === null ? '' : c.text);
        for (const [mon, want] of Object.entries(c.overrides))
            T.eq(MC.monitorOverrides(cfg, mon), want, c.name + ' / ' + mon);
    }
});

T.run('MonitorConfig knows the same scaling modes as the Compositor', () => {
    const src = T.readFile(ARGV[0] + '/modules/Compositor.js');
    const block = src.slice(src.indexOf('SCALING_TO_PICTURE_OPTIONS = {'), src.indexOf('};', src.indexOf('SCALING_TO_PICTURE_OPTIONS = {')));
    const keys = [...block.matchAll(/'([a-z]+)':/g)].map(m => m[1]);
    T.eq(MC.SCALING_MODES, keys);
});

T.exit();
