"""Local adjustments: per-mask weight maps blended with locally re-adjusted
pixels. Runs after geometry so mask coordinates are normalized 0-1 in the
final rendered frame — exactly what an agent sees in render_preview.

All local math is display-space [0,1]; exposure/temp/tint work in a
gamma-linearized copy so they feel like their global counterparts."""

from __future__ import annotations

import numpy as np

from viberoom.engine.ops.blur import fast_blur
from viberoom.engine.ops.presence import apply_clarity, apply_dehaze
from viberoom.engine.ops.tone import apply_contrast, apply_regions
from viberoom.recipe.schema import (
    ColorRangeMask,
    LinearGradientMask,
    LocalAdjustments,
    LuminanceRangeMask,
    Mask,
    RadialGradientMask,
    Tone,
)

_GAMMA = 2.2


def _luma(img: np.ndarray) -> np.ndarray:
    return img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722


def _smoothstep(edge0: np.ndarray | float, edge1: np.ndarray | float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / np.maximum(np.asarray(edge1) - edge0, 1e-6), 0, 1)
    return t * t * (3 - 2 * t)


def _coord_grids(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    """Normalized pixel-center coordinates: x in [0,1] by width, y by height."""
    y = (np.arange(h, dtype=np.float32) + 0.5) / h
    x = (np.arange(w, dtype=np.float32) + 0.5) / w
    return np.broadcast_to(x[None, :], (h, w)), np.broadcast_to(y[:, None], (h, w))


def mask_weight(mask: Mask, img: np.ndarray) -> np.ndarray:
    """HxW float weight in [0,1] for one mask over the current image."""
    h, w = img.shape[:2]
    if isinstance(mask, LinearGradientMask):
        xx, yy = _coord_grids(h, w)
        dx, dy = mask.end[0] - mask.start[0], mask.end[1] - mask.start[1]
        norm = dx * dx + dy * dy
        if norm < 1e-9:
            weight = np.ones((h, w), dtype=np.float32)
        else:
            t = ((xx - mask.start[0]) * dx + (yy - mask.start[1]) * dy) / norm
            weight = 1.0 - _smoothstep(0.0, 1.0, t)
    elif isinstance(mask, RadialGradientMask):
        xx, yy = _coord_grids(h, w)
        d = np.sqrt(
            ((xx - mask.center[0]) / mask.radiusX) ** 2
            + ((yy - mask.center[1]) / mask.radiusY) ** 2
        )
        inner = 1.0 - mask.feather / 100
        weight = 1.0 - _smoothstep(inner, 1.0, d)
    elif isinstance(mask, LuminanceRangeMask):
        lum = np.clip(_luma(np.clip(img, 0, 1)), 0, 1) * 100
        f = max(mask.feather / 100 * 20, 0.5)  # feather in luma units
        # ends of the range are open: lumMin=0 selects all darks fully, etc.
        lo = np.ones_like(lum) if mask.lumMin <= 0 else _smoothstep(mask.lumMin - f, mask.lumMin + f, lum)
        hi = np.zeros_like(lum) if mask.lumMax >= 100 else _smoothstep(mask.lumMax - f, mask.lumMax + f, lum)
        weight = lo * (1.0 - hi)
    elif isinstance(mask, ColorRangeMask):
        x = np.clip(img, 0, 1)
        maxc, minc = x.max(axis=-1), x.min(axis=-1)
        delta = maxc - minc
        sat = np.where(maxc > 1e-6, delta / np.maximum(maxc, 1e-6), 0)
        r, g, b = x[..., 0], x[..., 1], x[..., 2]
        hdeg = np.degrees(np.arctan2(np.sqrt(3) * (g - b), 2 * r - g - b)) % 360
        dist = np.abs(((hdeg - mask.hue + 180) % 360) - 180)
        weight = np.clip(1.0 - dist / mask.range, 0, 1) * np.clip(sat * 2, 0, 1)
    else:  # pragma: no cover - schema keeps this unreachable
        weight = np.zeros((h, w), dtype=np.float32)

    weight = weight.astype(np.float32)
    if mask.invert:
        weight = 1.0 - weight
    return weight * (mask.opacity / 100)


def _adjust(img: np.ndarray, adj: LocalAdjustments) -> np.ndarray:
    """Apply the local sliders to the whole frame (blending happens later)."""
    out = np.clip(img, 0, 1)

    if adj.exposure or adj.temp or adj.tint or adj.highlights or adj.shadows:
        lin = out ** _GAMMA
        if adj.exposure:
            lin = lin * (2.0 ** adj.exposure)
        if adj.temp or adj.tint:
            rg = 2.0 ** (adj.temp / 100 * 0.35)
            gg = 2.0 ** (-adj.tint / 100 * 0.25)
            lin = lin * np.array([rg, gg, 1.0 / rg], dtype=np.float32)
        if adj.highlights or adj.shadows:
            lin = apply_regions(lin, Tone(highlights=adj.highlights, shadows=adj.shadows))
        out = np.clip(lin, 0, None) ** (1 / _GAMMA)

    if adj.contrast:
        out = apply_contrast(out, adj.contrast)
    if adj.dehaze:
        out = apply_dehaze(out, adj.dehaze)
    if adj.clarity:
        out = apply_clarity(out, adj.clarity)
    if adj.saturation:
        gray = _luma(out)[..., None]
        out = np.clip(gray + (out - gray) * (1.0 + adj.saturation / 100), 0, 1)
    if adj.sharpness:
        sigma = max(1.0, min(out.shape[0], out.shape[1]) / 1500)
        blurred = fast_blur(out, sigma)
        out = np.clip(out + (out - blurred) * (adj.sharpness / 100) * 1.5, 0, 1)

    return np.clip(out, 0, 1)


def apply_masks(img: np.ndarray, masks: list[Mask]) -> np.ndarray:
    if not masks:
        return img
    out = np.clip(img, 0, 1)
    for mask in masks:
        if mask.adjustments == LocalAdjustments() or mask.opacity == 0:
            continue
        weight = mask_weight(mask, out)
        if weight.max() < 1e-4:
            continue
        adjusted = _adjust(out, mask.adjustments)
        out = out * (1.0 - weight[..., None]) + adjusted * weight[..., None]
    return out
