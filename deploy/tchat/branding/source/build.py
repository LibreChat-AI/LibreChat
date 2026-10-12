#!/usr/bin/env python3
"""Regenerate every Tchat brand asset in deploy/tchat/branding/ from the SVGs here.

Writes the two served SVGs (logo.svg, tchat-mark.svg) and every PNG at its
existing filename and size, so nginx.conf and manifest.webmanifest never change.
Requires `rsvg-convert` on PATH and Pillow.
"""

import io
import re
import shutil
import subprocess
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
DIE = (0x08, 0x13, 0x12, 255)

FULL = (HERE / 'tchat-mark.svg').read_text()
SMALL = (HERE / 'tchat-mark-small.svg').read_text()


def glyph_only(svg: str) -> str:
  """Drop the rounded die so the glyph can sit on a full-bleed background."""
  return re.sub(r'\s*<rect width="24" height="24"[^>]*/>', '', svg, count=1)


def render(svg: str, px: int) -> Image.Image:
  png = subprocess.run(
    ['rsvg-convert', '-w', str(px), '-h', str(px)],
    input=svg.encode(), capture_output=True, check=True,
  ).stdout
  return Image.open(io.BytesIO(png)).convert('RGBA')


def mark(px: int) -> Image.Image:
  """Rounded die + glyph on transparency; trace-free variant at favicon sizes."""
  return render(SMALL if px <= 32 else FULL, px)


def tile(px: int, fraction: float) -> Image.Image:
  """Opaque full-bleed die with the glyph (16 of 24 units) at `fraction`."""
  side = round(px * fraction * 1.5)
  canvas = Image.new('RGBA', (px, px), DIE)
  canvas.alpha_composite(render(glyph_only(FULL), side), ((px - side) // 2,) * 2)
  return canvas


TARGETS = {
  'favicon-16x16.png': lambda: mark(16),
  'favicon-32x32.png': lambda: mark(32),
  'icon-192x192.png': lambda: mark(192),
  # iOS applies its own corner mask, so this one is opaque edge to edge.
  'apple-touch-icon-180x180.png': lambda: tile(180, 2 / 3).convert('RGB'),
  # Glyph diagonal stays inside the 80% maskable safe-zone circle.
  'maskable-icon.png': lambda: tile(512, 0.5),
}


def main() -> None:
  for name, build in TARGETS.items():
    before = Image.open(OUT / name).size
    img = build()
    assert img.size == before, (name, before, img.size)
    img.save(OUT / name, optimize=True)
  for name in ('logo.svg', 'tchat-mark.svg'):
    shutil.copyfile(HERE / 'tchat-mark.svg', OUT / name)
  print(f'rendered {len(TARGETS)} PNGs + logo.svg + tchat-mark.svg')


if __name__ == '__main__':
  main()
