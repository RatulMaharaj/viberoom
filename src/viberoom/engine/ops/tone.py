"""Tone operations. Exposure and region recovery run in linear light;
contrast and the tone curve run in display (sRGB-gamma) space, matching how
Lightroom-style sliders feel."""

from __future__ import annotations

import numpy as np

from viberoom.recipe.schema import Tone, ToneCurve


def _luma(img: np.ndarray) -> np.ndarray:
    return img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722


def apply_exposure(img: np.ndarray, ev: float) -> np.ndarray:
    if ev == 0:
        return img
    return img * (2.0 ** ev)


def apply_regions(img: np.ndarray, tone: Tone) -> np.ndarray:
    """Highlights/shadows/whites/blacks via smooth luminance-masked gains
    in linear space. Directionally Lightroom-like, not a clone."""
    if not (tone.highlights or tone.shadows or tone.whites or tone.blacks):
        return img
    luma = np.clip(_luma(img), 0, 1)[..., None]

    out = img
    if tone.highlights:
        mask = luma ** 2  # weights bright regions
        if tone.highlights < 0:
            # recover: compress brights toward mid
            out = out * (1 + (tone.highlights / 100) * 0.6 * mask)
        else:
            # lift brights toward white
            out = out + (tone.highlights / 100) * 0.4 * mask * np.clip(1 - out, 0, 1)
    if tone.shadows:
        mask = (1 - luma) ** 2  # weights dark regions
        out = out + (tone.shadows / 100) * 0.35 * mask
    if tone.whites:
        mask = np.clip(luma * 1.5 - 0.5, 0, 1) ** 3
        out = out + (tone.whites / 100) * 0.5 * mask * (1.2 - out)
    if tone.blacks:
        mask = np.clip(1 - luma * 3, 0, 1) ** 2
        out = out + (tone.blacks / 100) * 0.25 * mask
    return np.clip(out, 0, None)


def apply_contrast(img: np.ndarray, contrast: float) -> np.ndarray:
    """Sigmoid contrast around mid-gray, display space [0,1]."""
    if contrast == 0:
        return img
    k = 1 + abs(contrast) / 100 * 1.5
    x = np.clip(img, 0, 1)
    sig = 1 / (1 + np.exp(-k * 4 * (x - 0.5)))
    lo = 1 / (1 + np.exp(k * 2))
    hi = 1 / (1 + np.exp(-k * 2))
    sig = (sig - lo) / (hi - lo)
    t = abs(contrast) / 100
    return x * (1 - t) + (sig if contrast > 0 else x + (x - sig)) * t


def apply_tone_curve(img: np.ndarray, curve: ToneCurve) -> np.ndarray:
    """Monotone piecewise-linear LUT in display space."""
    pts = curve.points
    if pts == [(0.0, 0.0), (255.0, 255.0)] or pts == [(0, 0), (255, 255)]:
        return img
    xs = np.array([p[0] for p in pts]) / 255.0
    ys = np.array([p[1] for p in pts]) / 255.0
    lut_x = np.linspace(0, 1, 1024)
    lut_y = np.interp(lut_x, xs, ys)
    idx = np.clip((np.clip(img, 0, 1) * 1023).astype(np.int32), 0, 1023)
    return lut_y[idx].astype(np.float32)
