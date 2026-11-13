#!/usr/bin/env python3
"""Draws the app icons (the sun-yellow stopwatch) as PNG, with no dependencies.

    python3 scripts/make-icons.py

Writes public/apple-touch-icon.png (the iOS "web clip") and the two sizes the
web manifest asks for. The same mark, as a vector, lives in public/favicon.svg.
"""
import math
import struct
import zlib
from pathlib import Path

CREAM = (249, 246, 243)
SUN = (253, 212, 107)
SKY = (93, 205, 241)
CORAL = (253, 151, 109)
INK = (27, 22, 36)
SAMPLES = 4  # 4x4 supersampling per pixel
MARK = 0.66  # share of the icon the 32-unit drawing takes


def segment_distance(px, py, ax, ay, bx, by):
    """Distance from a point to a line segment."""
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def knob_distance(u, v):
    """Signed distance to the rounded rectangle of the stopwatch button."""
    qx, qy = abs(u - 16) - 3.25 + 1.5, abs(v - 4) - 2.5 + 1.5
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - 1.5


def colour_at(x, y):
    """Colour of the icon at a point of the unit square (0..1).

    The point is taken to the 32-unit grid of public/favicon.svg, and the
    shapes are tested from the top one to the bottom one.
    """
    u, v = (x - 0.5) / MARK * 32 + 16, (y - 0.5) / MARK * 32 + 15.5
    face = math.hypot(u - 16, v - 17)
    hands = min(segment_distance(u, v, 16, 17, 16, 10.25), segment_distance(u, v, 16, 17, 21.63, 20.25))
    if hands <= 1.2:
        return INK
    if face <= 9.25:
        angle = math.degrees(math.atan2(u - 16, 17 - v))  # clockwise from 12 o'clock
        return SKY if 0 <= angle <= 120 else SUN
    if face <= 11.75:
        return INK
    knob = knob_distance(u, v)
    if knob <= -1:
        return CORAL
    if knob <= 1:
        return INK
    if math.hypot(u - 16, v - 19) <= 11.75:
        return INK
    return CREAM


def png(size):
    """PNG bytes of the icon at `size` x `size` pixels."""
    rows = bytearray()
    for py in range(size):
        rows.append(0)
        for px in range(size):
            total = [0, 0, 0]
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    c = colour_at((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size)
                    total[0] += c[0]
                    total[1] += c[1]
                    total[2] += c[2]
            rows.extend(round(v / SAMPLES**2) for v in total)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    public = Path(__file__).resolve().parent.parent / "public"
    for name, size in (("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)):
        (public / name).write_bytes(png(size))
        print(name, size)
