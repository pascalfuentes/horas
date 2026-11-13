#!/usr/bin/env python3
"""Draws the app icons (the sun-yellow clock) as PNG, with no dependencies.

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
INK = (27, 22, 36)
SAMPLES = 4  # 4x4 supersampling per pixel


def segment_distance(px, py, ax, ay, bx, by):
    """Distance from a point to a line segment."""
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def colour_at(x, y):
    """Colour of the icon at a point of the unit square (0..1)."""
    d = math.hypot(x - 0.5, y - 0.5)
    hands = min(segment_distance(x, y, 0.5, 0.5, 0.5, 0.315), segment_distance(x, y, 0.5, 0.5, 0.625, 0.575))
    if hands <= 0.034:
        return INK
    if d <= 0.265:
        return SUN
    if d <= 0.335:
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
