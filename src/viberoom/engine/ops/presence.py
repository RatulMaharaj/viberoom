"""Presence operations: texture, clarity, dehaze. Display-space [0,1].
Radii scale with image size so previews and full-res exports match."""

from __future__ import annotations

import numpy as np

from viberoom.engine.ops.blur import fast_blur


def _luma(img: np.ndarray) -> np.ndarray:
    return img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722


def apply_texture(img: np.ndarray, amount: float) -> np.ndarray:
    """Fine-detail contrast: small-radius high-pass on luma. Negative smooths."""
    if amount == 0:
        return img
    x = np.clip(img, 0, 1)
    sigma = max(1.0, min(x.shape[0], x.shape[1]) / 1000)
    luma = _luma(x)
    high = luma - fast_blur(luma, sigma)
    return np.clip(x + (amount / 100 * 0.8 * high)[..., None], 0, 1)


def apply_clarity(img: np.ndarray, amount: float) -> np.ndarray:
    """Midtone local contrast: large-radius high-pass, weighted toward
    midtones so skies and deep shadows stay clean. Negative softens."""
    if amount == 0:
        return img
    x = np.clip(img, 0, 1)
    sigma = max(2.0, min(x.shape[0], x.shape[1]) * 0.015)
    luma = _luma(x)
    high = luma - fast_blur(luma, sigma)
    midtone_w = 1.0 - np.abs(2.0 * luma - 1.0) ** 2
    return np.clip(x + (amount / 100 * 0.7 * high * midtone_w)[..., None], 0, 1)


def apply_dehaze(img: np.ndarray, amount: float) -> np.ndarray:
    """Haze removal via a smoothed dark-channel veil estimate; negative adds
    haze. Directionally Lightroom-like, not a clone."""
    if amount == 0:
        return img
    x = np.clip(img, 0, 1)
    sigma = max(4.0, min(x.shape[0], x.shape[1]) * 0.02)
    veil = fast_blur(x.min(axis=-1), sigma)  # bright veil ~ haze density
    t = amount / 100
    if t > 0:
        # subtract the veil and restretch, strongest where the veil is thick
        s = 0.7 * t * veil
        out = (x - s[..., None]) / np.maximum(1.0 - s, 0.2)[..., None]
        # dehazing flattens color; give saturation a nudge proportionally
        gray = _luma(out)[..., None]
        out = gray + (out - gray) * (1.0 + 0.25 * t)
    else:
        # lift toward a light atmospheric gray, weighted by existing veil
        s = 0.5 * (-t) * (0.4 + 0.6 * veil)
        out = x + s[..., None] * (0.85 - x)
    return np.clip(out, 0, 1)


def apply_presence(img: np.ndarray, texture: float, clarity: float, dehaze: float) -> np.ndarray:
    out = apply_dehaze(img, dehaze)
    out = apply_clarity(out, clarity)
    out = apply_texture(out, texture)
    return out
