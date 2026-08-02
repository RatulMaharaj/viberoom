"""Detail operations: noise reduction (gaussian-based) then unsharp-mask
sharpening. numpy-only separable convolutions — no OpenCV dependency."""

from __future__ import annotations

import numpy as np

from viberoom.recipe.schema import Detail


def _gaussian_kernel(sigma: float) -> np.ndarray:
    radius = max(1, int(sigma * 3))
    x = np.arange(-radius, radius + 1, dtype=np.float32)
    k = np.exp(-(x ** 2) / (2 * sigma ** 2))
    return k / k.sum()


def _blur(img: np.ndarray, sigma: float) -> np.ndarray:
    k = _gaussian_kernel(sigma)
    out = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 0, img)
    out = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 1, out)
    return out.astype(np.float32)


def apply_detail(img: np.ndarray, detail: Detail) -> np.ndarray:
    """Display-space [0,1]. NR first, then sharpening."""
    out = img
    nr = detail.noiseReduction
    if nr.luminance or nr.color:
        # Luma/chroma split via per-pixel mean: cheap, good enough for v1.
        luma = out.mean(axis=-1, keepdims=True)
        chroma = out - luma
        if nr.luminance:
            luma = _blur(luma[..., 0], 0.5 + nr.luminance / 100 * 2.0)[..., None]
        if nr.color:
            chroma = _blur(chroma, 0.5 + nr.color / 100 * 3.0)
        out = np.clip(luma + chroma, 0, 1)

    sh = detail.sharpening
    if sh.amount:
        blurred = _blur(out, sh.radius)
        high = out - blurred
        # `detail` damps flat areas: threshold the high-pass magnitude
        strength = sh.amount / 100 * (0.5 + sh.detail / 100)
        out = np.clip(out + high * strength * 2.0, 0, 1)
    return out
