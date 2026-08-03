"""Geometry: orientation, straighten rotation, flips, crop. Runs last, on
display-space uint8-ready arrays (via PIL for interpolated rotation)."""

from __future__ import annotations

import numpy as np
from PIL import Image

from viberoom.recipe.schema import Geometry


def _find_coeffs(dst_quad, src_quad):
    """Projective coefficients for PIL Image.transform(PERSPECTIVE): maps
    output (dst) points to input (src) points."""
    a = []
    for (x, y), (u, v) in zip(dst_quad, src_quad):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    b = np.array(src_quad, dtype=np.float64).reshape(8)
    return np.linalg.solve(np.array(a, dtype=np.float64), b)


def _apply_perspective(out: np.ndarray, persp) -> np.ndarray:
    h, w = out.shape[:2]
    v = persp.vertical / 100 * 0.35
    hz = persp.horizontal / 100 * 0.35
    s = 100 / persp.scale
    # destination corners map to a sampled source quad: vertical > 0 widens
    # the top of the quad, straightening verticals that converge upward;
    # horizontal does the same sideways.
    src_quad = [
        ((0 - max(v, 0)) * w, (0 - max(hz, 0)) * h),          # top-left
        ((1 + max(v, 0)) * w, (0 + min(hz, 0)) * h),          # top-right
        ((1 - min(v, 0)) * w, (1 - min(hz, 0)) * h),          # bottom-right
        ((0 + min(v, 0)) * w, (1 + max(hz, 0)) * h),          # bottom-left
    ]
    # apply scale about the center
    cxp, cyp = w / 2, h / 2
    src_quad = [((x - cxp) * s + cxp, (y - cyp) * s + cyp) for x, y in src_quad]
    dst_quad = [(0, 0), (w, 0), (w, h), (0, h)]
    coeffs = _find_coeffs(dst_quad, src_quad)
    im = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))
    im = im.transform((w, h), Image.PERSPECTIVE, tuple(coeffs), resample=Image.BICUBIC)
    return np.asarray(im, dtype=np.float32) / 255.0


def apply_geometry(img: np.ndarray, geo: Geometry) -> np.ndarray:
    out = img
    if geo.orientation:
        out = np.rot90(out, k=(-geo.orientation // 90) % 4, axes=(0, 1))
    p = geo.perspective
    if p.vertical or p.horizontal or p.scale != 100:
        out = _apply_perspective(out, p)
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
