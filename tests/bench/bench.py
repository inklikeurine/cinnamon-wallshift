#!/usr/bin/python3
"""Wallshift resource bench (0.2.3 refactor, Phase 0 / Phase 5).

Not a test suite: it measures, it does not assert. Run from the applet repo:

    python3 tests/bench/bench.py <label> [--live]

Writes ../cinnamon-tools/out/wallshift@inklikeurine/bench-<label>.json and prints it.

Headless (always):
  - process launches for a pool setup: two monitors, independent, one folder
  - process launches + wall time for 24 carousel thumbnails on a cold cache
  - wall time and peak memory of one 2-monitor composite (1920x1080 + 2560x1440,
    4K sources) — the imagetool.py process alone
--live (touches the running session only through org.Cinnamon.Eval):
  - Cinnamon RSS before / after 10 carousel open + close cycles on the first
    monitor. Changes no wallpaper, setting or history.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import gi
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf  # noqa: E402

HERE = Path(__file__).resolve().parent
TESTS = HERE.parent
REPO = TESTS.parent
UUID = "wallshift@inklikeurine"
APPLET = REPO / "files" / UUID
TOOLS = REPO.parent / "cinnamon-tools"
OUT = TOOLS / "out" / UUID
THUMBS = 24


def make_images(d, n, w, h):
    paths = []
    for i in range(n):
        pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, w, h)
        pb.fill(((i * 37) % 256) << 24 | ((i * 91) % 256) << 16 | ((i * 53) % 256) << 8 | 0xFF)
        p = os.path.join(d, f"img{i:03d}.jpg")
        pb.savev(p, "jpeg", ["quality"], ["90"])
        paths.append(p)
    return paths


def composite(src_a, src_b, out):
    job = {"width": 4480, "height": 1440, "output": out, "monitors": [
        {"path": src_a, "x": 0, "y": 0, "width": 1920, "height": 1080, "scaling": "zoom"},
        {"path": src_b, "x": 1920, "y": 0, "width": 2560, "height": 1440, "scaling": "zoom"}]}
    t0 = time.monotonic()
    p = subprocess.Popen(["/usr/bin/python3", str(APPLET / "imagetool.py"), "compose", json.dumps(job)])
    _, status, ru = os.wait4(p.pid, 0)
    return {"ok": status == 0, "ms": round((time.monotonic() - t0) * 1000), "peak_mb": round(ru.ru_maxrss / 1024, 1)}


def cinnamon_eval(js):
    r = subprocess.run(["gdbus", "call", "--session", "--dest", "org.Cinnamon", "--object-path", "/org/Cinnamon",
                        "--method", "org.Cinnamon.Eval", js], capture_output=True, text=True, timeout=30)
    return r.stdout.strip()


def rss_kb(pid):
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1])
    return 0


def live():
    pid = subprocess.run(["pgrep", "-xo", "cinnamon"], capture_output=True, text=True).stdout.strip()
    if not pid:
        return {"ran": False, "reason": "no cinnamon process"}
    a = "imports.ui.appletManager.getRunningInstancesForUuid('wallshift@inklikeurine')[0]"
    if "true" not in cinnamon_eval(f"!!{a}"):
        return {"ran": False, "reason": "wallshift not running"}
    raw = cinnamon_eval(f"{a}._metadata.version")   # (true, '"0.2.2"')
    version = raw.split("'")[1].strip('"') if "'" in raw else raw
    before = rss_kb(pid)
    for _ in range(10):
        cinnamon_eval(f"(function(){{const a={a}; const m=a._monitorManager.getMonitors()[0]; a._carouselManager.openCarousel(m); return true;}})()")
        time.sleep(1.5)
        cinnamon_eval(f"(function(){{const a={a}; const m=a._monitorManager.getMonitors()[0]; a._carouselManager.closeCarousel(m.name, false); return true;}})()")
        time.sleep(0.5)
    cinnamon_eval("global.gc(); true")
    time.sleep(2)
    after = rss_kb(pid)
    return {"ran": True, "version": version, "cycles": 10, "rss_before_mb": round(before / 1024, 1),
            "rss_after_mb": round(after / 1024, 1), "delta_mb": round((after - before) / 1024, 1)}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit("usage: bench.py <label> [--live]")
    label = args[0]
    version = json.loads((APPLET / "metadata.json").read_text())["version"]
    result = {"label": label, "version": version, "date": time.strftime("%Y-%m-%d %H:%M")}
    with tempfile.TemporaryDirectory(prefix="wallshift-bench-") as tmp:
        imgs = os.path.join(tmp, "imgs")
        os.mkdir(imgs)
        make_images(imgs, THUMBS, 1920, 1080)
        r = subprocess.run(["cjs", str(HERE / "bench.js"), str(APPLET), str(TOOLS / "harness"), str(TESTS),
                            imgs, str(THUMBS)], capture_output=True, text=True, timeout=180)
        line = [ln for ln in r.stdout.splitlines() if ln.startswith("{")]
        result.update(json.loads(line[-1]) if line else {"error": (r.stdout + r.stderr)[-2000:]})
        big = make_images(tmp, 2, 3840, 2160)
        result["composite"] = composite(big[0], big[1], os.path.join(tmp, "out.jpg"))
    result["live"] = live() if "--live" in sys.argv else {"ran": False, "reason": "not requested"}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"bench-{label}.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
