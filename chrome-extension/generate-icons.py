"""Render the repository-native DSH monitor glyph using only the Python standard library."""
import math
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parent


def inside_round_rect(x, y, left, top, right, bottom, radius):
    if not left <= x <= right or not top <= y <= bottom:
        return False
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def segment(x, y, x1, y1, x2, y2, width):
    length = (x2 - x1) ** 2 + (y2 - y1) ** 2
    t = min(max(((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / length, 0), 1)
    return math.hypot(x - x1 - t * (x2 - x1), y - y1 - t * (y2 - y1)) <= width / 2


def pixel(x, y):
    if not inside_round_rect(x, y, 0, 0, 64, 64, 16):
        return (0, 0, 0, 0)
    color = (112, 80, 232, 255)
    monitor = inside_round_rect(x, y, 10, 13, 54, 45, 6) and not inside_round_rect(x, y, 13, 16, 51, 42, 3)
    stand = segment(x, y, 32, 45, 32, 51, 3) or segment(x, y, 25, 51, 39, 51, 3)
    if monitor or stand or segment(x, y, 12, 23, 52, 23, 2):
        color = (255, 255, 255, 255)
    if math.hypot(x - 47, y - 43) <= 9:
        color = (255, 255, 255, 255)
        if 43.5 <= x <= 50.5 and 39.5 <= y <= 46.5:
            color = (112, 80, 232, 255)
    return color


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)


for size in (16, 32, 48, 128):
    rows = bytearray()
    for row in range(size):
        rows.append(0)
        for column in range(size):
            samples = [pixel((column + (sx + .5) / 4) * 64 / size,
                             (row + (sy + .5) / 4) * 64 / size)
                       for sy in range(4) for sx in range(4)]
            rows.extend(round(sum(sample[channel] for sample in samples) / 16) for channel in range(4))
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(rows, 9))
    png += chunk(b'IEND', b'')
    (ROOT / f'icon-{size}.png').write_bytes(png)
