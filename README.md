# Wallshift

Rotates your desktop wallpaper from local image folders on a timer, with real
multi-monitor support: each monitor can have its own folder, scaling mode and
pause state, composited into one spanned wallpaper. Or switch on Sync mode to
show the same image everywhere.

Purely local — no downloads, no internet.

## Features

- **Timed rotation** — configurable interval (minimum 10 s, default 5 min).
- **Three orders** — random without repeats, pure random, or alphabetical.
- **Per-monitor** folder, scaling (zoom / fit / stretch / center / tile), enable and pause.
- **Sync mode** — one image on every monitor.
- **History** — Previous / Next for all monitors, or per monitor.
- **Swap Images** — rotate the current images across monitors.
- **Carousel** — an on-screen thumbnail strip per monitor, from the top or bottom
  edge: scroll, click to apply, favorite or trash. Its controls sit in a tab on the
  strip; collapse it to just the tab. Three thumbnail sizes; file names on hover,
  always or never. It stays clear of panels, including auto-hiding ones.
- **Favorites & Trash** — copy the current image to a favorites folder (or take it
  out again), or send it to the system trash and drop it from rotation.
- **Monitor detection** — reacts to plug/unplug, optionally re-checks on a timer, and
  has a manual *Refresh Monitors* action for port swaps the desktop doesn't announce.
- **Follows your theme** — the carousel takes its colours from the Cinnamon theme
  and changes with it.
- **Panel icon** — tooltip with the time to the next change and what's paused;
  scroll for previous / next; middle-click to pause.
- Optional change notifications.

## Requirements

- Cinnamon 6.6+ on X11 (Linux Mint 22.3+). Wayland sessions are not supported.
- **ImageMagick** (`convert`) for multi-monitor compositing and carousel thumbnails:
  `sudo apt install imagemagick`. Single-monitor use works without it; with two or
  more monitors and no ImageMagick, only the first monitor's image is applied.
- The settings window uses Cinnamon's own settings modules (part of `cinnamon`)
  and `python3-xapp`, both installed with Cinnamon on Linux Mint.

## Install

Copy (or symlink) the applet's inner folder into Cinnamon's user applet
directory, then add it from *System Settings → Applets*:

```sh
cp -r wallshift@inklikeurine/files/wallshift@inklikeurine ~/.local/share/cinnamon/applets/
```

Source: <https://github.com/inklikeurine/cinnamon-applets/tree/main/wallshift@inklikeurine>

## Usage

1. Add **Wallshift** to a panel (*Right-click panel → Applets*).
2. Right-click the icon → **Configure…** and pick a wallpaper folder on the General
   tab. Each detected monitor gets its own tab for folder, scaling and enable.
3. Left-click the icon for Next / Previous / Pause / Swap and the per-monitor menus
   (with one monitor its items sit directly in the menu; in Sync mode there is one
   *All monitors* submenu). Turn on *Carousel* there to browse thumbnails.
4. Scroll on the icon to step through wallpapers; middle-click to pause or resume.

Settings (*Configure…*, or the gear in *System Settings → Applets* — both open the
same window):

- **Folders** — the wallpaper folder (default for every monitor, and the pool in
  Sync mode) and the favorites folder.
- **Rotation** — interval, order, change notifications.
- **Carousel** — which edge it comes in from, thumbnail size, file names, and
  whether it closes after you pick an image.
- **Monitors** — Sync mode, the periodic re-check (on/off and interval) and
  *Refresh Monitors*.
- **One tab per monitor** — enable, scaling, and a folder of its own (the clear
  button goes back to the default folder). Tabs come and go while the window is
  open as monitors are plugged in or unplugged.

The window looks like every other applet's settings, ☰ menu included (import,
export, reset to defaults, reload the applet).

## Supported formats

JPEG, PNG, WebP, BMP, GIF (first frame), AVIF (when your ImageMagick build supports it).
Folders are scanned recursively; hidden files are skipped.

## Notes / caveats

- Runtime data lives in `~/.local/share/wallshift/` (current images, history,
  pause flags, trashed paths, per-monitor config, composite cache, thumbnails).
  Nothing is written to gsettings except the final wallpaper URI and picture option.
- Network requests: none.
- X11 only: the spanned-composite approach and the `org.cinnamon.desktop.background`
  path do not apply to Wayland.
- Animated GIFs show their first frame only. AVIF depends on the local ImageMagick build.
- Per-monitor settings follow the connector name (`HDMI-1`, `DP-2`, …). Moving a
  cable to another port moves the monitor to that port's settings.
- Minimum interval is 10 seconds to avoid back-to-back ImageMagick runs. New images
  in a folder are picked up on the next rescan (startup or a settings change), not
  immediately.
- Trash uses `gio trash`, never `rm`; Favorites copies the file. Removing a favorite
  sends the copy in the favorites folder to the system trash; an image that lives
  in the favorites folder itself is never removed that way.
- The carousel hides while a fullscreen window covers its monitor. On a portrait
  monitor it runs down the left (*Top edge*) or right (*Bottom edge*) side.
- Carousel colours are read from the theme's menu style. A theme that leaves menus
  transparent gets a neutral dark strip instead.
- Translations: strings are ready for translation (`po/`); none ship yet.
- Settings open in Wallshift's own window (`configure.py`) from both the applet's
  right-click *Configure…* and *System Settings → Applets*. `metadata.json` names it
  in `external-configuration-app` so there is only ever one settings window. It is
  built from Cinnamon's own settings widgets; it is a separate window only because
  Cinnamon's generated settings cannot add a tab per connected monitor.
- *Reset to defaults* in the ☰ menu resets the General settings, as in Cinnamon's
  own settings window; per-monitor choices are kept.

## AI-generated

This applet was generated by an AI agent under human direction. Use it at
your own risk; read the source before installing.
