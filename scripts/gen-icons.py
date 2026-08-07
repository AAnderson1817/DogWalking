#!/usr/bin/env python3
"""Install the byte-approved Sanpo app icons into the PWA public directory."""

import os
import shutil

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "app", "public", "icons")
SOURCE = os.path.join(ROOT, "app", "src", "assets", "brand")
os.makedirs(OUT, exist_ok=True)

for size in (192, 512):
    approved = os.path.join(SOURCE, f"sanpo-app-icon-{size}px-approved-v1.png")
    shutil.copyfile(approved, os.path.join(OUT, f"icon-{size}.png"))
    shutil.copyfile(approved, os.path.join(OUT, f"icon-maskable-{size}.png"))

shutil.copyfile(
    os.path.join(SOURCE, "sanpo-app-icon-64px-approved-derivative-v1.png"),
    os.path.join(OUT, "favicon-64.png"),
)

print(f"installed 5 approved Sanpo icons to {os.path.relpath(OUT)}")
