"""Geometry: orientation, straighten rotation, flips, crop. Runs last, on
display-space uint8-ready arrays (via PIL for interpolated rotation)."""

from __future__ import annotations

import numpy as np
from PIL import Image

from viberoom.recipe.schema import Geometry


def apply_geometry(img: np.ndarray, geo: Geometry) -> np.ndarray:
    out = img
    if geo.orientation:
        out = np.rot90(out, k=(-geo.orientation // 90) % 4, axes=(0, 1))
    if geo.rotate:
        im = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))
        im = im.rotate(-geo.rotate, resample=Image.BICUBIC, expand=False)
        out = np.asarray(im, dtype=np.float32) / 255.0
    if geo.flipH:
        out = out[:, ::-1]
    if geo.flipV:
        out = out[::-1]
    c = geo.crop
    if (c.left, c.top, c.right, c.bottom) != (0, 0, 1, 1):
        h, w = out.shape[:2]
        y0, y1 = int(c.top * h), max(int(c.top * h) + 1, int(c.bottom * h))
        x0, x1 = int(c.left * w), max(int(c.left * w) + 1, int(c.right * w))
        out = out[y0:y1, x0:x1]
    return np.ascontiguousarray(out)
