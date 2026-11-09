#!/usr/bin/python3
"""imagetool.py (0.2.1, replaces ImageMagick): every scaling mode checked by
pixel colour, placement on a multi-monitor canvas, transparency over black,
thumbnails, and the failure paths (non-zero exit, message on stderr, no
half-written or clobbered output). Test images are made with GdkPixbuf, so
the suite itself needs no ImageMagick either."""
import json, os, subprocess, sys, tempfile

import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf

APPLET = sys.argv[1]
TOOL = os.path.join(APPLET, 'imagetool.py')
fails = 0
def check(cond, msg):
    global fails
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond: fails += 1

tmp = tempfile.mkdtemp(prefix='wallshift-imagetool-')
RED, BLUE, GREEN, BLACK, WHITE = (255, 0, 0), (0, 0, 255), (0, 255, 0), (0, 0, 0), (255, 255, 255)

def make(name, w, h, blocks, alpha=False, fmt='png'):
    """An image filled with blocks [(x, y, w, h, (r, g, b[, a]))], first block = background."""
    pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, alpha, 8, w, h)
    for bx, by, bw, bh, c in blocks:
        r, g, b = c[:3]
        a = c[3] if len(c) > 3 else 255
        pb.new_subpixbuf(bx, by, bw, bh).fill((r << 24) | (g << 16) | (b << 8) | a)
    path = os.path.join(tmp, name)
    pb.savev(path, fmt, [], [])
    return path

def px(path, x, y):
    pb = GdkPixbuf.Pixbuf.new_from_file(path)
    data, n, rs = pb.get_pixels(), pb.get_n_channels(), pb.get_rowstride()
    i = y * rs + x * n
    return tuple(data[i:i + 3])

def near(c, want, tol=40):
    return all(abs(a - b) <= tol for a, b in zip(c, want))

def tool(*args):
    return subprocess.run(['/usr/bin/python3', TOOL] + [str(a) for a in args],
                          capture_output=True, text=True, timeout=60)

def compose(width, height, monitors, out):
    return tool('compose', json.dumps({'width': width, 'height': height, 'output': out, 'monitors': monitors}))

def one(src, scaling, w=100, h=100):
    """Compose src into a single w×h region at the canvas origin; return the output path."""
    out = os.path.join(tmp, 'one-%s.jpg' % scaling)
    r = compose(w, h, [dict(path=src, x=0, y=0, width=w, height=h, scaling=scaling)], out)
    check(r.returncode == 0, '%s: exit 0 (%s)' % (scaling, r.stderr.strip()))
    return out

def parts():
    return [f for f in os.listdir(tmp) if f.endswith('.part')]

# 200×100, left half red, right half blue.
wide = make('wide.png', 200, 100, [(0, 0, 200, 100, RED), (100, 0, 100, 100, BLUE)])

print('scaling modes (200×100 red|blue source into a 100×100 region)')
o = one(wide, 'zoom')
check(near(px(o, 25, 50), RED) and near(px(o, 75, 50), BLUE), 'zoom: fills the region, centre kept')
check(near(px(o, 25, 2), RED) and near(px(o, 75, 97), BLUE), 'zoom: no black bar top or bottom')
check(near(px(o, 2, 50), RED), 'zoom: sides cropped (left edge is red, not black)')

o = one(wide, 'fit')
check(near(px(o, 50, 10), BLACK) and near(px(o, 50, 90), BLACK), 'fit: black bars top and bottom')
check(near(px(o, 25, 50), RED) and near(px(o, 75, 50), BLUE), 'fit: whole image visible between the bars')

o = one(wide, 'stretch')
check(near(px(o, 10, 5), RED) and near(px(o, 90, 95), BLUE), 'stretch: corners filled, no bars')
check(near(px(o, 40, 50), RED) and near(px(o, 60, 50), BLUE), 'stretch: split stays at the middle')

small = make('small.png', 40, 20, [(0, 0, 40, 20, GREEN)])
o = one(small, 'center')
check(near(px(o, 50, 50), GREEN), 'center: small image in the middle, unscaled')
check(near(px(o, 25, 50), BLACK) and near(px(o, 50, 30), BLACK), 'center: black around it (40×20 not enlarged)')
o = one(wide, 'center')
check(near(px(o, 25, 50), RED) and near(px(o, 75, 50), BLUE) and near(px(o, 2, 2), RED),
      'center: larger image cropped around its middle')

tile = make('tile.png', 40, 40, [(0, 0, 40, 40, RED), (0, 0, 10, 10, GREEN)])
o = one(tile, 'tile')
check(all(near(px(o, x, y), GREEN) for x, y in [(5, 5), (45, 5), (85, 5), (5, 45), (45, 85)]),
      'tile: marker repeats every 40 px from the top-left')
check(all(near(px(o, x, y), RED) for x, y in [(25, 25), (65, 25), (25, 65)]), 'tile: rest of each tile intact')

print('canvas placement (two regions, second one lower)')
out = os.path.join(tmp, 'canvas.jpg')
r = compose(300, 160, [dict(path=make('r.png', 64, 36, [(0, 0, 64, 36, RED)]), x=0, y=0, width=160, height=90, scaling='zoom'),
                       dict(path=make('b.png', 30, 40, [(0, 0, 30, 40, BLUE)]), x=160, y=40, width=140, height=120, scaling='zoom')], out)
check(r.returncode == 0, 'exit 0')
pb = GdkPixbuf.Pixbuf.new_from_file(out)
check((pb.get_width(), pb.get_height()) == (300, 160), 'canvas is the size given')
check(GdkPixbuf.Pixbuf.get_file_info(out)[0].get_name() == 'jpeg', 'output is a JPEG')
check(near(px(out, 80, 45), RED) and near(px(out, 230, 100), BLUE), 'each image lands in its own region')
check(near(px(out, 230, 20), BLACK), 'above the lower region: black')
check(near(px(out, 80, 130), BLACK), 'below the shorter region: black')
check(near(px(out, 158, 45), RED) and near(px(out, 162, 100), BLUE), 'regions meet without a gap or overlap')

print('transparency')
clear = make('clear.png', 50, 50, [(0, 0, 50, 50, (255, 255, 255, 0))], alpha=True)
o = one(clear, 'zoom')
check(near(px(o, 50, 50), BLACK), 'fully transparent pixels show black (ImageMagick showed white)')
half = make('half.png', 50, 50, [(0, 0, 50, 50, (255, 255, 255, 128))], alpha=True)
o = one(half, 'fit')
check(near(px(o, 50, 50), (128, 128, 128), 20), 'half-transparent white over black is mid-grey')

print('formats')
for fmt, ext in [('jpeg', 'jpg'), ('bmp', 'bmp'), ('webp', 'webp')]:
    try:
        p = make('fmt.' + ext, 80, 60, [(0, 0, 80, 60, BLUE)], fmt=fmt)
    except Exception as e:
        print('  skip %s: no GdkPixbuf saver on this machine (%s)' % (fmt, e))
        continue
    o = one(p, 'zoom')
    check(near(px(o, 50, 50), BLUE), '%s source' % fmt)

print('animated GIF over 64 KiB (GdkPixbuf 2.42 refuses a scaled load of it)')
gif = os.path.join(sys.argv[2], 'fixtures', 'animated-over-64k.gif')
for scaling in ('zoom', 'fit', 'stretch', 'center', 'tile'):
    o = one(gif, scaling)
    check(GdkPixbuf.Pixbuf.get_file_info(o)[1:] == (100, 100), 'gif %s: composite written' % scaling)
r = tool('thumb', gif, 250, 140, os.path.join(tmp, 'gif-thumb.jpg'))
check(r.returncode == 0, 'gif thumb: exit 0 (%s)' % r.stderr.strip())

print('thumbnails')
t = os.path.join(tmp, 'thumb.jpg')
r = tool('thumb', wide, 250, 140, t)
pb = GdkPixbuf.Pixbuf.new_from_file(t) if r.returncode == 0 else None
check(pb is not None and (pb.get_width(), pb.get_height()) == (250, 140), 'landscape thumb is exactly 250×140')
check(pb is not None and near(px(t, 60, 70), RED) and near(px(t, 190, 70), BLUE), 'thumb is fill-and-crop (zoom)')
r = tool('thumb', wide, 140, 250, t)
pb = GdkPixbuf.Pixbuf.new_from_file(t) if r.returncode == 0 else None
check(pb is not None and (pb.get_width(), pb.get_height()) == (140, 250), 'portrait thumb is exactly 140×250')

print('failures')
out = os.path.join(tmp, 'keep.jpg')
compose(100, 100, [dict(path=wide, x=0, y=0, width=100, height=100, scaling='zoom')], out)
before = os.stat(out).st_mtime_ns
junk = os.path.join(tmp, 'junk.jpg'); open(junk, 'w').write('not an image')
for name, src in [('missing file', os.path.join(tmp, 'nope.jpg')), ('not an image', junk)]:
    r = compose(100, 100, [dict(path=src, x=0, y=0, width=100, height=100, scaling='zoom')], out)
    check(r.returncode == 1 and 'not a readable image' in r.stderr, '%s: exit 1 with a message' % name)
    r = tool('thumb', src, 250, 140, os.path.join(tmp, 'bad-thumb.jpg'))
    check(r.returncode == 1 and not os.path.exists(os.path.join(tmp, 'bad-thumb.jpg')), '%s: thumb fails, writes nothing' % name)
check(os.stat(out).st_mtime_ns == before, 'existing output left alone on failure')
# A missing folder rather than a read-only one: root (or a user namespace) writes through 0555.
r = compose(100, 100, [dict(path=wide, x=0, y=0, width=100, height=100, scaling='zoom')],
            os.path.join(tmp, 'gone', 'out.jpg'))
check(r.returncode == 1 and r.stderr.strip() != '', 'unwritable output path: exit 1 with a message')
check(parts() == [] and not os.path.exists(os.path.join(tmp, 'gone')), 'no .part files left behind')
check(tool('compose', '{bad json').returncode == 1, 'malformed job: exit 1')
check(tool().returncode == 2 and tool('thumb', wide).returncode == 2, 'wrong arguments: usage, exit 2')

print('batch thumbnails (0.2.3)')
jobs = [[wide, 250, 140, os.path.join(tmp, 'b1.jpg')],
        [junk, 250, 140, os.path.join(tmp, 'b2.jpg')],
        [wide, 140, 250, os.path.join(tmp, 'b3.jpg')]]
r = tool('thumbs', json.dumps(jobs))
lines = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
check(r.returncode == 0, 'exit 0 even with a bad image in the batch')
check([l['output'] for l in lines] == [j[3] for j in jobs], 'one result line per job, in order')
check([l['ok'] for l in lines] == [True, False, True], 'the bad image fails alone')
check('not a readable image' in lines[1].get('error', ''), 'failure line carries the reason')
sizes = [(GdkPixbuf.Pixbuf.new_from_file(j[3]).get_width(), GdkPixbuf.Pixbuf.new_from_file(j[3]).get_height())
         for j, l in zip(jobs, lines) if l['ok']]
check(sizes == [(250, 140), (140, 250)], 'batch thumbnails have the requested sizes')
check(not os.path.exists(jobs[1][3]) and parts() == [], 'nothing written for the bad one, no .part left')
check(tool('thumbs', '{bad json').returncode == 1, 'malformed batch: exit 1')

print('file')
check(os.access(TOOL, os.X_OK), 'imagetool.py is executable')
check(open(TOOL).readline().strip() == '#!/usr/bin/python3', 'shebang is /usr/bin/python3')
src = open(TOOL).read()
check('subprocess' not in src and 'magick' not in src.lower(), 'runs nothing else, mentions no ImageMagick')

print(('PASSED' if fails == 0 else 'FAILED') + f' ({fails} failures)')
sys.exit(1 if fails else 0)
