#!/usr/bin/python3
"""
Wallshift configure.py — Settings dialog for the Wallshift Cinnamon applet.
Opened by applet.js configureApplet(); this is the ONE settings window.

Usage: /usr/bin/python3 configure.py [<uuid> <instance_id>]
Strings are translated through the applet's gettext domain (po/).
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

import gettext as _gettext
_tr = _gettext.translation('wallshift@inklikeurine',
                           localedir=os.path.expanduser('~/.local/share/locale'), fallback=True)
_ = _tr.gettext


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


def _make_row(label_text, widget, indent=False):
    row = Gtk.ListBoxRow()
    row.set_selectable(False)
    box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
    box.set_margin_start(28 if indent else 12)
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


def _make_row_with_hint(label_text, widget, hint_text, indent=False):
    """A row with a dim one-line hint under it. Returns (row, hint_label)."""
    row = _make_row(label_text, widget, indent)
    outer = row.get_child()
    row.remove(outer)
    vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
    vbox.pack_start(outer, False, False, 0)
    hint = Gtk.Label(label=hint_text)
    hint.set_halign(Gtk.Align.START)
    hint.set_line_wrap(True)
    hint.set_xalign(0)
    hint.set_margin_start(28 if indent else 12)
    hint.set_margin_end(12)
    hint.set_margin_bottom(8)
    hint.get_style_context().add_class('dim-label')
    vbox.pack_start(hint, False, False, 0)
    row.add(vbox)
    return row, hint


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


def _combo(options, current, on_change):
    """options: [(value, label)]. Calls on_change(value) when the user picks one."""
    combo = Gtk.ComboBoxText()
    for i, (val, lbl) in enumerate(options):
        combo.append(val, lbl)
        if val == current:
            combo.set_active(i)
    if combo.get_active() < 0 and options:
        combo.set_active(0)
    combo.connect('changed', lambda w: on_change(w.get_active_id()) if w.get_active_id() else None)
    return combo


def _switch(active, on_change):
    sw = Gtk.Switch()
    sw.set_active(bool(active))
    sw.set_valign(Gtk.Align.CENTER)
    sw.connect('notify::active', lambda w, _p: on_change(w.get_active()))
    return sw


class _Spin:
    """Number field drawn as  [−][ n ][+]  (a stock Gtk.SpinButton puts the number
    left of the buttons). Typed values are clamped to [lo, hi] on Enter or focus-out."""

    def __init__(self, lo, hi, value, on_change, step=1):
        self._lo, self._hi, self._step = lo, hi, step
        self._on_change = on_change
        self._value = self._clamp(value)

        self.widget = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self.widget.get_style_context().add_class('linked')
        self.widget.set_valign(Gtk.Align.CENTER)
        self._minus = Gtk.Button(label='−')
        self._minus.set_tooltip_text(_('Decrease'))
        self._entry = Gtk.Entry()
        self._entry.set_width_chars(max(2, len(str(hi))))
        self._entry.set_max_width_chars(max(2, len(str(hi))))
        self._entry.set_alignment(0.5)
        self._entry.set_input_purpose(Gtk.InputPurpose.DIGITS)
        self._plus = Gtk.Button(label='+')
        self._plus.set_tooltip_text(_('Increase'))
        for w in (self._minus, self._entry, self._plus):
            self.widget.pack_start(w, False, False, 0)

        self._minus.connect('clicked', lambda _b: self.set_value(self._value - self._step, notify=True))
        self._plus.connect('clicked', lambda _b: self.set_value(self._value + self._step, notify=True))
        self._entry.connect('activate', lambda _e: self._commit_text())
        self._entry.connect('focus-out-event', lambda _e, _ev: self._commit_text() or False)
        self._show()

    def _clamp(self, v):
        try:
            v = int(v)
        except (TypeError, ValueError):
            v = self._lo
        return max(self._lo, min(self._hi, v))

    def _show(self):
        self._entry.set_text(str(self._value))
        self._minus.set_sensitive(self._value > self._lo)
        self._plus.set_sensitive(self._value < self._hi)

    def _commit_text(self):
        self.set_value(self._entry.get_text().strip() or self._value, notify=True)

    def get_value(self):
        return self._value

    def set_value(self, v, notify=False):
        v = self._clamp(v)
        changed = v != self._value
        self._value = v
        self._show()
        if notify and changed:
            self._on_change(v)

    def set_sensitive(self, s):
        self.widget.set_sensitive(s)


# ──────────────────────────────────────────────────────────────────────────────
# Main window
# ──────────────────────────────────────────────────────────────────────────────

_SAVE_DELAY_MS = 400   # number fields save this long after the last click


class _ConfigureWindow:

    def __init__(self, uuid, instance_id, app=None):
        self._uuid        = uuid
        self._instance_id = instance_id
        self._settings    = _load_settings(uuid, instance_id)
        self._mon_cfg     = _load_monitor_config()
        self._monitors    = _detect_monitors()
        self._pending     = {}     # key -> (timeout id, value) for debounced writes
        self._sync_dependents = []  # (row widgets, hint) greyed out while Sync mode is on

        _apply_css()

        # ── Window ────────────────────────────────────────────────────────────
        if _HAS_XAPP:
            self._win = XApp.GtkWindow()
        else:
            self._win = Gtk.Window()
        if app is not None:
            self._win.set_application(app)

        self._win.set_title(_("Wallshift Settings"))
        self._win.set_default_size(580, 640)
        self._win.connect("destroy", self._on_destroy)
        if app is None:
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

        stack.add_titled(self._build_general_tab(), "general", _("General"))
        for mon in self._monitors:
            n, c = mon["name"], mon["connector"]
            tab_label = f"{n} ({c})" if n != c else n
            stack.add_titled(self._build_monitor_tab(mon), c, tab_label)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        outer.pack_start(switcher_bar, False, False, 0)
        outer.pack_start(stack, True, True, 0)
        self._win.add(outer)

        self._win.show_all()
        self._update_sync_dependents(bool(_get(self._settings, 'sync-mode', False)))
        self._update_interval_hint()

    def present(self):
        self._win.present()

    # ── General tab ───────────────────────────────────────────────────────────

    def _build_general_tab(self):
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        outer.set_border_width(16)
        outer.set_spacing(0)

        # ── Folders ───────────────────────────────────────────────────────────
        gf_btn = self._folder_button(_("Select wallpaper folder"),
                                     _to_path(_get(self._settings, 'global-folder', '')),
                                     lambda path: self._set('global-folder', path))
        fav_btn = self._folder_button(_("Select favorites folder"),
                                      _to_path(_get(self._settings, 'favorites-folder', '')),
                                      lambda path: self._set('favorites-folder', path))
        outer.pack_start(_make_section(_("Folders"), [
            _make_row(_("Wallpaper folder"), gf_btn),
            _make_row(_("Favorites folder"), fav_btn),
        ]), False, False, 0)

        # ── Rotation ──────────────────────────────────────────────────────────
        self._min_spin = _Spin(0, 1440, _get(self._settings, 'interval-minutes', 5),
                               lambda v: self._set_later('interval-minutes', v))
        self._sec_spin = _Spin(0, 59, _get(self._settings, 'interval-seconds', 0),
                               lambda v: self._set_later('interval-seconds', v))
        interval_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        interval_box.pack_start(self._min_spin.widget, False, False, 0)
        interval_box.pack_start(Gtk.Label(label=_("min")), False, False, 0)
        interval_box.pack_start(self._sec_spin.widget, False, False, 6)
        interval_box.pack_start(Gtk.Label(label=_("s")), False, False, 0)
        interval_row, self._interval_hint = _make_row_with_hint(
            _("Change every"), interval_box,
            _("The minimum is 10 seconds, so Wallshift will use 10 s."))

        order_combo = _combo([
            ("no-repeat",  _("Random (no repeats)")),
            ("random",     _("Random (may repeat)")),
            ("sequential", _("Sequential (A–Z)")),
        ], _get(self._settings, 'image-order', 'no-repeat'), lambda v: self._set('image-order', v))
        notif_sw = _switch(_get(self._settings, 'show-notifications', False),
                           lambda v: self._set('show-notifications', v))
        outer.pack_start(_make_section(_("Rotation"), [
            interval_row,
            _make_row(_("Order"), order_combo),
            _make_row(_("Notify when the wallpaper changes"), notif_sw),
        ]), False, False, 0)

        # ── Carousel ──────────────────────────────────────────────────────────
        edge_combo = _combo([
            ("bottom", _("Bottom edge")),
            ("top",    _("Top edge")),
        ], _get(self._settings, 'carousel-edge', 'bottom'), lambda v: self._set('carousel-edge', v))
        edge_row, _hint = _make_row_with_hint(_("Comes in from the"), edge_combo,
            _("Top edge or bottom edge; left (top) or right (bottom) on a portrait monitor. "
              "It always stays clear of panels, including ones that hide themselves."))
        size_combo = _combo([
            ("small",  _("Small")),
            ("medium", _("Medium")),
            ("large",  _("Large")),
        ], _get(self._settings, 'carousel-thumb-size', 'medium'), lambda v: self._set('carousel-thumb-size', v))
        names_combo = _combo([
            ("hover",  _("On hover")),
            ("always", _("Always")),
            ("never",  _("Never")),
        ], _get(self._settings, 'carousel-file-names', 'hover'), lambda v: self._set('carousel-file-names', v))
        close_sw = _switch(_get(self._settings, 'carousel-close-on-pick', False),
                           lambda v: self._set('carousel-close-on-pick', v))
        outer.pack_start(_make_section(_("Carousel"), [
            edge_row,
            _make_row(_("Thumbnail size"), size_combo),
            _make_row(_("Show file names"), names_combo),
            _make_row(_("Close after choosing an image"), close_sw),
        ]), False, False, 0)

        # ── Monitors ──────────────────────────────────────────────────────────
        sync_sw = _switch(_get(self._settings, 'sync-mode', False), self._on_sync_toggled)

        poll_on = bool(_get(self._settings, 'detection-poll-enabled', True))
        self._detect_spin = _Spin(1, 1440, _get(self._settings, 'detection-interval-minutes', 30),
                                  lambda v: self._set_later('detection-interval-minutes', v))
        detect_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        detect_box.pack_start(self._detect_spin.widget, False, False, 0)
        detect_box.pack_start(Gtk.Label(label=_("min")), False, False, 0)
        self._detect_row = _make_row(_("Every"), detect_box, indent=True)
        self._detect_row.set_sensitive(poll_on)

        poll_sw = _switch(poll_on, self._on_poll_toggled)
        poll_row, _hint = _make_row_with_hint(_("Re-check for monitor changes"), poll_sw,
            _("When off, Wallshift still reacts when Cinnamon reports a monitor change; "
              "only the timed re-check stops."))

        self._refresh_btn = Gtk.Button(label=_("Refresh Monitors"))
        self._refresh_btn.set_valign(Gtk.Align.CENTER)
        self._refresh_btn.connect('clicked', self._on_refresh_monitors)

        outer.pack_start(_make_section(_("Monitors"), [
            _make_row(_("Same image on all monitors"), sync_sw),
            poll_row,
            self._detect_row,
            _make_row(_("Apply a port or monitor change now"), self._refresh_btn),
        ]), False, False, 0)

        sw = Gtk.ScrolledWindow()
        sw.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        sw.add(outer)
        return sw

    def _folder_button(self, title, current, on_set):
        btn = Gtk.FileChooserButton(title=title, action=Gtk.FileChooserAction.SELECT_FOLDER)
        if current:
            btn.set_filename(current)
        btn.connect('file-set', lambda w: on_set(w.get_filename() or ''))
        return btn

    # ── Per-monitor tab ────────────────────────────────────────────────────────

    def _build_monitor_tab(self, mon):
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        outer.set_border_width(16)
        outer.set_spacing(0)

        connector = mon["connector"]
        name      = mon["name"]
        hdr       = name if name == connector else f"{name}  ({connector})"

        overrides = (self._mon_cfg.get("monitors") or {}).get(connector, {})

        enabled_sw = _switch(overrides.get("enabled", True),
                             lambda v, c=connector: self._set_monitor(c, "enabled", v))
        scaling_combo = _combo([
            ("zoom",    _("Zoom")),
            ("fit",     _("Fit")),
            ("stretch", _("Stretch")),
            ("center",  _("Center")),
            ("tile",    _("Tile")),
        ], overrides.get("scaling", "zoom"),
            lambda v, c=connector: self._set_monitor(c, "scaling", v))

        # Folder: a chooser plus a button that drops the override again.
        folder_val = _to_path(overrides.get("folder", ""))
        folder_btn = Gtk.FileChooserButton(title=_("Select wallpaper folder"),
                                           action=Gtk.FileChooserAction.SELECT_FOLDER)
        if folder_val:
            folder_btn.set_filename(folder_val)
        clear_btn = Gtk.Button.new_from_icon_name('edit-clear-symbolic', Gtk.IconSize.BUTTON)
        clear_btn.set_tooltip_text(_("Use the default folder"))
        clear_btn.set_valign(Gtk.Align.CENTER)
        folder_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        folder_box.pack_start(folder_btn, False, False, 0)
        folder_box.pack_start(clear_btn, False, False, 0)
        folder_row, folder_hint = _make_row_with_hint(_("Wallpaper folder"), folder_box, "")

        # The chooser's own get_filename() can lag behind set_filename(), so the
        # override is tracked here.
        state = {"path": folder_val}

        def show_folder_state():
            path = state["path"]
            clear_btn.set_sensitive(bool(path))
            folder_hint.set_text("" if path else _("Uses the default folder"))
            folder_hint.set_visible(not path)

        def on_folder_set(w, c=connector):
            state["path"] = w.get_filename() or ""
            self._set_monitor(c, "folder", state["path"])
            show_folder_state()

        def on_clear(_b, c=connector):
            folder_btn.unselect_all()
            state["path"] = ""
            self._clear_monitor(c, "folder")
            show_folder_state()

        folder_btn.connect('file-set', on_folder_set)
        clear_btn.connect('clicked', on_clear)
        self._sync_dependents.append((folder_box, folder_hint, show_folder_state))

        outer.pack_start(_make_section(hdr, [
            _make_row(_("Enabled"), enabled_sw),
            _make_row(_("Scaling"), scaling_combo),
            folder_row,
        ]), False, False, 0)

        sw = Gtk.ScrolledWindow()
        sw.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        sw.add(outer)
        return sw

    # ── Behaviour ──────────────────────────────────────────────────────────────

    def _on_sync_toggled(self, active):
        self._set('sync-mode', active)
        self._update_sync_dependents(active)

    # Sync mode shows the default folder on every monitor, so the per-monitor
    # folder rows are greyed out with a note instead of being silently ignored.
    def _update_sync_dependents(self, sync_on):
        for box, hint, show_state in self._sync_dependents:
            box.set_sensitive(not sync_on)
            if sync_on:
                hint.set_text(_("Sync mode uses the default folder on every monitor."))
                hint.set_visible(True)
            else:
                show_state()

    def _on_poll_toggled(self, active):
        self._set('detection-poll-enabled', active)
        self._detect_row.set_sensitive(active)

    def _update_interval_hint(self):
        total = self._min_spin.get_value() * 60 + self._sec_spin.get_value()
        self._interval_hint.set_visible(total < 10)

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _set(self, key, value):
        _update_setting(self._uuid, self._instance_id, key, value)

    # Number fields: write once the clicking stops, not on every step.
    def _set_later(self, key, value):
        if key in ('interval-minutes', 'interval-seconds'):
            self._update_interval_hint()
        old = self._pending.pop(key, None)
        if old:
            GLib.source_remove(old[0])

        def fire():
            self._pending.pop(key, None)
            self._set(key, value)
            return False
        self._pending[key] = (GLib.timeout_add(_SAVE_DELAY_MS, fire), value)

    def _flush_pending(self):
        for key, (tid, value) in list(self._pending.items()):
            GLib.source_remove(tid)
            self._set(key, value)
        self._pending.clear()

    def _on_destroy(self, *_a):
        self._flush_pending()

    def _set_monitor(self, connector, field, value):
        cfg = self._mon_cfg.setdefault("monitors", {})
        cfg.setdefault(connector, {})[field] = value
        _save_monitor_config(self._mon_cfg)

    def _clear_monitor(self, connector, field):
        mon = (self._mon_cfg.get("monitors") or {}).get(connector)
        if mon and field in mon:
            del mon[field]
            _save_monitor_config(self._mon_cfg)

    def _on_refresh_monitors(self, btn):
        """Tell the running applet to re-detect monitors and recompose.

        The applet watches monitor-config.json, so bumping refreshToken wakes it
        without any extra IPC. Briefly confirm on the button itself.
        """
        self._mon_cfg["refreshToken"] = GLib.get_real_time()
        _save_monitor_config(self._mon_cfg)

        btn.set_sensitive(False)
        btn.set_label(_("Refreshed ✓"))

        def _restore():
            btn.set_label(_("Refresh Monitors"))
            btn.set_sensitive(True)
            return False
        GLib.timeout_add_seconds(2, _restore)


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

_APP_ID = "org.inklikeurine.WallshiftSettings"


def _metadata_uuid():
    try:
        with open(os.path.join(_APPLET_DIR, "metadata.json")) as f:
            return json.load(f).get("uuid") or os.path.basename(_APPLET_DIR)
    except Exception:
        return os.path.basename(_APPLET_DIR)


def _parse_args(argv):
    """(uuid, instance_id). The applet's Configure item passes both; System Settings
    -> Applets runs this file with no arguments (metadata.json
    "external-configuration-app"). Wallshift is single-instance, so the settings
    key is the uuid and the instance id is not needed then."""
    if len(argv) >= 3:
        return argv[1], argv[2]
    return _metadata_uuid(), None


def main():
    uuid, instance_id = _parse_args(sys.argv)

    # One window: a second launch (Configure… again, or System Settings) brings
    # the open window to the front. Without a session bus, just open a window.
    app = Gtk.Application(application_id=_APP_ID)
    try:
        app.register(None)
    except GLib.Error:
        app = None
    if app is None:
        _ConfigureWindow(uuid, instance_id)
        Gtk.main()
        return
    if app.get_is_remote():
        app.activate()
        return

    state = {}

    def on_activate(application):
        if state.get("win") is None:
            state["win"] = _ConfigureWindow(uuid, instance_id, app=application)
        state["win"].present()

    app.connect("activate", on_activate)
    app.run(None)


if __name__ == "__main__":
    main()
