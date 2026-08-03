"""Presence operations: texture, clarity, dehaze. Display-space [0,1].
Radii scale with image size so previews and full-res exports match.

Each op takes an optional `out`: a buffer the caller owns and this op may
overwrite. Chained through `apply_presence` that turns three defensive copies
of the frame into one — see `pipeline._owned` for the ownership rule.
"""

from __future__ import annotations

import numpy as np

from viberoom.engine.ops.blur import fast_blur


def _luma(img: np.ndarray) -> np.ndarray:
    out = img[..., 0] * 0.2126
    out += img[..., 1] * 0.7152
    out += img[..., 2] * 0.0722
    return out


def _highpass(luma: np.ndarray, sigma: float) -> np.ndarray:
    """luma minus its blur, landing in the blur's own scratch buffer.

    `fast_blur` hands back a buffer it allocated, so the subtraction can
    consume it — except on a degenerate one-pixel axis, where it returns the
    input untouched and writing there would corrupt `luma`.
    """
    blurred = fast_blur(luma, sigma)
    return np.subtract(luma, blurred, out=blurred if blurred is not luma else None)


def apply_texture(img: np.ndarray, amount: float, out: np.ndarray | None = None) -> np.ndarray:
    """Fine-detail contrast: small-radius high-pass on luma. Negative smooths."""
    if amount == 0:
        return img
    x = np.clip(img, 0, 1, out=out)
    sigma = max(1.0, min(x.shape[0], x.shape[1]) / 1000)
    high = _highpass(_luma(x), sigma)
    high *= amount / 100 * 0.8
    x += high[..., None]
    return np.clip(x, 0, 1, out=x)


def apply_clarity(img: np.ndarray, amount: float, out: np.ndarray | None = None) -> np.ndarray:
    """Midtone local contrast: large-radius high-pass, weighted toward
    midtones so skies and deep shadows stay clean. Negative softens."""
    if amount == 0:
        return img
    x = np.clip(img, 0, 1, out=out)
    sigma = max(2.0, min(x.shape[0], x.shape[1]) * 0.015)
    luma = _luma(x)
    high = _highpass(luma, sigma)
    high *= amount / 100 * 0.7
    # the midtone weight folds back into luma's buffer: 1 - (2L - 1)^2
    luma *= 2.0
    luma -= 1.0
    luma *= luma
    np.subtract(1.0, luma, out=luma)
    high *= luma
    x += high[..., None]
    return np.clip(x, 0, 1, out=x)


def apply_dehaze(img: np.ndarray, amount: float, out: np.ndarray | None = None) -> np.ndarray:
    """Haze removal via a smoothed dark-channel veil estimate; negative adds
    haze. Directionally Lightroom-like, not a clone."""
    if amount == 0:
        return img
    x = np.clip(img, 0, 1, out=out)
    sigma = max(4.0, min(x.shape[0], x.shape[1]) * 0.02)
    # pairwise, not a reduction over the length-3 last axis: that axis is the
    # fastest-varying one and reducing along it defeats numpy's inner loop
    dark = np.minimum(np.minimum(x[..., 0], x[..., 1]), x[..., 2])
    s = fast_blur(dark, sigma)  # bright veil ~ haze density
    t = amount / 100
    if t > 0:
        # subtract the veil and restretch, strongest where the veil is thick
        s *= 0.7 * t
        den = 1.0 - s
        np.maximum(den, 0.2, out=den)
        x -= s[..., None]
        x /= den[..., None]
        # dehazing flattens color; give saturation a nudge proportionally
        gray = _luma(x)[..., None]
        x -= gray
        x *= 1.0 + 0.25 * t
        x += gray
    else:
        # lift toward a light atmospheric gray, weighted by existing veil
        s *= 0.6
        s += 0.4
        s *= 0.5 * (-t)
        lift = 0.85 - x
        lift *= s[..., None]
        x += lift
    return np.clip(x, 0, 1, out=x)


def apply_presence(img: np.ndarray, texture: float, clarity: float, dehaze: float) -> np.ndarray:
    # Each op returns either its input or a buffer it just allocated, so
    # "not the frame we were handed" is exactly "ours to write into".
    x = apply_dehaze(img, dehaze)
    x = apply_clarity(x, clarity, out=x if x is not img else None)
    x = apply_texture(x, texture, out=x if x is not img else None)
    return x
