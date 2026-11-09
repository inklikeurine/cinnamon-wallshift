// Carousel placement and theme colours (0.1.0: C12 tab, S9 edge and size,
// X4 theming, top panels and auto-hide panels). Pure modules, no Cinnamon.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);
const L  = require('./modules/CarouselLayout');
const TC = require('./modules/ThemeColors');
const TCache = require('./modules/ThumbnailCache').ThumbnailCache;

const MON = { x: 0, y: 0, width: 1920, height: 1080 };
const TAB = { w: 160, h: 36 };

T.run('thumbnail sizes and strip thickness', () => {
    T.eq(L.thumbSize('medium', false), { w: 250, h: 140 });
    T.eq(L.thumbSize('large', true), { w: 180, h: 320 }, 'portrait swaps');
    T.eq(L.thumbSize('bogus', false), { w: 250, h: 140 }, 'unknown → medium');
    T.eq(L.stripThickness({ w: 250, h: 140 }, false), 152);
    T.eq(L.stripThickness({ w: 140, h: 250 }, true), 152);
});

T.run('edge setting maps to a side; portrait uses left / right', () => {
    T.eq(L.edgeFor('bottom', false), 'bottom');
    T.eq(L.edgeFor('top', false), 'top');
    T.eq(L.edgeFor('top', true), 'left');
    T.eq(L.edgeFor('bottom', true), 'right');
    T.eq(L.edgeFor(undefined, false), 'bottom', 'default');
});

T.run('usable area: fixed panels come from the work area, auto-hide panels are kept clear', () => {
    // Fixed 40 px bottom panel: the work area already excludes it; nothing more to do.
    let wa = { x: 0, y: 0, width: 1920, height: 1040 };
    T.eq(L.usableArea(wa, [{ position: L.PANEL_BOTTOM, hideable: false, thickness: 40 }]), wa);
    // Auto-hide top panel: the work area is the whole monitor; leave its 32 px free.
    T.eq(L.usableArea(MON, [{ position: L.PANEL_TOP, hideable: true, thickness: 32 }]),
        { x: 0, y: 32, width: 1920, height: 1048 });
    // Auto-hide bottom + fixed top.
    T.eq(L.usableArea({ x: 0, y: 30, width: 1920, height: 1050 },
        [{ position: L.PANEL_TOP, hideable: false, thickness: 30 },
         { position: L.PANEL_BOTTOM, hideable: true, thickness: 40 }]),
        { x: 0, y: 30, width: 1920, height: 1010 });
    // Auto-hide left panel on a portrait monitor.
    T.eq(L.usableArea({ x: 1920, y: 0, width: 1080, height: 1920 },
        [{ position: L.PANEL_LEFT, hideable: true, thickness: 48 }]),
        { x: 1968, y: 0, width: 1032, height: 1920 });
    T.eq(L.usableArea(MON, null), MON, 'no panels');
});

T.run('bottom edge: strip on the bottom, tab on top of it, collapsed tab on the edge', () => {
    let g = L.layout({ x: 0, y: 0, width: 1920, height: 1040 }, 'bottom', 152, TAB);
    T.eq(g.strip, { x: 0, y: 888, w: 1920, h: 152 });
    T.eq(g.tabOpen, { x: 880, y: 852 });
    T.eq(g.tabCollapsed, { x: 880, y: 1004 });
    T.eq(g.join, 'bottom');
});

T.run('top edge below a top panel: strip under the panel, tab hanging below', () => {
    let area = L.usableArea({ x: 0, y: 30, width: 1920, height: 1050 },
        [{ position: L.PANEL_TOP, hideable: false, thickness: 30 }]);
    let g = L.layout(area, 'top', 152, TAB);
    T.eq(g.strip, { x: 0, y: 30, w: 1920, h: 152 }, 'starts below the 30 px panel');
    T.eq(g.tabOpen, { x: 880, y: 182 });
    T.eq(g.tabCollapsed, { x: 880, y: 30 });
    T.eq(g.join, 'top');
});

T.run('top edge with an auto-hide top panel: the panel can slide out without covering it', () => {
    let area = L.usableArea(MON, [{ position: L.PANEL_TOP, hideable: true, thickness: 32 }]);
    let g = L.layout(area, 'top', 152, TAB);
    T.eq(g.strip.y, 32);
    T.eq(g.tabCollapsed.y, 32);
});

T.run('portrait: left and right strips, tab facing into the screen', () => {
    let area = { x: 1920, y: 0, width: 1080, height: 1920 };
    let tab = { w: 36, h: 160 };
    let left = L.layout(area, 'left', 152, tab);
    T.eq(left.strip, { x: 1920, y: 0, w: 152, h: 1920 });
    T.eq(left.tabOpen, { x: 2072, y: 880 });
    T.eq(left.tabCollapsed, { x: 1920, y: 880 });
    let right = L.layout(area, 'right', 152, tab);
    T.eq(right.strip, { x: 2848, y: 0, w: 152, h: 1920 });
    T.eq(right.tabOpen, { x: 2812, y: 880 });
    T.eq(right.tabCollapsed, { x: 2964, y: 880 });
});

T.run('tab frame: no border and square corners where it joins the strip', () => {
    let s = L.tabFrameStyle('bottom', { surface: 'S', border: 'B' });
    T.ok(s.includes('border-bottom-width: 0'), 'open side');
    T.ok(s.includes('border-radius: 8px 8px 0 0'), 'rounded top');
    T.ok(L.tabFrameStyle('top', { surface: 'S', border: 'B' }).includes('border-radius: 0 0 8px 8px'));
});

T.run('collapse chevron points into the edge, expand points out', () => {
    T.eq(L.chevron('bottom', false), 'go-down-symbolic');
    T.eq(L.chevron('bottom', true), 'go-up-symbolic');
    T.eq(L.chevron('top', false), 'go-up-symbolic');
    T.eq(L.chevron('top', true), 'go-down-symbolic');
    T.eq(L.chevron('left', false), 'go-previous-symbolic');
});

T.run('theme palette: uses what the theme sets, falls back for what it leaves transparent', () => {
    let light = TC.paletteFrom({
        surface: { red: 246, green: 246, blue: 246, alpha: 255 },
        fg:      { red: 48, green: 48, blue: 48, alpha: 255 },
        border:  null,
        accent:  { red: 74, green: 144, blue: 217, alpha: 255 } });
    T.eq(light.surface, 'rgba(246, 246, 246, 1)');
    T.eq(light.fg, 'rgba(48, 48, 48, 1)');
    T.eq(light.accent, 'rgba(74, 144, 217, 1)');
    T.eq(light.border, 'rgba(48, 48, 48, 0.149)', 'missing border → fg at 15%');
    T.eq(light.onAccent, 'rgba(255, 255, 255, 1)', 'white on a mid blue');

    let bare = TC.paletteFrom({ surface: { red: 0, green: 0, blue: 0, alpha: 0 }, fg: null, border: null, accent: null });
    T.eq(bare.surface, TC.css(TC.FALLBACK.surface), 'transparent surface → fallback (already nearly opaque)');
    T.eq(bare.fg, 'rgba(255, 255, 255, 1)', 'fg contrasts with the fallback surface');
    T.eq(bare.accent, TC.css(TC.FALLBACK.accent));

    let translucent = TC.paletteFrom({ surface: { red: 40, green: 40, blue: 40, alpha: 128 } });
    T.eq(translucent.surface, 'rgba(40, 40, 40, 0.941)', 'see-through menus become nearly opaque');
});

T.run('thumbnail cache: the medium sizes keep their old file names', () => {
    let tc = new TCache(T.tmpDir('thumbs'));
    T.ok(tc.getThumbnailPath('/a.jpg', 250, 140).endsWith('_l250.jpg'), 'landscape medium');
    T.ok(tc.getThumbnailPath('/a.jpg', 140, 250).endsWith('_p250.jpg'), 'portrait medium');
    T.ok(tc.getThumbnailPath('/a.jpg', 320, 180).endsWith('_320x180.jpg'), 'large');
    tc.destroy();
});

// ── 0.2.3: virtual strip ───────────────────────────────────────────────────────

T.run('contentLength matches a box of N items with spacing between them', () => {
    T.eq(L.contentLength(0, 255, 5), 0);
    T.eq(L.contentLength(1, 255, 5), 250);
    T.eq(L.contentLength(1454, 255, 5), 1454 * 250 + 1453 * 5, '1454 thumbnails, 250 px + 5 px spacing');
});

T.run('visibleRange: the visible thumbnails plus a buffer, clamped', () => {
    const step = 255, pad = L.STRIP_PAD;
    T.eq(L.visibleRange(0, 2560, step, 1454, 8), { first: 0, last: Math.ceil((2560 - pad) / step) + 8 }, 'at the start');
    const mid = L.visibleRange(100 * step, 2560, step, 1454, 8);
    T.ok(mid.first <= 100 - 8 + 1 && mid.first >= 100 - 9, 'first: buffer before the visible part (' + mid.first + ')');
    T.ok(mid.last >= 100 + Math.floor(2560 / step) + 8, 'last: buffer after it (' + mid.last + ')');
    T.eq(L.visibleRange(1454 * step, 2560, step, 1454, 8).last, 1453, 'clamped at the end');
    T.eq(L.visibleRange(0, 2560, step, 3, 8), { first: 0, last: 2 }, 'few images: all of them');
    T.eq(L.visibleRange(0, 2560, step, 0, 8), { first: 0, last: -1 }, 'empty');
    const r = L.visibleRange(40 * step, 1920, step, 1454, 8);
    T.ok(r.last - r.first + 1 < 40, 'a 1920 px strip builds under 40 of 1454 thumbnails (' + (r.last - r.first + 1) + ')');
});

T.run('every visible pixel is covered: no gap between built ranges while scrolling', () => {
    const step = 255, n = 500, view = 1920;
    for (let pos = 0; pos < n * step; pos += 97) {
        const r = L.visibleRange(pos, view, step, n, 0);
        const firstVisible = Math.max(0, Math.floor((pos - L.STRIP_PAD) / step));
        const lastVisible  = Math.min(n - 1, Math.floor((pos + view - L.STRIP_PAD) / step));
        if (r.first > firstVisible || r.last < lastVisible) { T.ok(false, 'gap at ' + pos); return; }
    }
    T.ok(true, 'covered at every scroll position');
});

imports.system.exit(T.summary());
