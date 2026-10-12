// ThemeColors.js — colours for Wallshift's own on-screen chrome (the carousel),
// read from the active Cinnamon theme instead of being fixed in the stylesheet.
//
// The carousel's chrome actors sit outside any popup, so theme selectors such as
// `.menu` or `.popup-menu-item:active` never reach them. Instead the colours are
// read off the applet's own popup menu, which the theme does style:
//   surface — the menu's background (`.menu`, else `.popup-menu-content`)
//   fg      — the menu's text colour
//   border  — the menu's border colour, else fg at low alpha
//   accent  — the background of a highlighted menu item (`.popup-menu-item:active`)
// Anything the theme leaves transparent falls back to the next source, and
// finally to a neutral dark palette. read() never throws.
//
// Colours are plain { red, green, blue, alpha } objects (0–255), so the helpers
// below run headless; css() turns one into an St-compatible rgba() string.
// St is imported inside the two functions that need it, for the same reason.

var FALLBACK = {
    surface: { red: 47,  green: 47,  blue: 47,  alpha: 242 },
    fg:      { red: 218, green: 218, blue: 218, alpha: 255 },
    accent:  { red: 143, green: 168, blue: 118, alpha: 255 },
};

// ── Pure helpers ───────────────────────────────────────────────────────────────

var plain = function(c) {
    if (!c) return null;
    return { red: c.red, green: c.green, blue: c.blue, alpha: c.alpha };
};

// A colour the theme actually set (not transparent / missing).
var isSet = function(c) {
    return !!c && c.alpha >= 16;
};

var withAlpha = function(c, a01) {
    return { red: c.red, green: c.green, blue: c.blue, alpha: Math.round(255 * a01) };
};

var css = function(c) {
    let a = Math.round((c.alpha / 255) * 1000) / 1000;
    return 'rgba(' + c.red + ', ' + c.green + ', ' + c.blue + ', ' + a + ')';
};

// Relative luminance, 0 (black) … 1 (white), ignoring alpha.
var luminance = function(c) {
    let lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(c.red) + 0.7152 * lin(c.green) + 0.0722 * lin(c.blue);
};

// Black or white, whichever reads better on `c`.
var contrastOn = function(c) {
    return luminance(c) > 0.4
        ? { red: 0, green: 0, blue: 0, alpha: 230 }
        : { red: 255, green: 255, blue: 255, alpha: 255 };
};

var firstSet = function(list) {
    for (let c of list) if (isSet(c)) return c;
    return null;
};

// Raw theme colours → the CSS strings the carousel uses.
var paletteFrom = function(raw) {
    let surface = firstSet([raw.surface]) || FALLBACK.surface;
    let fg      = firstSet([raw.fg]) || contrastOn(surface);
    let border  = firstSet([raw.border]) || withAlpha(fg, 0.15);
    let accent  = firstSet([raw.accent]) || FALLBACK.accent;
    // The strip and tab are always nearly opaque: wallpapers behind them vary.
    let solid   = surface.alpha < 230 ? withAlpha(surface, 0.94) : surface;
    return {
        surface:     css(solid),
        surfaceSoft: css(withAlpha(surface, 0.85)),
        fg:          css(fg),
        fgDim:       css(withAlpha(fg, 0.55)),
        hoverBg:     css(withAlpha(fg, 0.12)),
        hoverBorder: css(withAlpha(fg, 0.45)),
        placeholder: css(withAlpha(fg, 0.08)),
        border:      css(border),
        accent:      css(accent),
        onAccent:    css(contrastOn(accent)),
    };
};

// ── Reading the theme (needs a running Cinnamon) ───────────────────────────────

function _bg(actor) {
    return plain(actor.get_theme_node().get_background_color());
}

function _border(actor) {
    const St = imports.gi.St;
    let node = actor.get_theme_node();
    for (let side of [St.Side.TOP, St.Side.BOTTOM, St.Side.LEFT, St.Side.RIGHT]) {
        if (node.get_border_width(side) > 0) return plain(node.get_border_color(side));
    }
    return null;
}

function _activeItemBg(menu) {
    const St = imports.gi.St;
    let probe = new St.Widget({ style_class: 'popup-menu-item' });
    probe.add_style_pseudo_class('active');
    menu.box.add_child(probe);
    try {
        return _bg(probe);
    } finally {
        menu.box.remove_child(probe);
        probe.destroy();
    }
}

// menu: an Applet.AppletPopupMenu that is on the stage (it lives in Main.uiGroup
// whether open or not). Returns paletteFrom() of whatever could be read.
var read = function(menu) {
    let raw = { surface: null, fg: null, border: null, accent: null };
    let attempt = fn => { try { return fn(); } catch(e) { return null; } };
    if (menu) {
        raw.surface = firstSet([attempt(() => _bg(menu.actor)), attempt(() => _bg(menu.box))]);
        raw.fg      = attempt(() => plain(menu.box.get_theme_node().get_foreground_color()));
        raw.border  = attempt(() => _border(menu.actor));
        raw.accent  = attempt(() => _activeItemBg(menu));
    }
    return paletteFrom(raw);
};
