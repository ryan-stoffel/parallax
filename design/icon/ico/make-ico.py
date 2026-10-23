# /// script
# requires-python = ">=3.10"
# dependencies = ["resvg-py==0.2.6", "pillow==12.0.0"]
# ///
"""Renders the Windows icons, Parallax.ico and Parallax-nightly.ico, from the full-bleed masters.

Windows draws an icon as is, with no mask of its own, so each is the master's tile with rounded
corners and a little room around it, rendered at every size Explorer, the taskbar, and the
installer ask for. Run from anywhere with `uv run design/icon/ico/make-ico.py`.
"""

import io
import re
from pathlib import Path

import resvg_py
from PIL import Image

HERE = Path(__file__).parent
MASTERS = HERE.parent / "masters"
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]


def tile(master: str) -> str:
    """The master's artwork clipped to a rounded square inset from the edges."""
    inner = re.search(r"<svg[^>]*>(.*)</svg>", master, re.S).group(1)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
        '<defs><clipPath id="tile"><rect x="40" y="40" width="944" height="944" rx="200"/>'
        f'</clipPath></defs><g clip-path="url(#tile)">{inner}</g></svg>'
    )


def render(svg: str, size: int) -> Image.Image:
    png = bytes(resvg_py.svg_to_bytes(svg_string=svg, width=size, height=size))
    return Image.open(io.BytesIO(png)).convert("RGBA")


for name, master in [("Parallax", "Parallax-dark-full"), ("Parallax-nightly", "Parallax-nightly-full")]:
    svg = tile((MASTERS / f"{master}.svg").read_text())
    images = [render(svg, size) for size in SIZES]
    out = HERE / f"{name}.ico"
    images[-1].save(out, sizes=[(s, s) for s in SIZES], append_images=images[:-1])
    print(f"wrote {out}")
