# Changelog

All notable changes to Wallshift are recorded here.
Versions follow `metadata.json` (`version`).

## [0.2.1] — 2026-10-15

### Fixed
- With sync off, every monitor showed the same image when ImageMagick was not
  installed. Compositing no longer needs ImageMagick (see below).
- With two or more monitors connected but only one of them having an image
  (a monitor switched off in Wallshift, or an empty folder), that image was
  shown on every monitor. The other monitors are now left black.

### Changed
- ImageMagick is no longer needed. The multi-monitor wallpaper and the
  carousel thumbnails are built by `imagetool.py` with GdkPixbuf, which comes
  with Cinnamon. It runs as a separate process, as ImageMagick did.

## [0.2.0] — 2026-10-12

### Changed
- The settings window looks like every other applet's settings: it is built
  from Cinnamon's own settings widgets (framed sections, rows, switches, spin
  buttons and file choosers), with the page switcher in the toolbar and the ☰
  menu (import, export, reset to defaults, reload). Number fields are
  Cinnamon's spin buttons (the number, then − and +). The General page is
  generated from `settings-schema.json`; longer explanations moved into
  tooltips. Window title "Wallshift".
- Monitor tabs follow the screen: plugging in or unplugging a monitor adds or
  removes its tab while the window is open.
- The applet is highlighted on the panel while its settings window is open,
  as with Cinnamon's own settings window.

### Removed
- `python3-dbus` is no longer needed (the window talks to Cinnamon through Gio).

## [0.1.0] — 2026-10-12

UI polish: a reworked carousel, a tidier panel menu and settings window, and the
whole applet following the system theme.

### Added
- **Carousel tab.** The controls (hide, favorite, trash, close) sit in a tab grown
  out of the strip, on its side facing into the desktop. Collapsing folds the strip
  away and leaves only the tab.
- **Carousel settings** (new *Carousel* section): come in from the top or bottom
  edge (left or right on a portrait monitor), thumbnail size (small / medium /
  large), file names on hover / always / never, and close after choosing an image.
- The carousel keeps clear of panels on its edge, including ones that auto-hide or
  intellihide, so a panel sliding out never covers it.
- File name on hover, tooltips on every carousel button, a check badge on the
  current image, a loading icon on thumbnails still being made, and a message
  instead of an empty strip when a folder has no images.
- The favorite button shows a filled star when the image is already in the
  favorites folder; clicking it again removes that copy (to the system trash).
  The menu item reads *Remove from Favorites* in that case.
- Panel tooltip shows when the next change is due, the image count and which
  monitors are paused.
- Scroll on the panel icon for the previous / next wallpaper; middle-click to pause
  or resume.
- A switch to turn off the periodic monitor re-check (*Settings → Monitors*).
- *Trash This Image* shows a notification saying what was moved to the trash.
- Translatable strings in the applet and the settings window, with a
  `po/wallshift@inklikeurine.pot` template.
- `icon.png` for System Settings and the Spices site.

### Changed
- **Everything follows the system theme.** The carousel takes its surface, text,
  border and accent colours from the active Cinnamon theme and updates when the
  theme changes; the stylesheet no longer holds any colours.
- Panel menu: an icon on every row of every menu. With one monitor its items sit
  directly in the menu (no submenu, no *Swap Images*); in Sync mode one *All
  monitors* submenu replaces the identical per-monitor ones; paused monitors are
  marked "· paused". *Show / Hide Carousel* is now a switch, long file names are cut
  with "…", *Pause All Rotation* is *Pause Rotation*, and *Open Wallpaper Folder*
  is *Open Image Folder* (it opens the current image's folder).
- Settings window: Folders section first; the interval is one row with a note when
  it is under the 10-second minimum; number fields read − n + and save shortly
  after the last click instead of on every step; a monitor's folder can be cleared
  back to the default; per-monitor folders are greyed out with a note in Sync mode;
  opening Configure again brings the open window forward instead of a second one.
- The wallpaper-change notification has a title and one line per monitor that
  changed ("Acer CB272U: forest.jpg"), with the Wallshift icon.
- Carousel opening and closing fade; the carousel hides while a fullscreen window
  covers its monitor, and re-opens in the right place after monitors change.
- On a portrait monitor the default (bottom) setting now puts the vertical strip on
  the right edge; choose *Top edge* for the left, where it used to be.

### Removed
- The `icon` key from `metadata.json` (Spices forbids it) and `icon.svg`, replaced
  by `icon.png`.

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
