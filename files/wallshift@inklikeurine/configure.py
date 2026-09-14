#!/usr/bin/python3
"""
Wallshift configure.py — Settings dialog for the Wallshift Cinnamon applet.
Opened by applet.js configureApplet(); this is the ONE settings window.

Usage: /usr/bin/python3 configure.py <uuid> <instance_id>
"""

import sys
import os
import json

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')

try:
    gi.require_version('XApp', '1.0')
    from gi.repository import XApp
    _HAS_XAPP = True
except Exception:
    _HAS_XAPP = False

from gi.repository import Gtk, Gdk, GLib


# ──────────────────────────────────────────────────────────────────────────────
# Settings file helpers
#
# Cinnamon (js/ui/settings.js, _ensureSettingsFiles) keeps an xlet's AppletSettings at
#     ~/.config/cinnamon/spices/<uuid>/<instanceKey>.json
# where <instanceKey> is the *uuid* for single-instance xlets (max-instances == 1)
# and the numeric instance id otherwise. A legacy location, ~/.cinnamon/configs/,
# is honoured only when the new file does not exist. The same <instanceKey> must be
# passed to org.Cinnamon.updateSetting — Cinnamon registers the AppletSettings object
# under it, and remoteUpdate() simply re-reads that file, so writing anywhere else
# is silently ignored by the running applet.
# ──────────────────────────────────────────────────────────────────────────────

_APPLET_DIR = os.path.dirname(os.path.abspath(__file__))


def _is_multi_instance():
    try:
        with open(os.path.join(_APPLET_DIR, "metadata.json")) as f:
            return int(json.load(f).get("max-instances", 1)) != 1
    except Exception:
        return False


def _instance_key(uuid, instance_id):
    return str(instance_id) if _is_multi_instance() else uuid


def _settings_path(uuid, instance_id):
    key  = _instance_key(uuid, instance_id)
    new  = os.path.expanduser(f"~/.config/cinnamon/spices/{uuid}/{key}.json")
    old  = os.path.expanduser(f"~/.cinnamon/configs/{uuid}/{key}.json")
    if os.path.exists(old) and not os.path.exists(new):
        return old
    return new


def _schema_defaults():
    """settings-schema.json as Cinnamon would seed it: every key gets value=default."""
    try:
        with open(os.path.join(_APPLET_DIR, "settings-schema.json")) as f:
            data = json.load(f)
    except Exception:
        return {}
    for entry in data.values():
        if isinstance(entry, dict) and "default" in entry and "value" not in entry:
            entry["value"] = entry["default"]
    return data


def _load_settings(uuid, instance_id):
    try:
        with open(_settings_path(uuid, instance_id)) as f:
            return json.load(f)
    except Exception:
        return _schema_defaults()


def _get(data, key, default=None):
    entry = data.get(key, {})
    return entry.get('value', entry.get('default', default))


def _to_path(value):
    """Folder setting -> plain filesystem path (mirrors normalizePath() in applet.js).

    Cinnamon's native filechooser stores percent-encoded file:// URIs; this dialog
    stores plain paths; either may be in the file. Gtk.FileChooserButton.set_filename()
    needs a real path, otherwise the button shows nothing.
    """
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


def _update_setting(uuid, instance_id, key, value):
    """Write key=value to Cinnamon's settings file, then ping the running applet via DBus."""
    path = _settings_path(uuid, instance_id)
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        # The applet has never been loaded (no file yet): seed from the schema so the
        # file has the type/default metadata Cinnamon's _checkSettings() expects.
        data = _schema_defaults()

    if key not in data or not isinstance(data[key], dict):
        print(f"[wallshift configure] unknown setting key: {key}", file=sys.stderr)
        return
    data[key]['value'] = value

    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"[wallshift configure] failed to write settings: {e}", file=sys.stderr)
        return

    try:
        import dbus
        bus   = dbus.SessionBus()
        proxy = bus.get_object('org.Cinnamon', '/org/Cinnamon')
        iface = dbus.Interface(proxy, 'org.Cinnamon')
        iface.updateSetting(uuid, _instance_key(uuid, instance_id), key, json.dumps(value))
    except Exception:
        pass   # applet not running / no dbus module — value is on disk for next start


# ──────────────────────────────────────────────────────────────────────────────
# monitor-config.json helpers
# ──────────────────────────────────────────────────────────────────────────────

def _monitor_config_path():
    return os.path.expanduser("~/.local/share/wallshift/monitor-config.json")


def _load_monitor_config():
    try:
        with open(_monitor_config_path()) as f:
            return json.load(f)
    except Exception:
        return {"monitors": {}}


def _save_monitor_config(cfg):
    path = _monitor_config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(cfg, f, indent=2)


# ──────────────────────────────────────────────────────────────────────────────
# Monitor detection
# ──────────────────────────────────────────────────────────────────────────────

def _parse_edid_monitor_name(data):
    """Scan EDID descriptor blocks for Monitor Name descriptor (tag 0xFC)."""
    for block in range(4):
        o = 54 + block * 18
        if (data[o] == 0x00 and data[o+1] == 0x00 and
                data[o+2] == 0x00 and data[o+3] == 0xFC):
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
    """Read friendly name from /sys/class/drm — same logic as MonitorManager.js."""
    import re
    candidates = [connector]
    m = re.match(r'^HDMI-(\d+)$', connector)
    if m:
        n = m.group(1)
        candidates += [f'HDMI-A-{n}', f'HDMI-B-{n}']

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
    """Return list of {name, connector, index} — mirrors MonitorManager.js exactly."""
    display  = Gdk.Display.get_default()
    screen   = Gdk.Screen.get_default()
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

        display_name = _read_edid_name(connector) or connector

        monitors.append({"name": display_name, "connector": connector, "index": i})

    return monitors


# ──────────────────────────────────────────────────────────────────────────────
# UI helpers — GNOME HIG style: bold label above a bordered rounded card
# ──────────────────────────────────────────────────────────────────────────────

def _apply_css():
    css = (
        "listbox.ws-card {"
        "  border: 1px solid @borders;"
        "  border-radius: 8px;"
        "  background-color: @theme_base_color;"
        "}"
        "listbox.ws-card > row {"
        "  background-color: @theme_base_color;"
        "  min-height: 46px;"
        "  padding: 2px 6px;"
        "  border-radius: 0;"
        "}"
        "listbox.ws-card > row:not(:last-child) {"
        "  border-bottom: 1px solid @borders;"
        "}"
        "listbox.ws-card > row:first-child {"
        "  border-radius: 8px 8px 0 0;"
        "}"
        "listbox.ws-card > row:last-child {"
        "  border-radius: 0 0 8px 8px;"
        "}"
        "listbox.ws-card > row:only-child {"
        "  border-radius: 8px;"
        "}"
        "label.ws-section {"
        "  font-weight: bold;"
        "  margin-top: 20px;"
        "  margin-bottom: 6px;"
        "}"
        ".ws-switcher-bar {"
        "  background-color: @theme_bg_color;"
        "  border-bottom: 1px solid @borders;"
        "  padding: 6px;"
        "}"
    ).encode()
    provider = Gtk.CssProvider()
    provider.load_from_data(css)
    Gtk.StyleContext.add_provider_for_screen(
        Gdk.Screen.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    )


def _section_label(text):
    lbl = Gtk.Label(label=text)
    lbl.set_halign(Gtk.Align.START)
    lbl.set_margin_start(2)
    lbl.get_style_context().add_class('ws-section')
    return lbl


def _make_row(label_text, widget):
    row = Gtk.ListBoxRow()
    row.set_selectable(False)
    box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
    box.set_margin_start(12)
    box.set_margin_end(12)
    box.set_margin_top(6)
    box.set_margin_bottom(6)
    lbl = Gtk.Label(label=label_text)
    lbl.set_halign(Gtk.Align.START)
    lbl.set_hexpand(True)
    box.pack_start(lbl, True, True, 0)
    box.pack_start(widget, False, False, 0)
    row.add(box)
    return row


def _make_section(title, rows):
    """Bold label + rounded bordered listbox card."""
    vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
    vbox.set_margin_bottom(4)
    vbox.pack_start(_section_label(title), False, False, 0)
    lb = Gtk.ListBox()
    lb.set_selection_mode(Gtk.SelectionMode.NONE)
    lb.get_style_context().add_class('ws-card')
    for r in rows:
        lb.add(r)
    vbox.pack_start(lb, False, False, 0)
    return vbox


# ──────────────────────────────────────────────────────────────────────────────
# Main window
# ──────────────────────────────────────────────────────────────────────────────

class _ConfigureWindow:

    def __init__(self, uuid, instance_id):
        self._uuid        = uuid
        self._instance_id = instance_id
        self._settings    = _load_settings(uuid, instance_id)
        self._mon_cfg     = _load_monitor_config()
        self._monitors    = _detect_monitors()

        _apply_css()

        # ── Window ────────────────────────────────────────────────────────────
        if _HAS_XAPP:
            self._win = XApp.GtkWindow()
        else:
            self._win = Gtk.Window()

        self._win.set_title("Wallshift Settings")
        self._win.set_default_size(560, 520)
        self._win.connect("destroy", Gtk.main_quit)

        # ── Stack + StackSwitcher (native GTK3 tab pattern) ───────────────────
        stack = Gtk.Stack()
        stack.set_transition_type(Gtk.StackTransitionType.SLIDE_LEFT_RIGHT)
        stack.set_transition_duration(150)

        switcher = Gtk.StackSwitcher()
        switcher.set_stack(stack)
        switcher.set_halign(Gtk.Align.CENTER)

        switcher_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        switcher_bar.get_style_context().add_class('ws-switcher-bar')
        switcher_bar.pack_start(switcher, True, False, 0)

        stack.add_titled(self._build_general_tab(), "general", "General")
        for mon in self._monitors:
            n, c = mon["name"], mon["connector"]
            tab_label = f"{n} ({c})" if n != c else n
            stack.add_titled(self._build_monitor_tab(mon), c, tab_label)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        outer.pack_start(switcher_bar, False, False, 0)
        outer.pack_start(stack, True, True, 0)
        self._win.add(outer)

        self._win.show_all()

    # ── General tab ───────────────────────────────────────────────────────────

    def _build_general_tab(self):
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        outer.set_border_width(16)
        outer.set_spacing(0)

        # ── Change Interval ────────────────────────────────────────────────
        min_spin = Gtk.SpinButton.new_with_range(0, 1440, 1)
        min_spin.set_value(_get(self._settings, 'interval-minutes', 5))
        min_spin.connect('value-changed',
            lambda w: self._set('interval-minutes', int(w.get_value())))
        min_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        min_box.pack_start(min_spin, False, False, 0)
        min_box.pack_start(Gtk.Label(label="min"), False, False, 0)

        sec_spin = Gtk.SpinButton.new_with_range(0, 59, 1)
        sec_spin.set_value(_get(self._settings, 'interval-seconds', 0))
        sec_spin.connect('value-changed',
            lambda w: self._set('interval-seconds', int(w.get_value())))
        sec_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        sec_box.pack_start(sec_spin, False, False, 0)
        sec_box.pack_start(Gtk.Label(label="sec"), False, False, 0)

        outer.pack_start(_make_section("Change Interval", [
            _make_row("Change wallpaper every", min_box),
            _make_row("Additional seconds",     sec_box),
        ]), False, False, 0)

        # ── Monitor Detection ──────────────────────────────────────────────
        detect_spin = Gtk.SpinButton.new_with_range(1, 1440, 1)
        detect_spin.set_value(_get(self._settings, 'detection-interval-minutes', 30))
        detect_spin.connect('value-changed',
            lambda w: self._set('detection-interval-minutes', int(w.get_value())))
        detect_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        detect_box.pack_start(detect_spin, False, False, 0)
        detect_box.pack_start(Gtk.Label(label="min"), False, False, 0)

        self._refresh_btn = Gtk.Button(label="Refresh Monitors")
        self._refresh_btn.set_valign(Gtk.Align.CENTER)
        self._refresh_btn.connect('clicked', self._on_refresh_monitors)

        outer.pack_start(_make_section("Monitor Detection", [
            _make_row("Re-check for port / monitor changes every", detect_box),
            _make_row("Apply a port or monitor change now",        self._refresh_btn),
        ]), False, False, 0)

        # ── Display ────────────────────────────────────────────────────────
        order_combo = Gtk.ComboBoxText()
        _ORDER = [
            ("no-repeat",  "Random (no repeats)"),
            ("random",     "Random (may repeat)"),
            ("sequential", "Sequential (A\u2013Z)"),
        ]
        cur_order = _get(self._settings, 'image-order', 'no-repeat')
        for i, (val, lbl) in enumerate(_ORDER):
            order_combo.append(val, lbl)
            if val == cur_order:
                order_combo.set_active(i)
        order_combo.connect('changed',
            lambda w: self._set('image-order', w.get_active_id())
                if w.get_active_id() else None)

        notif_sw = Gtk.Switch()
        notif_sw.set_active(bool(_get(self._settings, 'show-notifications', False)))
        notif_sw.set_valign(Gtk.Align.CENTER)
        notif_sw.connect('notify::active',
            lambda w, _: self._set('show-notifications', w.get_active()))

        gf_val = _to_path(_get(self._settings, 'global-folder', ''))
        gf_btn = Gtk.FileChooserButton(
            title="Select wallpaper folder",
            action=Gtk.FileChooserAction.SELECT_FOLDER)
        if gf_val:
            gf_btn.set_filename(gf_val)
        gf_btn.connect('file-set',
            lambda w: self._set('global-folder', w.get_filename() or ''))

        fav_val = _to_path(_get(self._settings, 'favorites-folder', ''))
        fav_btn = Gtk.FileChooserButton(
            title="Select favorites folder",
            action=Gtk.FileChooserAction.SELECT_FOLDER)
        if fav_val:
            fav_btn.set_filename(fav_val)
        fav_btn.connect('file-set',
            lambda w: self._set('favorites-folder', w.get_filename() or ''))

        outer.pack_start(_make_section("Display", [
            _make_row("Image rotation order",                order_combo),
            _make_row("Show notification on wallpaper change", notif_sw),
            _make_row("Wallpaper folder",                    gf_btn),
            _make_row("Favorites folder",                    fav_btn),
        ]), False, False, 0)

        # ── Sync Monitors ──────────────────────────────────────────────────────
        sync_sw = Gtk.Switch()
        sync_sw.set_active(bool(_get(self._settings, 'sync-mode', False)))
        sync_sw.set_valign(Gtk.Align.CENTER)
        sync_sw.connect('notify::active',
            lambda w, _: self._set('sync-mode', w.get_active()))

        outer.pack_start(_make_section("Sync Monitors", [
            _make_row("Same image on all monitors", sync_sw),
        ]), False, False, 0)

        sw = Gtk.ScrolledWindow()
        sw.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        sw.add(outer)
        return sw

    # ── Per-monitor tab ────────────────────────────────────────────────────────

    def _build_monitor_tab(self, mon):
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        outer.set_border_width(16)
        outer.set_spacing(0)

        connector = mon["connector"]
        name      = mon["name"]
        hdr       = name if name == connector else f"{name}  ({connector})"

        overrides = (self._mon_cfg.get("monitors") or {}).get(connector, {})

        enabled_sw = Gtk.Switch()
        enabled_sw.set_active(overrides.get("enabled", True))
        enabled_sw.set_valign(Gtk.Align.CENTER)
        enabled_sw.connect('notify::active',
            lambda w, _, c=connector: self._set_monitor(c, "enabled", w.get_active()))

        scaling_combo = Gtk.ComboBoxText()
        _SCALING = [
            ("zoom",    "Zoom"),
            ("fit",     "Fit"),
            ("stretch", "Stretch"),
            ("center",  "Center"),
            ("tile",    "Tile"),
        ]
        cur_scaling = overrides.get("scaling", "zoom")
        for i, (val, lbl) in enumerate(_SCALING):
            scaling_combo.append(val, lbl)
            if val == cur_scaling:
                scaling_combo.set_active(i)
        scaling_combo.connect('changed',
            lambda w, c=connector: self._set_monitor(c, "scaling", w.get_active_id())
                if w.get_active_id() else None)

        folder_val = _to_path(overrides.get("folder", ""))
        folder_btn = Gtk.FileChooserButton(
            title="Select wallpaper folder",
            action=Gtk.FileChooserAction.SELECT_FOLDER)
        if folder_val:
            folder_btn.set_filename(folder_val)
        folder_btn.connect('file-set',
            lambda w, c=connector: self._set_monitor(c, "folder", w.get_filename() or ""))

        outer.pack_start(_make_section(hdr, [
            _make_row("Enabled",          enabled_sw),
            _make_row("Scaling",          scaling_combo),
            _make_row("Wallpaper folder", folder_btn),
        ]), False, False, 0)

        sw = Gtk.ScrolledWindow()
        sw.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        sw.add(outer)
        return sw

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _set(self, key, value):
        _update_setting(self._uuid, self._instance_id, key, value)

    def _set_monitor(self, connector, field, value):
        cfg = self._mon_cfg.setdefault("monitors", {})
        cfg.setdefault(connector, {})[field] = value
        _save_monitor_config(self._mon_cfg)

    def _on_refresh_monitors(self, btn):
        """Tell the running applet to re-detect monitors and recompose.

        The applet watches monitor-config.json, so bumping refreshToken wakes it
        without any extra IPC. Briefly confirm on the button itself.
        """
        self._mon_cfg["refreshToken"] = GLib.get_real_time()
        _save_monitor_config(self._mon_cfg)

        btn.set_sensitive(False)
        btn.set_label("Refreshed ✓")

        def _restore():
            btn.set_label("Refresh Monitors")
            btn.set_sensitive(True)
            return False
        GLib.timeout_add_seconds(2, _restore)


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print("Usage: configure.py <uuid> <instance_id>", file=sys.stderr)
        sys.exit(1)

    _ConfigureWindow(sys.argv[1], sys.argv[2])
    Gtk.main()


if __name__ == "__main__":
    main()
