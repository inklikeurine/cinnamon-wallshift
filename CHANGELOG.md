# Changelog

All notable changes to Wallshift are recorded here.
Versions follow `metadata.json` (`version`).

## [0.0.4] — 2026-10-12

Bug-fix release from the UI review.

### Fixed
- The panel icon showed the normal wallpaper icon after a reload or login even
  when rotation was paused; it now shows the pause icon whenever rotation is paused.
- An interval of 0 minutes was treated as 5 minutes, so "0 min 30 s" rotated every
  5 min 30 s. 0 minutes now means "seconds only", as the setting says (minimum 10 s).
- In Sync mode, clicking a carousel thumbnail changed only that monitor and broke
  sync. The image now goes to every enabled monitor.
- The carousel's dark-theme check could not fall back to the theme name (a missing
  import), so dark themes with a transparent panel got the light buttons.
- The tooltip said "1 images available", and restoring a saved image replaced the
  "No images found" hint with "0 images available". Both fixed.
- *System Settings → Applets → Configure* opened Cinnamon's generic settings window
  instead of Wallshift's own, so there were two different settings windows. Both
  entry points now open the same `configure.py` dialog.
- A carousel padding value without a unit was ignored by the theme engine.

## [0.0.3] — 2026-09-13

Bug-fix release: the applet now cleans up after itself when removed or reloaded,
and a reload picks up new module code.

### Fixed
- Teardown never ran. All cleanup lived in a `destroy()` method that Cinnamon
  never calls; removing the applet from a panel, or reloading it, left the old
  instance's rotation timer, `monitor-config.json` file monitor, monitor
  detection signal and poll, carousel actors and settings bindings alive. The
  cleanup now lives in `on_applet_removed_from_panel()`, the hook Cinnamon does
  call, and additionally finalizes the settings object, destroys the popup menu,
  drops queued thumbnail jobs and ignores the results of ImageMagick runs and
  folder scans that finish after removal.
- Reloading the applet ran the new `applet.js` against stale modules. Modules
  were loaded through the GJS importer (`imports.modules.*`), which caches them
  for the life of the Cinnamon process; after an upgrade a reload could fail
  with e.g. `normalizePath is not a function`. Modules are now loaded with
  Cinnamon's `require()`, which is re-evaluated on every reload.

### Changed
- `cinnamon-version` now declares 6.6 only (the tested target, Linux Mint 22.3+).
  The applet still loads on any later release; it no longer offers itself to
  Cinnamon 5.x–6.4, which were never tested.

## [0.0.2] — 2026-09-11

Bug-fix release. Every setting made in the dialog now actually reaches the applet, and
the applet no longer trips Cinnamon's "may freeze Cinnamon" warning.

### Fixed
- Settings dialog wrote to `~/.config/cinnamon/spices/<uuid>.json` — a file Cinnamon
  never reads — and passed the numeric instance id to `updateSetting`, so no General-tab
  change (favorites folder, wallpaper folder, interval, sync, detection interval) ever
  reached the applet. It now uses Cinnamon's real path
  `~/.config/cinnamon/spices/<uuid>/<uuid>.json`, preserves the schema metadata, and
  passes the uuid as the instance key for single-instance applets.
- `file://` folder URIs written by Cinnamon's native folder chooser are now decoded
  robustly in both the applet and the dialog; the favorites copy refuses non-absolute
  destinations instead of creating a literal `file:/…` directory.

- Folder scanning ran `find` synchronously on Cinnamon's main thread; it now runs
  through `Gio.Subprocess` with completion callbacks, which also removes the call
  that made *System Settings → Applets* flag the applet as potentially able to freeze
  Cinnamon. Folder names containing quotes no longer break the scan.

### Added
- Headless regression tests (`scripts/test.sh`, `tests/`) for `ImagePool`,
  `StateManager`, `Compositor`, `Utils` and `configure.py`; `scripts/package.sh` runs
  them before building.

### Changed
- `normalizePath()` / `absoluteDirOr()` moved from `applet.js` to `Utils.js`.
- Applet UUID is now `wallshift@inklikeurine` (was `wallshift@local`). Existing installs
  must remove the old applet and add the new one; settings start fresh under the new
  UUID (runtime state in `~/.local/share/wallshift/` carries over unchanged).
- Repository reorganised to the Cinnamon Spices layout (`<uuid>/files/<uuid>/`), with
  design docs consolidated under `docs/` and packaging under `scripts/`.

## [0.0.1] — 2026-09-11

First packaged release.

### Added
- Timed wallpaper rotation from local folders with `no-repeat`, `random` and
  `sequential` order modes; configurable interval (≥ 10 s).
- Multi-monitor support: per-monitor folder, scaling mode (`zoom`/`fit`/`stretch`/
  `center`/`tile`), enable switch and pause; ImageMagick spanned composite.
- Sync mode (one image on every monitor).
- Monitor detection via GDK + EDID sysfs with `monitors-changed` signal, periodic
  poll (`detection-interval-minutes`) and manual **Refresh Monitors**.
- Persistent runtime state (`~/.local/share/wallshift/state.json`): pause flags,
  current image per monitor, 100-entry history, trashed-path exclusions.
- Panel menu: Next/Previous Wallpaper, Pause All, Swap Images, per-monitor submenus
  (carousel toggle, Next/Previous Image, Pause, Favorite, Trash, Open in Viewer),
  Refresh Monitors, Open Wallpaper Folder.
- Per-monitor thumbnail carousel overlay with on-disk thumbnail cache.
- Favorites (copy to folder) and Trash (`gio trash`).
- Optional change notifications; image-count tooltip.
- `configure.py` settings dialog (GTK3 / XApp): General tab wired through DBus
  `updateSetting`, one tab per detected monitor writing `monitor-config.json`.
