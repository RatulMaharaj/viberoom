"""Fast approximate gaussian blur: three chained box blurs via cumulative
sums. O(n) regardless of radius, so large-sigma ops (clarity, dehaze,
vignette-scale work) stay usable at full export resolution."""

from __future__ import annotations

import numpy as np


def _box_blur_axis(img: np.ndarray, radius: int, axis: int) -> np.ndarray:
    """Box blur along one axis with edge clamping, via cumsum."""
    n = img.shape[axis]
    if radius <= 0 or n <= 1:
        return img
    radius = min(radius, n - 1)
    pad = [(0, 0)] * img.ndim
    pad[axis] = (radius + 1, radius)
    padded = np.pad(img, pad, mode="edge")
    csum = np.cumsum(padded, axis=axis, dtype=np.float64)
    hi = np.take(csum, np.arange(2 * radius + 1, 2 * radius + 1 + n), axis=axis)
    lo = np.take(csum, np.arange(n), axis=axis)
    return ((hi - lo) / (2 * radius + 1)).astype(np.float32)


def fast_blur(img: np.ndarray, sigma: float) -> np.ndarray:
    """Approximate gaussian blur of an HxW or HxWxC float array."""
    if sigma <= 0:
        return img
    # three equal box passes approximate a gaussian; box radius from sigma
    radius = max(1, int(round(sigma * np.sqrt(12 / 3 + 1) / 2 - 0.5)))
    out = img.astype(np.float32, copy=False)
    for _ in range(3):
        out = _box_blur_axis(out, radius, 0)
        out = _box_blur_axis(out, radius, 1)
    return out
