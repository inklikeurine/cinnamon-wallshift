#!/usr/bin/python3
"""
Wallshift imagetool.py — builds the applet's images with GdkPixbuf, the image
library Cinnamon itself loads wallpapers with, so no extra package is needed.
Run by Compositor.js and ThumbnailCache.js as a separate process, so decoding
and scaling large images never stalls the desktop.

Usage:
  /usr/bin/python3 imagetool.py compose JOB_JSON
      JOB_JSON: {"width", "height", "output",
                 "monitors": [{"path", "x", "y", "width", "height", "scaling"}]}
      One black canvas the size of the whole desktop, with each monitor's image
      scaled into its region. Scaling: zoom | fit | stretch | center | tile.
  /usr/bin/python3 imagetool.py thumb IMAGE WIDTH HEIGHT OUTPUT
      A WIDTH×HEIGHT fill-and-crop thumbnail.

Output is JPEG, written beside OUTPUT and renamed into place, so a reader never
sees a half-written file. Exits non-zero with a message on stderr on failure.
"""

import json
import os
import sys

import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf, GLib


def _image_size(path):
    fmt, w, h = GdkPixbuf.Pixbuf.get_file_info(path)
    if fmt is None or w <= 0 or h <= 0:
        raise ValueError('not a readable image: ' + path)
    return w, h


def _new_canvas(w, h):
    canvas = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, w, h)
    canvas.fill(0x000000ff)
    return canvas


def _place(canvas, img, rx, ry, rw, rh, ox, oy):
    """Draw img with its top-left at (rx+ox, ry+oy), clipped to the region
    (rx, ry, rw, rh) and the canvas. Transparent pixels show the black below."""
    x0 = max(rx, rx + ox, 0)
    y0 = max(ry, ry + oy, 0)
    x1 = min(rx + rw, rx + ox + img.get_width(), canvas.get_width())
    y1 = min(ry + rh, ry + oy + img.get_height(), canvas.get_height())
    if x1 <= x0 or y1 <= y0:
        return
    img.composite(canvas, x0, y0, x1 - x0, y1 - y0, rx + ox, ry + oy,
                  1.0, 1.0, GdkPixbuf.InterpType.NEAREST, 255)


def _draw(canvas, path, rx, ry, rw, rh, scaling):
    """Scale one image into the region (rx, ry, rw, rh) of the canvas."""
    iw, ih = _image_size(path)

    if scaling == 'tile':
        img = GdkPixbuf.Pixbuf.new_from_file(path)
        for ty in range(0, rh, ih):
            for tx in range(0, rw, iw):
                _place(canvas, img, rx, ry, rw, rh, tx, ty)
        return

    if scaling == 'center':
        img = GdkPixbuf.Pixbuf.new_from_file(path)
        _place(canvas, img, rx, ry, rw, rh, (rw - iw) // 2, (rh - ih) // 2)
        return

    if scaling == 'stretch':
        sw, sh = rw, rh
    else:
        # zoom fills the region and crops the overflow; fit shows the whole
        # image and leaves black bars.
        s = max(rw / iw, rh / ih) if scaling == 'zoom' else min(rw / iw, rh / ih)
        sw, sh = max(1, round(iw * s)), max(1, round(ih * s))
    # Loading straight at the target size lets the JPEG decoder skip detail it
    # would throw away — much faster than decoding in full and then scaling.
    try:
        img = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, sw, sh, False)
    except GLib.Error:
        # GdkPixbuf 2.42 refuses a scaled load of an animated GIF over 64 KiB
        # ("Not all frames of the GIF image were loaded"); a plain load still
        # gives the first frame.
        img = GdkPixbuf.Pixbuf.new_from_file(path).scale_simple(
            sw, sh, GdkPixbuf.InterpType.BILINEAR)
    _place(canvas, img, rx, ry, rw, rh, (rw - sw) // 2, (rh - sh) // 2)


def _save(canvas, output, quality):
    tmp = output + '.part'
    try:
        canvas.savev(tmp, 'jpeg', ['quality'], [str(quality)])
        os.replace(tmp, output)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def compose(job):
    canvas = _new_canvas(int(job['width']), int(job['height']))
    for m in job['monitors']:
        _draw(canvas, m['path'], int(m['x']), int(m['y']),
              int(m['width']), int(m['height']), m.get('scaling', 'zoom'))
    _save(canvas, job['output'], 95)


def thumb(path, w, h, output):
    canvas = _new_canvas(w, h)
    _draw(canvas, path, 0, 0, w, h, 'zoom')
    _save(canvas, output, 85)


def main(argv):
    try:
        if len(argv) == 3 and argv[1] == 'compose':
            compose(json.loads(argv[2]))
        elif len(argv) == 6 and argv[1] == 'thumb':
            thumb(argv[2], int(argv[3]), int(argv[4]), argv[5])
        else:
            sys.stderr.write(__doc__)
            return 2
    except Exception as e:
        sys.stderr.write('%s\n' % e)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
