#!/usr/bin/python3
"""
Wallshift configure.py — the applet's one settings window.
Opened by applet.js configureApplet() and by System Settings → Applets
(metadata.json "external-configuration-app").

Usage: /usr/bin/python3 configure.py [<uuid> <instance_id>]

Built from Cinnamon's own settings code, so it looks and behaves like every
other applet's settings: the window, toolbar, page switcher and ☰ menu are laid
out as in cinnamon-settings/xlet-settings.py, the General page is generated
from settings-schema.json with Cinnamon's JSON settings widgets, and the
monitor pages use the same XApp row widgets. It is a separate program only
because the monitor pages are made at run time — one per connected monitor,
named after it, added and removed as monitors come and go — which
settings-schema.json cannot describe. Per-monitor values live in
~/.local/share/wallshift/monitor-config.json, which the applet watches.

Strings are translated through the applet's gettext domain (po/); the ☰ menu
uses Cinnamon's own translations.
"""

import sys
import os
import json
import gettext

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('XApp', '1.0')
from gi.repository import Gtk, Gdk, Gio, GLib, XApp

# Cinnamon's settings widgets, imported the way xlet-settings.py imports them.
_CINNAMON_SETTINGS = '/usr/share/cinnamon/cinnamon-settings'
for _p in (_CINNAMON_SETTINGS, os.path.join(_CINNAMON_SETTINGS, 'bin')):
    if _p not in sys.path:
        sys.path.insert(0, _p)
try:
    from JsonSettingsWidgets import (JSONSettingsHandler, JSONSettingsRevealer, JSONSettingsSwitch,
                                     JSONSettingsSpinButton, JSONSettingsComboBox, JSONSettingsFileChooser,
                                     SettingsStack, SettingsPage, SettingsWidget, SettingsLabel,
                                     SettingsRevealer, Switch, ComboBox, FileChooser, Button, Text)
    _WIDGETS_ERROR = None
except Exception as e:   # not a Cinnamon 6.6 system
    _WIDGETS_ERROR = e

_tr = gettext.translation('wallshift@inklikeurine',
                          localedir=os.path.expanduser('~/.local/share/locale'), fallback=True)
_ = _tr.gettext


def _c(text):
    """Cinnamon's own translation, for the strings its settings window shows."""
    return gettext.dgettext('cinnamon', text)


# ──────────────────────────────────────────────────────────────────────────────
# Settings file
#
# Cinnamon (js/ui/settings.js, _ensureSettingsFiles) keeps an xlet's AppletSettings at
#     ~/.config/cinnamon/spices/<uuid>/<instanceKey>.json
# where <instanceKey> is the *uuid* for single-instance xlets (max-instances == 1)
# and the numeric instance id otherwise. A legacy location, ~/.cinnamon/configs/,
# is honoured only when the new file does not exist. The same <instanceKey> goes to
# org.Cinnamon.updateSetting — Cinnamon registers the AppletSettings object under
# it, and remoteUpdate() re-reads that file.
# ──────────────────────────────────────────────────────────────────────────────

_APPLET_DIR = os.path.dirname(os.path.abspath(__file__))


def _metadata():
    try:
        with open(os.path.join(_APPLET_DIR, "metadata.json")) as f:
            return json.load(f)
    except Exception:
        return {}


def _is_multi_instance():
    try:
        return int(_metadata().get("max-instances", 1)) != 1
    except (TypeError, ValueError):
        return False


def _instance_key(uuid, instance_id):
    return str(instance_id) if _is_multi_instance() else uuid


def _settings_path(uuid, instance_id):
    key = _instance_key(uuid, instance_id)
    new = os.path.expanduser(f"~/.config/cinnamon/spices/{uuid}/{key}.json")
    old = os.path.expanduser(f"~/.cinnamon/configs/{uuid}/{key}.json")
    if os.path.exists(old) and not os.path.exists(new):
        return old
    return new


def _schema():
    try:
        with open(os.path.join(_APPLET_DIR, "settings-schema.json")) as f:
            return json.load(f)
    except Exception:
        return {}


def _ensure_settings_file(uuid, instance_id):
    """The settings file, created or completed from the schema the way Cinnamon
    seeds it (every key gets value = default) when the applet has not run since
    a key was added. Returns its path."""
    path = _settings_path(uuid, instance_id)
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        data = {}
    changed = not data
    for key, entry in _schema().items():
        if key not in data and isinstance(entry, dict):
            entry = dict(entry)
            if "default" in entry:
                entry["value"] = entry["default"]
            data[key] = entry
            changed = True
    if changed:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
    return path


def _to_path(value):
    """Folder value → plain filesystem path (mirrors normalizePath() in applet.js).
    Cinnamon's file chooser stores percent-encoded file:// URIs, older Wallshift
    versions plain paths."""
    if not value:
        return ''
    value = value.strip()
    if value.startswith('file:'):
        try:
            path, _host = GLib.filename_from_uri(value)
            if path:
                return path
        except Exception:
            pass
        from urllib.parse import unquote
        return unquote(value.replace('file://localhost', '', 1).replace('file://', '', 1))
    if value == '~' or value.startswith('~/'):
        return os.path.expanduser(value)
    return value


# ──────────────────────────────────────────────────────────────────────────────
# monitor-config.json
# ──────────────────────────────────────────────────────────────────────────────

def _monitor_config_path():
    return os.path.expanduser("~/.local/share/wallshift/monitor-config.json")


def _load_monitor_config():
    try:
        with open(_monitor_config_path()) as f:
            cfg = json.load(f)
        if isinstance(cfg, dict) and isinstance(cfg.get("monitors"), dict):
            return cfg
    except Exception:
        pass
    return {"monitors": {}}


def _save_monitor_config(cfg):
    path = _monitor_config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(cfg, f, indent=2)


# ──────────────────────────────────────────────────────────────────────────────
# Monitor detection — the same names MonitorManager.js shows
# ──────────────────────────────────────────────────────────────────────────────

def _parse_edid_monitor_name(data):
    """Scan EDID descriptor blocks for the Monitor Name descriptor (tag 0xFC)."""
    for block in range(4):
        o = 54 + block * 18
        if data[o] == 0x00 and data[o + 1] == 0x00 and data[o + 2] == 0x00 and data[o + 3] == 0xFC:
            name = ''
            for j in range(5, 18):
                c = data[o + j]
                if c == 0x0A:
                    break
                if 0x20 <= c < 0x7F:
                    name += chr(c)
            return name.strip() or None
    return None


def _read_edid_name(connector):
    """Friendly name from /sys/class/drm — same logic as MonitorManager.js."""
    import re
    candidates = [connector]
    m = re.match(r'^HDMI-(\d+)$', connector)
    if m:
        candidates += [f'HDMI-A-{m.group(1)}', f'HDMI-B-{m.group(1)}']
    for card in range(4):
        for cand in candidates:
            try:
                with open(f'/sys/class/drm/card{card}-{cand}/edid', 'rb') as f:
                    data = f.read()
                if len(data) < 128:
                    continue
                name = _parse_edid_monitor_name(data)
                if name:
                    return name
            except Exception:
                pass
    return None


def _detect_monitors():
    """[{name, connector, index}] in display order — mirrors MonitorManager.js."""
    display = Gdk.Display.get_default()
    screen = Gdk.Screen.get_default()
    monitors = []
    for i in range(display.get_n_monitors()):
        mon = display.get_monitor(i)
        connector = None
        try:
            connector = mon.get_connector()
        except Exception:
            pass
        if not connector:
            try:
                connector = screen.get_monitor_plug_name(i)
            except Exception:
                pass
        connector = connector or f'Monitor-{i}'
        monitors.append({"name": _read_edid_name(connector) or connector, "connector": connector, "index": i})
    return monitors


def _monitor_title(mon):
    return mon["name"] if mon["name"] == mon["connector"] else f'{mon["name"]} ({mon["connector"]})'


# ──────────────────────────────────────────────────────────────────────────────
# Rows that settings-schema.json cannot describe
# ──────────────────────────────────────────────────────────────────────────────

_INTERVAL_KEYS = ('interval-minutes', 'interval-seconds')
_SCALING = (("zoom", "Zoom"), ("fit", "Fit"), ("stretch", "Stretch"), ("center", "Center"), ("tile", "Tile"))
_SAVE_DELAY_MS = 300   # as Cinnamon's SpinButton: save once the clicking stops


if _WIDGETS_ERROR is None:
    class IntervalRow(SettingsWidget):
        """'Change every [m] min [s] s' on one row, built like Cinnamon's SpinButton
        row (label first, spin buttons at the end, saved 300 ms after the last change)."""

        def __init__(self, settings, label, on_change=None):
            super().__init__()
            self._settings = settings
            self._on_change = on_change
            self._timers = {}
            self.label = SettingsLabel(label)
            self.pack_start(self.label, False, False, 0)
            self.content_widget = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            self.spins = {}
            for key, units in (('interval-minutes', _("min")), ('interval-seconds', _("s"))):
                spin = Gtk.SpinButton(valign=Gtk.Align.CENTER)
                lo = settings.get_property(key, "min") if settings.has_property(key, "min") else 0
                hi = settings.get_property(key, "max") if settings.has_property(key, "max") else 59
                spin.set_range(lo, hi)
                spin.set_increments(1, 1)
                spin.set_digits(0)
                spin.set_value(settings.get_value(key))
                spin.connect("value-changed", self._apply_later, key)
                self.content_widget.pack_start(spin, False, False, 0)
                self.content_widget.pack_start(Gtk.Label(label=units), False, False, 0)
                self.spins[key] = spin
                settings.listen(key, self._on_setting_changed)
            self.pack_end(self.content_widget, False, False, 0)

        def total_seconds(self):
            return int(self.spins['interval-minutes'].get_value()) * 60 + int(self.spins['interval-seconds'].get_value())

        def _apply_later(self, spin, key):
            if self._on_change:
                self._on_change(self)
            if self._timers.get(key):
                GLib.source_remove(self._timers[key])

            def apply():
                self._timers[key] = 0
                self._settings.set_value(key, int(spin.get_value()))
                return GLib.SOURCE_REMOVE
            self._timers[key] = GLib.timeout_add(_SAVE_DELAY_MS, apply)

        def flush(self):
            for key, tid in list(self._timers.items()):
                if tid:
                    GLib.source_remove(tid)
                    self._timers[key] = 0
                    self._settings.set_value(key, int(self.spins[key].get_value()))

        def _on_setting_changed(self, key, value):
            spin = self.spins.get(key)
            if spin is not None and value is not None and int(spin.get_value()) != int(value):
                spin.set_value(value)


# ──────────────────────────────────────────────────────────────────────────────
# Main window — xlet-settings.py's layout
# ──────────────────────────────────────────────────────────────────────────────

_WIDGETS = {
    "switch": "JSONSettingsSwitch",
    "spinbutton": "JSONSettingsSpinButton",
    "combobox": "JSONSettingsComboBox",
    "filechooser": "JSONSettingsFileChooser",
}


class _SettingsWindow:

    def __init__(self, uuid, instance_id, app=None):
        self._uuid = uuid
        self._key = _instance_key(uuid, instance_id)
        self._proxy = None
        self._settings = JSONSettingsHandler(_ensure_settings_file(uuid, instance_id), uuid, self._key, self._notify)
        self._schema = _schema()
        self._mon_cfg = _load_monitor_config()
        self._monitor_pages = {}      # connector → SettingsPage
        self._folder_rows = []        # (widget, note label, show_state) greyed out in Sync mode
        self._interval = None
        self._schema_pages = 0
        self._monitors_timer = 0

        self._win = XApp.GtkWindow()
        if app is not None:
            self._win.set_application(app)
        self._win.set_default_size(800, 600)
        self._win.set_title(_(_metadata().get("name", "Wallshift")))
        icon = os.path.join(_APPLET_DIR, "icon.png")
        if os.path.exists(icon):
            self._win.set_icon_from_file(icon)

        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self._win.add(main_box)
        main_box.add(self._build_toolbar())

        self._scw = Gtk.ScrolledWindow()
        self._scw.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.NEVER)
        main_box.pack_start(self._scw, True, True, 0)
        instance_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self._scw.add(instance_box)
        self._stack = SettingsStack()
        instance_box.pack_start(self._stack, True, True, 0)
        self._switcher.set_stack(self._stack)

        self._build_schema_pages()
        self._sync_monitor_pages()
        self._settings.listen("sync-mode", lambda _k, v: self._show_sync(bool(v)))

        Gdk.Screen.get_default().connect("monitors-changed", self._on_monitors_changed)
        self._win.connect("realize", self._check_sizing)
        self._win.connect("destroy", self._on_destroy)

        self._win.show_all()
        # A Gtk.Stack shows the first child that became visible: the monitor
        # pages are shown before the window is, so pick the first page here.
        children = self._stack.get_children()
        if children:
            self._stack.set_visible_child(children[0])
        self._show_sync(bool(self._settings.get_value("sync-mode")))
        self._show_interval_note()
        self._connect_cinnamon()

    def present(self):
        self._win.present()

    # ── Toolbar: page switcher in the middle, ☰ on the right ─────────────────

    def _build_toolbar(self):
        toolbar = Gtk.Toolbar()
        toolbar.get_style_context().add_class("primary-toolbar")
        toolbar.set_show_arrow(False)
        toolitem = Gtk.ToolItem()
        toolitem.set_expand(True)
        toolbar.add(toolitem)
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        toolitem.add(box)

        self._switcher = Gtk.StackSwitcher()
        box.set_center_widget(self._switcher)

        menu_button = Gtk.MenuButton()
        menu_button.add(Gtk.Image.new_from_icon_name("xsi-open-menu-symbolic", Gtk.IconSize.BUTTON))
        menu_button.set_tooltip_text(_c("More options"))
        box.pack_end(menu_button, False, False, 0)

        menu = Gtk.Menu()
        menu.set_halign(Gtk.Align.END)
        for label, handler in ((_c("Import from a file"), self._import),
                               (_c("Export to a file"), self._export),
                               (_c("Reset to defaults"), self._reset),
                               (None, None),
                               (_c("Reload %s") % self._uuid, self._reload)):
            item = Gtk.SeparatorMenuItem() if label is None else Gtk.MenuItem(label=label)
            if handler:
                item.connect("activate", handler)
            item.show()
            menu.append(item)
        menu_button.set_popup(menu)
        return toolbar

    def _check_sizing(self, *_a):
        natreq = self._win.get_preferred_size()[1]
        monitor = Gdk.Display.get_default().get_monitor_at_window(self._win.get_window())
        if natreq.height > monitor.get_workarea().height - 100:
            self._win.resize(800, 600)
            self._scw.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)

    # ── Pages from settings-schema.json ──────────────────────────────────────

    def _build_schema_pages(self):
        layout = self._schema.get("layout", {})
        for page_key in layout.get("pages", []):
            page_def = layout[page_key]
            page = SettingsPage()
            for section_key in page_def.get("sections", []):
                section_def = layout[section_key]
                section = page.add_section(_(section_def.get("title", "")))
                for key in section_def.get("keys", []):
                    self._add_key(section, key)
                if section_key == "section-monitors":
                    refresh = Button(_("Refresh Monitors"), callback=self._on_refresh_monitors)
                    refresh.set_tooltip_text(_("Apply a port or monitor change now"))
                    section.add_row(refresh)
            self._stack.add_titled(page, page_key, _(page_def.get("title", "")))
            self._schema_pages += 1

    def _add_key(self, section, key):
        if not self._settings.has_key(key) or key not in self._schema:
            return
        if key == 'interval-seconds':
            return   # shown in the interval row
        item = self._schema[key]
        if key == 'interval-minutes':
            self._interval = IntervalRow(self._settings, _(item.get("description", "")),
                                         on_change=lambda _r: self._show_interval_note())
            if item.get("tooltip"):
                self._interval.set_tooltip_text(_(item["tooltip"]))
            section.add_row(self._interval)
            self._interval_note = SettingsRevealer()
            section.add_reveal_row(Text(_("The minimum is 10 seconds, so Wallshift will use 10 s.")),
                                   revealer=self._interval_note)
            return
        cls = _WIDGETS.get(item.get("type"))
        if cls is None:
            return
        props = {}
        for prop, value in item.items():
            if prop in ("description", "tooltip", "units"):
                props[prop] = _(value)
            elif prop == "options":
                props[prop] = {_(label): val for label, val in value.items()}
            else:
                props[prop] = value
        widget = globals()[cls](key, self._settings, props)
        if "dependency" in item:
            section.add_reveal_row(widget, revealer=JSONSettingsRevealer(self._settings, item["dependency"]))
        else:
            section.add_row(widget)

    def _show_interval_note(self):
        if self._interval is not None:
            self._interval_note.set_reveal_child(self._interval.total_seconds() < 10)

    # ── One page per connected monitor, kept in step with the screen ─────────

    def _on_monitors_changed(self, *_a):
        # Connector names and EDID files settle a moment after the change.
        if self._monitors_timer:
            GLib.source_remove(self._monitors_timer)
        self._monitors_timer = GLib.timeout_add(500, self._sync_monitor_pages)

    def _sync_monitor_pages(self):
        self._monitors_timer = 0
        monitors = _detect_monitors()
        wanted = [m["connector"] for m in monitors]
        for connector in [c for c in self._monitor_pages if c not in wanted]:
            page = self._monitor_pages.pop(connector)
            self._folder_rows = [r for r in self._folder_rows if r[3] != connector]
            if self._stack.get_visible_child() is page:
                self._stack.set_visible_child(self._stack.get_children()[0])
            self._stack.remove(page)
        for position, mon in enumerate(monitors):
            page = self._monitor_pages.get(mon["connector"])
            if page is None:
                page = self._monitor_page(mon)
                self._monitor_pages[mon["connector"]] = page
                self._stack.add_titled(page, "monitor-" + mon["connector"], _monitor_title(mon))
                page.show_all()
            # Monitor pages follow the schema pages, in display order.
            self._stack.child_set_property(page, "position", self._schema_pages + position)
        self._show_sync(bool(self._settings.get_value("sync-mode")))
        return GLib.SOURCE_REMOVE

    def _monitor_page(self, mon):
        connector = mon["connector"]
        overrides = self._mon_cfg.setdefault("monitors", {}).get(connector, {})
        page = SettingsPage()
        section = page.add_section(_monitor_title(mon))

        enabled = Switch(_("Enabled"))
        enabled.content_widget.set_active(overrides.get("enabled", True) is not False)
        enabled.content_widget.connect("notify::active",
                                       lambda w, _p: self._set_monitor(connector, "enabled", w.get_active()))
        section.add_row(enabled)

        scaling = ComboBox(_("Scaling"), options=[(value, _(label)) for value, label in _SCALING])
        current = overrides.get("scaling", "zoom")
        scaling.content_widget.set_active_iter(scaling.option_map.get(current, scaling.option_map["zoom"]))

        def on_scaling(combo):
            it = combo.get_active_iter()
            if it is not None:
                self._set_monitor(connector, "scaling", scaling.model[it][0])
        scaling.content_widget.connect("changed", on_scaling)
        section.add_row(scaling)

        # Folder: Cinnamon's file chooser row plus a button that drops the override.
        folder = FileChooser(_("Wallpaper folder"), dir_select=True)
        clear = Gtk.Button.new_from_icon_name("edit-clear-symbolic", Gtk.IconSize.BUTTON)
        clear.set_tooltip_text(_("Use the default folder"))
        clear.set_valign(Gtk.Align.CENTER)
        folder.remove(folder.content_widget)
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        box.pack_start(folder.content_widget, False, False, 0)
        box.pack_start(clear, False, False, 0)
        folder.pack_end(box, False, False, 0)
        section.add_row(folder)
        note = section.add_note("")
        note.get_style_context().add_class("dim-label")
        state = {"path": _to_path(overrides.get("folder", ""))}
        if state["path"]:
            folder.content_widget.set_filename(state["path"])

        def show_state():
            clear.set_sensitive(bool(state["path"]))
            note.set_text("" if state["path"] else _("Uses the default folder"))
            note.set_visible(not state["path"])

        def on_folder_set(w):
            state["path"] = w.get_filename() or ""
            self._set_monitor(connector, "folder", state["path"])
            show_state()

        def on_clear(_b):
            folder.content_widget.unselect_all()
            state["path"] = ""
            self._clear_monitor(connector, "folder")
            show_state()

        folder.content_widget.connect("file-set", on_folder_set)
        clear.connect("clicked", on_clear)
        self._folder_rows.append((folder, note, show_state, connector))
        return page

    # Sync mode shows the default folder on every monitor: the per-monitor
    # folder rows are greyed out with a note instead of being silently ignored.
    def _show_sync(self, sync_on):
        for widget, note, show_state, _connector in self._folder_rows:
            widget.set_sensitive(not sync_on)
            if sync_on:
                note.set_text(_("Sync mode uses the default folder on every monitor."))
                note.set_visible(True)
            else:
                show_state()

    def _set_monitor(self, connector, field, value):
        self._mon_cfg.setdefault("monitors", {}).setdefault(connector, {})[field] = value
        _save_monitor_config(self._mon_cfg)

    def _clear_monitor(self, connector, field):
        mon = self._mon_cfg.get("monitors", {}).get(connector)
        if mon and field in mon:
            del mon[field]
            _save_monitor_config(self._mon_cfg)

    def _on_refresh_monitors(self, button):
        """The applet watches monitor-config.json: a new refreshToken makes it
        re-detect monitors and recompose. The button confirms briefly."""
        self._mon_cfg["refreshToken"] = GLib.get_real_time()
        _save_monitor_config(self._mon_cfg)
        button.content_widget.set_sensitive(False)
        button.set_label(_("Refreshed ✓"))

        def restore():
            button.set_label(_("Refresh Monitors"))
            button.content_widget.set_sensitive(True)
            return GLib.SOURCE_REMOVE
        GLib.timeout_add_seconds(2, restore)

    # ── Cinnamon: setting updates, panel highlight, ☰ menu ───────────────────

    def _connect_cinnamon(self):
        try:
            proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, None,
                                                   "org.Cinnamon", "/org/Cinnamon", "org.Cinnamon", None)
            self._proxy = proxy if proxy.get_name_owner() else None
        except GLib.Error:
            self._proxy = None
        self._highlight(True)

    def _highlight(self, on):
        if self._proxy:
            try:
                self._proxy.highlightXlet('(ssb)', self._uuid, self._key, on)
            except GLib.Error:
                pass

    def _notify(self, handler, key, value):
        if self._proxy:
            try:
                self._proxy.updateSetting('(ssss)', self._uuid, handler.instance_id, key, json.dumps(value))
            except GLib.Error:
                pass   # the applet is not running; the value is in the file for its next start

    def _import(self, *_a):
        dialog = Gtk.FileChooserDialog(_c("Select a JSON file to import"), self._win, Gtk.FileChooserAction.OPEN,
                                       (Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL, Gtk.STOCK_OPEN, Gtk.ResponseType.OK))
        dialog.add_filter(self._json_filter())
        if dialog.run() == Gtk.ResponseType.OK:
            self._settings.load_from_file(dialog.get_filename())
        dialog.destroy()

    def _export(self, *_a):
        dialog = Gtk.FileChooserDialog(_c("Select or enter file to export to"), self._win, Gtk.FileChooserAction.SAVE,
                                       (Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL, Gtk.STOCK_SAVE, Gtk.ResponseType.ACCEPT))
        dialog.set_do_overwrite_confirmation(True)
        dialog.add_filter(self._json_filter())
        if dialog.run() == Gtk.ResponseType.ACCEPT:
            filename = dialog.get_filename()
            self._settings.save_to_file(filename if filename.endswith(".json") else filename + ".json")
        dialog.destroy()

    def _json_filter(self):
        f = Gtk.FileFilter()
        f.add_pattern("*.json")
        f.set_name(_c("JSON files"))
        return f

    def _reset(self, *_a):
        self._settings.reset_to_defaults()

    def _reload(self, *_a):
        if self._proxy:
            try:
                self._proxy.ReloadXlet('(ss)', self._uuid, "APPLET")
            except GLib.Error:
                pass

    def _on_destroy(self, *_a):
        if self._interval is not None:
            self._interval.flush()
        if self._monitors_timer:
            GLib.source_remove(self._monitors_timer)
            self._monitors_timer = 0
        self._highlight(False)


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

_APP_ID = "org.inklikeurine.WallshiftSettings"


def _metadata_uuid():
    return _metadata().get("uuid") or os.path.basename(_APPLET_DIR)


def _parse_args(argv):
    """(uuid, instance_id). The applet's Configure item passes both; System Settings
    → Applets runs this file with no arguments (metadata.json
    "external-configuration-app"). Wallshift is single-instance, so the settings
    key is the uuid and the instance id is not needed then."""
    if len(argv) >= 3:
        return argv[1], argv[2]
    return _metadata_uuid(), None


def _fail(message):
    print(f"[wallshift configure] {message}", file=sys.stderr)
    dialog = Gtk.MessageDialog(message_type=Gtk.MessageType.ERROR, buttons=Gtk.ButtonsType.CLOSE,
                               text=_("Wallshift settings cannot open"))
    dialog.format_secondary_text(message)
    dialog.run()
    dialog.destroy()
    return 1


def main():
    if _WIDGETS_ERROR is not None:
        return _fail(_("Cinnamon's settings widgets were not found ({error}). "
                       "Wallshift needs Cinnamon 6.6 or later.").format(error=_WIDGETS_ERROR))
    uuid, instance_id = _parse_args(sys.argv)

    # One window: a second launch (Configure… again, or System Settings) brings
    # the open window to the front. Without a session bus, just open a window.
    app = Gtk.Application(application_id=_APP_ID)
    try:
        app.register(None)
    except GLib.Error:
        app = None
    if app is None:
        win = _SettingsWindow(uuid, instance_id)
        win._win.connect("destroy", Gtk.main_quit)
        Gtk.main()
        return 0
    if app.get_is_remote():
        app.activate()
        return 0

    state = {}

    def on_activate(application):
        if state.get("win") is None:
            state["win"] = _SettingsWindow(uuid, instance_id, app=application)
        state["win"].present()

    app.connect("activate", on_activate)
    return app.run(None)


if __name__ == "__main__":
    sys.exit(main())
