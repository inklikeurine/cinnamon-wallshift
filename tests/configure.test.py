#!/usr/bin/python3
"""configure.py (0.2.0, built from Cinnamon's settings widgets): settings-file
resolution and seeding, URI normalisation, monitor-config writes, launch
arguments, and — with a display — the window itself: Cinnamon's layout, the
schema-built General page, the one-row interval, Sync greying, live monitor
tabs, ☰ actions. HOME is a temp dir; the DBus side is stubbed out so nothing
reaches the running Cinnamon."""
import importlib.util, json, os, sys, tempfile

APPLET = sys.argv[1]
UUID = 'wallshift@inklikeurine'
fails = 0
def check(cond, msg):
    global fails
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond: fails += 1

home = tempfile.mkdtemp(prefix='wallshift-cfg-')
os.environ['HOME'] = home

spec = importlib.util.spec_from_file_location('cfg', os.path.join(APPLET, 'configure.py'))
cfg = importlib.util.module_from_spec(spec); spec.loader.exec_module(cfg)
check(cfg._WIDGETS_ERROR is None, f"Cinnamon's settings widgets import ({cfg._WIDGETS_ERROR})")

print('settings path')
check(cfg._is_multi_instance() is False, 'max-instances 1 → single instance')
check(cfg._instance_key(UUID, 74) == UUID, 'instance key is the uuid')
path = cfg._settings_path(UUID, 74)
check(path == f'{home}/.config/cinnamon/spices/{UUID}/{UUID}.json', 'new-style path')
os.makedirs(f'{home}/.cinnamon/configs/{UUID}', exist_ok=True)
open(f'{home}/.cinnamon/configs/{UUID}/{UUID}.json', 'w').write('{}')
check(cfg._settings_path(UUID, 74).startswith(f'{home}/.cinnamon/configs/'), 'legacy path honoured when new file absent')
os.remove(f'{home}/.cinnamon/configs/{UUID}/{UUID}.json')

print('_ensure_settings_file')
check(cfg._ensure_settings_file(UUID, 74) == path, 'returns the settings path')
d = json.load(open(path))
check(d['interval-minutes']['value'] == 5 and d['favorites-folder']['type'] == 'filechooser', 'seeded from the schema')
del d['carousel-edge']; d['interval-minutes']['value'] = 9; d['__md5__'] = 'abc'
json.dump(d, open(path, 'w'))
cfg._ensure_settings_file(UUID, 74)
d = json.load(open(path))
check(d['carousel-edge']['value'] == 'bottom', 'a key missing from the file is added with its default')
check(d['interval-minutes']['value'] == 9 and d['__md5__'] == 'abc', 'existing values kept')

print('_to_path')
for raw, want in [
    ('file:///home/u/Wallpaper%20Favorites', '/home/u/Wallpaper Favorites'),
    ('file:///home/u/plain', '/home/u/plain'),
    ('/home/u/plain', '/home/u/plain'),
    ('~/Pics', f'{home}/Pics'),
    ('', ''), (None, ''),
]:
    check(cfg._to_path(raw) == want, f'{raw!r} → {want!r}')

print('monitor-config.json')
check(cfg._load_monitor_config() == {'monitors': {}}, 'missing → empty')
os.makedirs(os.path.dirname(cfg._monitor_config_path()), exist_ok=True)
open(cfg._monitor_config_path(), 'w').write('{{{ corrupt')
check(cfg._load_monitor_config() == {'monitors': {}}, 'corrupt → empty')
open(cfg._monitor_config_path(), 'w').write('[1, 2]')
check(cfg._load_monitor_config() == {'monitors': {}}, 'wrong shape → empty')
os.remove(cfg._monitor_config_path())

print('schema (labels come from settings-schema.json now)')
schema = json.load(open(os.path.join(APPLET, 'settings-schema.json')))
check(schema['layout']['page-general']['sections'][0] == 'section-folders', 'Folders first (S1)')
for key, label in (('global-folder', 'Wallpaper folder'), ('interval-minutes', 'Change every'),
                   ('sync-mode', 'Same image on all monitors'), ('detection-interval-minutes', 'Every')):
    check(schema[key]['description'] == label, f'{key}: "{label}"')
check(schema['detection-interval-minutes'].get('dependency') == 'detection-poll-enabled', 're-check interval depends on the switch (S7)')

if os.environ.get('DISPLAY'):
    from gi.repository import Gtk, GLib
    def pump(ms=0):
        if ms:
            loop = GLib.MainLoop(); GLib.timeout_add(ms, lambda: loop.quit() or False); loop.run()
        while Gtk.events_pending(): Gtk.main_iteration()
    def file_value(key):
        return json.load(open(path))[key]['value']

    cfg._SettingsWindow._connect_cinnamon = lambda self: None   # never talk to the real Cinnamon
    fake = [{'name': 'Test Monitor', 'connector': 'TEST-1', 'index': 0}]
    cfg._detect_monitors = lambda: list(fake)

    print('window (display available)')
    win = cfg._SettingsWindow(UUID, '74')
    pump()
    check(type(win._win).__name__ == 'GtkWindow' and win._win.__gtype__.name == 'XAppGtkWindow', 'XApp.GtkWindow, as Cinnamon')
    check(win._win.get_title() == 'Wallshift', 'title is the applet name')
    toolbar = win._win.get_child().get_children()[0]
    check(toolbar.get_style_context().has_class('primary-toolbar'), 'primary toolbar')
    check(win._switcher.get_stack() is win._stack, 'page switcher in the toolbar')
    names = [win._stack.child_get_property(c, 'name') for c in win._stack.get_children()]
    check(names == ['page-general', 'monitor-TEST-1'], f'pages: {names}')
    check(win._stack.get_visible_child_name() == 'page-general', 'opens on General')
    check(win._stack.child_get_property(win._monitor_pages['TEST-1'], 'title') == 'Test Monitor (TEST-1)', 'monitor tab title')

    general = win._stack.get_child_by_name('page-general')
    titles = []
    for section in general.get_children():
        header = section.get_children()[0]
        titles += [l.get_text() for l in header.get_children() if isinstance(l, Gtk.Label)]
    check(titles == ['Folders', 'Rotation', 'Carousel', 'Monitors'], f'sections: {titles}')
    kinds = set()
    def walk(w):
        kinds.add(type(w).__name__)
        if isinstance(w, Gtk.Container):
            for c in w.get_children(): walk(c)
    walk(general)
    check({'NewClass', 'IntervalRow', 'SettingsRevealer', 'JSONSettingsRevealer', 'Button'} <= kinds,
          'built from Cinnamon widgets (JSON rows, revealers, button row)')

    print('interval row (S2) and its note')
    row = win._interval
    check(len(row.spins) == 2, 'minutes and seconds on one row')
    row.spins['interval-minutes'].set_value(0); row.spins['interval-seconds'].set_value(5)
    pump()
    check(win._interval_note.get_reveal_child(), 'under 10 s: the minimum note shows')
    check(file_value('interval-minutes') == 9, 'nothing saved while still changing (300 ms, as Cinnamon)')
    pump(450)
    check(file_value('interval-minutes') == 0 and file_value('interval-seconds') == 5, 'saved after the pause')
    row.spins['interval-seconds'].set_value(30); pump()
    check(not win._interval_note.get_reveal_child(), '10 s or more: note hidden')

    print('dependencies and Sync')
    reveal = [w for w in general.get_children()[3].frame.get_child().get_children() if isinstance(w, Gtk.Revealer)]
    win._settings.set_value('detection-poll-enabled', False); pump()
    check(reveal and not reveal[0].get_reveal_child(), 're-check off hides its interval row')
    win._settings.set_value('detection-poll-enabled', True); pump()
    check(reveal[0].get_reveal_child(), 're-check on shows it')
    folder, note, _show, _c = win._folder_rows[0]
    win._settings.set_value('sync-mode', True); pump()
    check(not folder.get_sensitive() and 'Sync mode' in note.get_text(), 'Sync greys monitor folders with a note (S4)')
    win._settings.set_value('sync-mode', False); pump()
    check(folder.get_sensitive() and note.get_text() == 'Uses the default folder', 'Sync off: back, default-folder note')

    print('per-monitor rows')
    win._set_monitor('TEST-1', 'folder', '/w'); win._set_monitor('TEST-1', 'scaling', 'fit')
    win._clear_monitor('TEST-1', 'folder')
    check(json.load(open(cfg._monitor_config_path()))['monitors']['TEST-1'] == {'scaling': 'fit'}, 'clear drops only the folder (S3)')

    print('live monitor tabs')
    win._stack.set_visible_child_name('monitor-TEST-1')
    fake.append({'name': 'TEST-2', 'connector': 'TEST-2', 'index': 1})
    win._sync_monitor_pages(); pump()
    names = [win._stack.child_get_property(c, 'name') for c in win._stack.get_children()]
    check(names == ['page-general', 'monitor-TEST-1', 'monitor-TEST-2'], 'plugged in: tab added after the others')
    check(win._stack.child_get_property(win._monitor_pages['TEST-2'], 'title') == 'TEST-2', 'no EDID name: connector only')
    del fake[0]
    win._sync_monitor_pages(); pump()
    names = [win._stack.child_get_property(c, 'name') for c in win._stack.get_children()]
    check(names == ['page-general', 'monitor-TEST-2'], 'unplugged: its tab removed')
    check(win._stack.get_visible_child_name() == 'page-general', 'the open tab was removed: General shown')
    check([r[3] for r in win._folder_rows] == ['TEST-2'], 'its folder row forgotten')

    print('☰ menu: reset to defaults, and close')
    win._reset(); pump()
    check(file_value('interval-minutes') == 5 and row.spins['interval-minutes'].get_value() == 5, 'reset: file and row back to defaults')
    row.spins['interval-minutes'].set_value(12)
    win._win.destroy(); pump()
    check(file_value('interval-minutes') == 12, 'a pending change is saved when the window closes')
else:
    print('window checks: skipped (no DISPLAY)')

print('launch arguments (0.0.4 B6)')
check(cfg._parse_args(['configure.py', UUID, '74']) == (UUID, '74'), 'applet Configure item: uuid + instance id')
check(cfg._parse_args(['configure.py']) == (UUID, None), 'System Settings: no arguments → uuid from metadata.json')
check(cfg._instance_key(*cfg._parse_args(['configure.py'])) == UUID, 'no-argument launch writes the same settings file')
meta = json.load(open(os.path.join(APPLET, 'metadata.json')))
app = os.path.join(APPLET, meta.get('external-configuration-app', ''))
check(meta.get('external-configuration-app') == 'configure.py', 'metadata names configure.py as the settings app')
check(os.access(app, os.X_OK), 'configure.py is executable (System Settings runs it directly)')
check(open(app).readline().strip() == '#!/usr/bin/python3', 'shebang is /usr/bin/python3')

print(('PASSED' if fails == 0 else 'FAILED') + f' ({fails} failures)')
sys.exit(1 if fails else 0)
