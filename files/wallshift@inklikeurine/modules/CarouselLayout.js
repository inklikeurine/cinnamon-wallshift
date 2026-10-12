// CarouselLayout.js — where the carousel's strip and tab go on a monitor.
// Pure geometry (no St / Clutter), so every case is covered by headless tests.
//
// The strip runs along one edge of the monitor's usable area; the tab with the
// controls sits on the strip's inner side, centred, facing into the desktop:
//
//   edge bottom:      [tab]           edge top:  ═══════ strip ═══════
//              ═══════ strip ═══════                      [tab]
//              ─────── panel ───────
//
// Portrait monitors use a vertical strip: the "top" setting puts it on the
// left edge, "bottom" on the right.
//
// Usable area. Cinnamon's work area already leaves out panels that reserve
// space. An auto-hide (or intellihide) panel reserves nothing, so it would slide
// out over the strip; usableArea() keeps that panel's thickness free as well.
// Top panels are handled the same way as bottom ones: the strip always starts
// past whatever panel shares its edge.

var THUMB_SIZES = {          // landscape thumbnails, w × h (portrait swaps them)
    small:  [180, 101],
    medium: [250, 140],
    large:  [320, 180],
};
var STRIP_PAD = 6;           // padding inside the strip, around the thumbnails

// Cinnamon's PanelLoc (one declaration each: the loader exports one name per line)
var PANEL_TOP    = 0;
var PANEL_BOTTOM = 1;
var PANEL_LEFT   = 2;
var PANEL_RIGHT  = 3;

var thumbSize = function(sizeName, isPortrait) {
    let [w, h] = THUMB_SIZES[sizeName] || THUMB_SIZES.medium;
    return isPortrait ? { w: h, h: w } : { w, h };
};

// Strip thickness across its edge: one thumbnail plus padding.
var stripThickness = function(thumb, isPortrait) {
    return (isPortrait ? thumb.w : thumb.h) + 2 * STRIP_PAD;
};

var edgeFor = function(setting, isPortrait) {
    let top = setting === 'top';
    if (isPortrait) return top ? 'left' : 'right';
    return top ? 'top' : 'bottom';
};

// workArea: {x, y, width, height} from global.display.get_monitor_work_area().
// panels:   the monitor's panels, [{ position, hideable, thickness }].
var usableArea = function(workArea, panels) {
    let a = { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
    for (let p of panels || []) {
        if (!p || !p.hideable) continue;      // fixed panels are outside the work area already
        let t = Math.max(0, p.thickness || 0);
        switch (p.position) {
        case PANEL_TOP:    a.y += t; a.height -= t; break;
        case PANEL_BOTTOM: a.height -= t;           break;
        case PANEL_LEFT:   a.x += t; a.width -= t;  break;
        case PANEL_RIGHT:  a.width -= t;            break;
        }
    }
    a.width  = Math.max(0, a.width);
    a.height = Math.max(0, a.height);
    return a;
};

// area: usableArea(); edge: edgeFor(); thickness: stripThickness();
// tab: the tab's natural size {w, h}.
// Returns the strip's rectangle, the tab's position open and collapsed, and
// `join`, the tab side that touches the strip (drawn without border or rounding).
var layout = function(area, edge, thickness, tab) {
    let a = area, t = thickness;
    let cx = a.x + Math.floor((a.width - tab.w) / 2);
    let cy = a.y + Math.floor((a.height - tab.h) / 2);
    switch (edge) {
    case 'top':
        return { strip: { x: a.x, y: a.y, w: a.width, h: t },
                 tabOpen: { x: cx, y: a.y + t }, tabCollapsed: { x: cx, y: a.y }, join: 'top' };
    case 'left':
        return { strip: { x: a.x, y: a.y, w: t, h: a.height },
                 tabOpen: { x: a.x + t, y: cy }, tabCollapsed: { x: a.x, y: cy }, join: 'left' };
    case 'right':
        return { strip: { x: a.x + a.width - t, y: a.y, w: t, h: a.height },
                 tabOpen: { x: a.x + a.width - t - tab.w, y: cy },
                 tabCollapsed: { x: a.x + a.width - tab.w, y: cy }, join: 'right' };
    default:    // bottom
        return { strip: { x: a.x, y: a.y + a.height - t, w: a.width, h: t },
                 tabOpen: { x: cx, y: a.y + a.height - t - tab.h },
                 tabCollapsed: { x: cx, y: a.y + a.height - tab.h }, join: 'bottom' };
    }
};

// Inline style for the tab's frame: rounded on the free side, no border where
// it joins the strip (or the screen edge, once collapsed).
var tabFrameStyle = function(join, colors) {
    let radius = { bottom: '8px 8px 0 0', top: '0 0 8px 8px', left: '0 8px 8px 0', right: '8px 0 0 8px' }[join];
    let pad    = { bottom: '4px 10px 2px', top: '2px 10px 4px', left: '10px 4px 10px 2px', right: '10px 2px 10px 4px' }[join];
    return 'background-color: ' + colors.surface + '; border: 1px solid ' + colors.border + '; ' +
           'border-' + join + '-width: 0; border-radius: ' + radius + '; padding: ' + pad + ';';
};

// Icons for the collapse/expand button: it always points toward where the strip
// goes — into the edge to collapse, out of it to expand.
var chevron = function(edge, collapsed) {
    let toward = { bottom: 'go-down', top: 'go-up', left: 'go-previous', right: 'go-next' }[edge];
    let away   = { bottom: 'go-up', top: 'go-down', left: 'go-next', right: 'go-previous' }[edge];
    return (collapsed ? away : toward) + '-symbolic';
};
