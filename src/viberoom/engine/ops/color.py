"""Color operations: white balance (linear space), saturation/vibrance,
per-channel HSL and three-way color grading (display space, via HSV)."""

from __future__ import annotations

import numpy as np

from viberoom.recipe.schema import HSL, HSL_CHANNELS, Color, ColorGrading, WhiteBalance

# Channel centers on the hue wheel in degrees (Lightroom's 8 bands).
_HUE_CENTERS = {
    "red": 0, "orange": 30, "yellow": 60, "green": 120,
    "aqua": 180, "blue": 240, "purple": 280, "magenta": 320,
}
_BAND_WIDTH = 45.0  # degrees of influence falloff on each side


def apply_white_balance(img: np.ndarray, wb: WhiteBalance) -> np.ndarray:
    """Temp/tint as RGB channel gains relative to the as-shot baseline
    (5500K neutral). A pragmatic approximation, not a colorimetric CCT model."""
    if wb.temp is None and wb.tint == 0:
        return img
    r = g = b = 1.0
    if wb.temp is not None:
        # log-scale shift: >5500 warms (boost R, cut B), <5500 cools.
        shift = np.log2(wb.temp / 5500.0)
        r *= 2.0 ** (shift * 0.5)
        b *= 2.0 ** (-shift * 0.5)
    if wb.tint:
        # positive = magenta (cut G), negative = green (boost G)
        g *= 2.0 ** (-wb.tint / 150.0 * 0.3)
    return img * np.array([r, g, b], dtype=np.float32)


def _rgb_to_hsv(img: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    maxc = np.max(img, axis=-1)
    minc = np.min(img, axis=-1)
    v = maxc
    delta = maxc - minc
    s = np.where(maxc > 0, delta / np.maximum(maxc, 1e-8), 0)
    h = np.zeros_like(maxc)
    mask = delta > 1e-8
    rc = np.where(mask, (maxc - r) / np.maximum(delta, 1e-8), 0)
    gc = np.where(mask, (maxc - g) / np.maximum(delta, 1e-8), 0)
    bc = np.where(mask, (maxc - b) / np.maximum(delta, 1e-8), 0)
    h = np.where((maxc == r) & mask, bc - gc, h)
    h = np.where((maxc == g) & mask, 2.0 + rc - bc, h)
    h = np.where((maxc == b) & mask, 4.0 + gc - rc, h)
    h = (h / 6.0) % 1.0
    return h, s, v


def _hsv_to_rgb(h: np.ndarray, s: np.ndarray, v: np.ndarray) -> np.ndarray:
    i = (h * 6.0).astype(np.int32) % 6
    f = h * 6.0 - np.floor(h * 6.0)
    p = v * (1 - s)
    q = v * (1 - s * f)
    t = v * (1 - s * (1 - f))
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    return np.stack([r, g, b], axis=-1).astype(np.float32)


def apply_color(img: np.ndarray, color: Color) -> np.ndarray:
    """Saturation, vibrance and HSL bands. Expects display-space [0,1]."""
    if (
        color.saturation == 0
        and color.vibrance == 0
        and color.hsl == HSL()
    ):
        return img
    x = np.clip(img, 0, 1)
    h, s, v = _rgb_to_hsv(x)

    if color.vibrance:
        # boosts muted colors more than already-saturated ones
        amt = color.vibrance / 100
        s = np.clip(s + amt * (1 - s) * s * 2, 0, 1)
    if color.saturation:
        s = np.clip(s * (1 + color.saturation / 100), 0, 1)

    hsl = color.hsl
    if hsl != HSL():
        h_deg = h * 360.0
        for name in HSL_CHANNELS:
            ch = getattr(hsl, name)
            if ch.hue == 0 and ch.saturation == 0 and ch.luminance == 0:
                continue
            center = _HUE_CENTERS[name]
            dist = np.abs(((h_deg - center + 180) % 360) - 180)
            w = np.clip(1 - dist / _BAND_WIDTH, 0, 1) * s  # gray pixels unaffected
            if ch.hue:
                h = (h + w * (ch.hue / 100) * (30 / 360)) % 1.0
            if ch.saturation:
                s = np.clip(s * (1 + w * ch.saturation / 100), 0, 1)
            if ch.luminance:
                v = np.clip(v * (1 + w * ch.luminance / 100 * 0.5), 0, 1)

    return _hsv_to_rgb(h, s, v)


def _luma(img: np.ndarray) -> np.ndarray:
    return img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722


def apply_color_grading(img: np.ndarray, grading: ColorGrading) -> np.ndarray:
    """Shadows/midtones/highlights tint wheels. Display-space [0,1].
    Tints are chroma-only offsets (no brightness shift); luminance is a
    per-band gain."""
    if grading == ColorGrading():
        return img
    x = np.clip(img, 0, 1)
    # balance shifts which luma counts as shadow vs highlight
    luma = np.clip(_luma(x) - grading.balance / 100 * 0.25, 0, 1)
    # blending controls how far each band bleeds into the midtones
    p = 1.0 + (100 - grading.blending) / 100 * 2.0  # 1 (soft) .. 3 (tight)
    w_shadows = (1.0 - luma) ** (p + 1)
    w_highlights = luma ** (p + 1)
    w_midtones = np.clip(1.0 - w_shadows - w_highlights, 0, 1)

    for band, w in (
        (grading.shadows, w_shadows),
        (grading.midtones, w_midtones),
        (grading.highlights, w_highlights),
    ):
        if band.saturation == 0 and band.luminance == 0:
            continue
        if band.saturation:
            tint = _hsv_to_rgb(
                np.array(band.hue / 360.0), np.array(1.0), np.array(1.0)
            ).astype(np.float32)
            offset = tint - tint.mean()  # chroma only: zero net brightness
            x = x + w[..., None] * (band.saturation / 100 * 0.35) * offset
        if band.luminance:
            x = x * (1.0 + w[..., None] * band.luminance / 100 * 0.4)
    return np.clip(x, 0, 1)
