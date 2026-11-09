// Rotation.js — which image goes on which monitor. Pure decisions, no I/O.
//
// applet.js asks; this module answers; applet.js then composes, applies and saves.
// Every function takes a `view` of the applet's state:
//   view.slot(name)     → { enabled, scaling, folder }   per-monitor config
//   view.current(name)  → saved current image path, or null
//   view.isPaused(name) → per-monitor pause flag
//   view.exists(path)   → true when the file is still there
// and the list of connected monitors ([{ name, ... }]) it should consider.
//
// An "assignment" is { path, scaling } — what Compositor.compose() consumes.
// A "plan" is { assignments, monitorImages }: monitorImages holds the images
// that count as this change (recorded as current + pushed to history);
// assignments also holds images carried forward unchanged.

// One assignment for a known image path, with the monitor's configured scaling.
var assignment = function(view, name, path) {
    return { path, scaling: view.slot(name).scaling };
};

// Each monitor's saved image, skipping files that are gone. Redraws without advancing.
var restore = function(view, monitors) {
    let assignments = {};
    for (let mon of monitors) {
        let path = view.current(mon.name);
        if (path && view.exists(path)) assignments[mon.name] = assignment(view, mon.name, path);
    }
    return assignments;
};

// A history snapshot's monitor → path map, skipping files that are gone.
var fromHistory = function(view, monitors, entry) {
    let assignments = {};
    for (let mon of monitors) {
        let path = entry.monitors[mon.name];
        if (path && view.exists(path)) assignments[mon.name] = assignment(view, mon.name, path);
    }
    return assignments;
};

// Fill in every monitor missing from `assignments` with its saved image, so the
// composite includes paused / disabled / unchanged monitors. When `monitorImages`
// is passed, carried-forward paths are recorded there too. Mutates both.
var carryForward = function(view, monitors, assignments, monitorImages) {
    for (let mon of monitors) {
        if (assignments[mon.name]) continue;
        let path = view.current(mon.name);
        if (path) {
            assignments[mon.name] = assignment(view, mon.name, path);
            if (monitorImages) monitorImages[mon.name] = path;
        }
    }
};

// Advance every eligible monitor (timer tick, "Next Wallpaper").
//   opts.sync      Sync mode: every enabled monitor gets one image from opts.syncPool
//   opts.syncPool  pool-like ({ next(), getCount() }) or null
//   opts.pools     Map name → pool-like, independent mode
// Returns a plan, or { skip } with skip one of
//   'no-eligible'   nothing to do (every monitor disabled / paused) — not a problem
//   'sync-empty'    Sync mode and the pool has no images
//   'no-images'     no eligible monitor has an image
var advance = function(view, monitors, opts) {
    let assignments = {}, monitorImages = {};
    if (opts.sync) {
        let eligible = monitors.filter(m => view.slot(m.name).enabled);
        if (eligible.length === 0) return { skip: 'no-eligible' };
        let pool = opts.syncPool;
        if (!pool || pool.getCount() === 0) return { skip: 'sync-empty' };
        let path = pool.next();
        for (let mon of eligible) {
            assignments[mon.name]   = assignment(view, mon.name, path);
            monitorImages[mon.name] = path;
        }
    } else {
        let eligible = monitors.filter(m => view.slot(m.name).enabled && !view.isPaused(m.name));
        if (eligible.length === 0) return { skip: 'no-eligible' };
        for (let mon of eligible) {
            let pool = opts.pools.get(mon.name);
            let path = (pool ? pool.next() : null) || view.current(mon.name);
            if (path) {
                assignments[mon.name]   = assignment(view, mon.name, path);
                monitorImages[mon.name] = path;
            }
        }
        // Paused / disabled monitors keep their image in the composite, but it is
        // not recorded as a new change.
        carryForward(view, monitors, assignments);
    }
    if (Object.keys(monitorImages).length === 0) return { skip: 'no-images' };
    return { assignments, monitorImages };
};

// Put one image on one monitor, the rest unchanged (carousel click, per-monitor
// next / previous). In Sync mode the image goes to every enabled monitor. The
// unchanged monitors are recorded too, so the history snapshot is the whole desktop.
var applyImage = function(view, monitors, name, path, sync) {
    let targets = [name];
    if (sync) {
        let enabled = monitors.filter(m => view.slot(m.name).enabled).map(m => m.name);
        if (enabled.length > 0) targets = enabled;
    }
    let assignments = {}, monitorImages = {};
    for (let t of targets) {
        assignments[t]   = assignment(view, t, path);
        monitorImages[t] = path;
    }
    carryForward(view, monitors, assignments, monitorImages);
    return { assignments, monitorImages };
};

// The most recent history image for one monitor that differs from its current
// image and still exists, or null.  history: { length, at(stepsBack) }
var monitorPrevious = function(view, name, history) {
    let current = view.current(name);
    for (let i = 1; i <= history.length; i++) {
        let entry = history.at(i);
        if (!entry) break;
        let path = entry.monitors[name];
        if (path && path !== current && view.exists(path)) return path;
    }
    return null;
};

// One step through the global history.  position: 0 = the live tip, n = n steps back.
//   'back'    → { position, entry } or null when there is nothing older
//   'forward' → { position, kind } where kind is
//               'advance' (already at the tip: change the wallpaper),
//               'restore' (back at the tip: redraw the saved images), or
//               'entry'   (still in the past: show `entry`, which may be null)
var historyStep = function(position, direction, historyAt) {
    if (direction === 'back') {
        let entry = historyAt(position + 1);
        return entry ? { position: position + 1, entry } : null;
    }
    if (position === 0) return { position: 0, kind: 'advance' };
    position--;
    if (position === 0) return { position: 0, kind: 'restore' };
    return { position, kind: 'entry', entry: historyAt(position) };
};

// Rotate the current images one monitor to the left (A↔B; A→B→C→A). Only
// monitors that have an image take part; null when fewer than two do.
var swap = function(view, monitors) {
    let eligible = monitors.filter(m => view.current(m.name));
    if (eligible.length < 2) return null;
    let paths   = eligible.map(m => view.current(m.name));
    let rotated = paths.slice(1).concat(paths[0]);
    let assignments = {}, monitorImages = {};
    eligible.forEach((mon, i) => {
        assignments[mon.name]   = assignment(view, mon.name, rotated[i]);
        monitorImages[mon.name] = rotated[i];
    });
    carryForward(view, monitors, assignments);
    return { assignments, monitorImages };
};

// Monitors whose image really changes with `monitorImages` (the rest were
// carried forward). Feeds the "Wallpaper changed" notification.
var changedMonitors = function(view, monitors, monitorImages) {
    return monitors.filter(m => monitorImages[m.name] && view.current(m.name) !== monitorImages[m.name]);
};
