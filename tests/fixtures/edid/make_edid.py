#!/usr/bin/python3
"""Regenerates the synthetic EDID fixtures (made-up monitors, no real data).

Each file is a 128-byte base EDID block: the fixed header, then four 18-byte
descriptors at offsets 54, 72, 90, 108. Only the descriptors matter to the
name parsers (MonitorConfig.js parseEdidName / configure.py
_parse_edid_monitor_name); expected.json holds what both must return.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
HEADER = bytes([0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00])
TIMING = bytes([0x02, 0x3A, 0x80, 0x18, 0x71, 0x38, 0x2D, 0x40, 0x58, 0x2C,
                0x45, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1E])   # a detailed timing, not a name


def text_desc(tag, payload):
    body = payload[:13]
    if len(body) < 13:
        body = body + b"\x0a" + b"\x20" * (12 - len(body))
    return bytes([0, 0, 0, tag, 0]) + body


def edid(descs):
    descs = (descs + [text_desc(0x10, b"")] * 4)[:4]   # 0x10 = dummy descriptor
    data = bytearray(HEADER + bytes(46))
    for d in descs:
        data += d
    data += bytes(128 - len(data))
    return bytes(data[:128])


CASES = {
    "named-block1.bin":    (edid([TIMING, text_desc(0xFC, b"ACME 27Q")]), "ACME 27Q"),
    "named-block4.bin":    (edid([TIMING, text_desc(0xFF, b"SN0000001"), text_desc(0xFD, b""),
                                  text_desc(0xFC, b"Contoso U32")]), "Contoso U32"),
    "no-name.bin":         (edid([TIMING, text_desc(0xFF, b"SN0000002")]), None),
    "full-13-chars.bin":   (edid([TIMING, text_desc(0xFC, b"ABCDEFGHIJKLM")]), "ABCDEFGHIJKLM"),
    "non-ascii.bin":       (edid([TIMING, text_desc(0xFC, b"Caf\xe9 View")]), "Caf View"),
    "blank-name.bin":      (edid([TIMING, text_desc(0xFC, b"     ")]), None),
    "padded-name.bin":     (edid([TIMING, text_desc(0xFC, b"  Wide 34  ")]), "Wide 34"),
    "two-names.bin":       (edid([text_desc(0xFC, b"First"), text_desc(0xFC, b"Second")]), "First"),
}

if __name__ == "__main__":
    expected = {}
    for name, (data, want) in CASES.items():
        with open(os.path.join(HERE, name), "wb") as f:
            f.write(data)
        expected[name] = want
    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump({"names": expected,
                   "candidates": {"HDMI-1": ["HDMI-1", "HDMI-A-1", "HDMI-B-1"],
                                  "HDMI-12": ["HDMI-12", "HDMI-A-12", "HDMI-B-12"],
                                  "HDMI-A-1": ["HDMI-A-1"],
                                  "DP-2": ["DP-2"],
                                  "eDP-1": ["eDP-1"],
                                  "Monitor-0": ["Monitor-0"]}}, f, indent=2)
        f.write("\n")
