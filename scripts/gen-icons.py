#!/usr/bin/env python3
"""Generate the PawTrail icon set (v2 Biscuit palette paw mark).

Writes app/public/icons/{icon-192,icon-512,icon-maskable-192,
icon-maskable-512,favicon-64}.png. Placeholder marks per phase 02; the
full branded set lands in phase 08.
"""
import os
from PIL import Image, ImageDraw

INK = (59, 42, 32, 255)         # #3B2A20
ORANGE = (255, 107, 53, 255)    # #FF6B35
SKY = (56, 189, 248, 255)       # #38BDF8
CREAM = (255, 246, 233, 255)    # #FFF6E9

OUT = os.path.join(os.path.dirname(__file__), "..", "app", "public", "icons")
os.makedirs(OUT, exist_ok=True)


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def paw(draw, cx, cy, scale, color):
    """Simple paw: main pad + three toes."""
    pad_w, pad_h = 0.46 * scale, 0.38 * scale
    draw.ellipse(
        [cx - pad_w / 2, cy - pad_h / 2 + 0.12 * scale,
         cx + pad_w / 2, cy + pad_h / 2 + 0.12 * scale],
        fill=color,
    )
    toe_r = 0.10 * scale
    for dx, dy in [(-0.20, -0.16), (0.0, -0.24), (0.20, -0.16)]:
        tx, ty = cx + dx * scale, cy + dy * scale
        draw.ellipse([tx - toe_r, ty - toe_r, tx + toe_r, ty + toe_r], fill=color)


def make(size: int, maskable: bool) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        # Full-bleed background; keep the mark inside the 80% safe zone.
        d.rectangle([0, 0, size, size], fill=ORANGE)
        mark_scale = size * 0.55
    else:
        rounded_rect(d, [0, 0, size - 1, size - 1], radius=size * 0.22, fill=ORANGE)
        mark_scale = size * 0.62
    cx, cy = size / 2, size / 2
    paw(d, cx, cy, mark_scale, CREAM)
    # Signature live-sky dot, bottom-right of the mark.
    dot_r = size * 0.075
    dot_cx, dot_cy = cx + mark_scale * 0.34, cy + mark_scale * 0.34
    d.ellipse(
        [dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r],
        fill=SKY, outline=INK, width=max(1, size // 128),
    )
    return img


for size in (192, 512):
    make(size, maskable=False).save(os.path.join(OUT, f"icon-{size}.png"))
    make(size, maskable=True).save(os.path.join(OUT, f"icon-maskable-{size}.png"))
make(64, maskable=False).save(os.path.join(OUT, "favicon-64.png"))
print(f"wrote 5 icons to {os.path.relpath(OUT)}")
