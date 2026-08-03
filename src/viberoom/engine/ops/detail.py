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


def apply_detail(img: np.ndarray, detail: Detail, scale: float = 1.0) -> np.ndarray:
    """Display-space [0,1]. NR first, then sharpening.

    `scale` is the ratio of this frame's size to the full-resolution frame the
    recipe was authored against. Every other resolution-dependent op in the
    pipeline states its radius as a fraction of `min(h, w)` and so rescales
    itself; these radii are absolute pixel counts, so they need telling. A
    1.2 px sharpening radius means something quite different on a 400 px
    preview than on a 6000 px export, which is why previews have always been
    a little crunchier than the file they promise.

    Radii below ~0.3 px stop meaning anything, so heavily downscaled previews
    simply skip the op rather than convolving with a degenerate kernel.
    """
    out = img
    nr = detail.noiseReduction
    if nr.luminance or nr.color:
        # Luma/chroma split via per-pixel mean: cheap, good enough for v1.
        luma = out.mean(axis=-1, keepdims=True)
        chroma = out - luma
        if nr.luminance:
            sigma = (0.5 + nr.luminance / 100 * 2.0) * scale
            if sigma >= 0.3:
                luma = _blur(luma[..., 0], sigma)[..., None]
        if nr.color:
            sigma = (0.5 + nr.color / 100 * 3.0) * scale
            if sigma >= 0.3:
                chroma = _blur(chroma, sigma)
        out = np.clip(luma + chroma, 0, 1)

    sh = detail.sharpening
    if sh.amount and sh.radius * scale >= 0.3:
        blurred = _blur(out, sh.radius * scale)
        high = out - blurred
        # `detail` damps flat areas: threshold the high-pass magnitude
        strength = sh.amount / 100 * (0.5 + sh.detail / 100)
        out = np.clip(out + high * strength * 2.0, 0, 1)
    return out
