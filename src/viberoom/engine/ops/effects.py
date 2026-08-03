"""Post-crop effects: vignette and film grain. Run last (after geometry), in
display space [0,1], so they track the final frame like Lightroom's
post-crop vignette."""

from __future__ import annotations

import numpy as np

from viberoom.engine.ops.blur import fast_blur
from viberoom.recipe.schema import Effects, Grain, Vignette


def _smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / max(edge1 - edge0, 1e-6), 0, 1)
    return t * t * (3 - 2 * t)


def apply_vignette(img: np.ndarray, vig: Vignette) -> np.ndarray:
    if vig.amount == 0:
        return img
    h, w = img.shape[:2]
    yy = (np.arange(h, dtype=np.float32) + 0.5) / h * 2 - 1
    xx = (np.arange(w, dtype=np.float32) + 0.5) / w * 2 - 1
    # superellipse distance: exponent 2 = ellipse; higher = boxier corners
    # roundness +100 -> circle-ish (higher power), -100 -> rectangle-hugging
    p = 2.0 * 2.0 ** (vig.roundness / 100)
    d = (np.abs(yy[:, None]) ** p + np.abs(xx[None, :]) ** p) ** (1 / p)
    d = d / np.sqrt(2)  # ~1.0 at the corners for the ellipse case

    start = vig.midpoint / 100  # falloff begins here
    width = 0.05 + vig.feather / 100 * 0.9
    fall = _smoothstep(start, start + width, d)
    factor = 1.0 + (vig.amount / 100) * fall
    return np.clip(np.clip(img, 0, 1) * factor[..., None], 0, 1)


def apply_grain(img: np.ndarray, grain: Grain) -> np.ndarray:
    if grain.amount == 0:
        return img
    h, w = img.shape[:2]
    # deterministic per-size seed so re-renders (and the preview cache) agree
    rng = np.random.default_rng(h * 73_856_093 ^ w * 19_349_663)
    noise = rng.standard_normal((h, w)).astype(np.float32)
    if grain.size > 0:
        sigma = grain.size / 100 * min(h, w) / 500
        if sigma >= 0.6:
            noise = fast_blur(noise, sigma)
            std = noise.std()
            if std > 1e-6:
                noise /= std  # renormalize after blur
    x = np.clip(img, 0, 1)
    # monochrome grain, damped in deep shadows/highlights like film
    luma = x[..., 0] * 0.2126 + x[..., 1] * 0.7152 + x[..., 2] * 0.0722
    damp = 0.3 + 0.7 * (1.0 - np.abs(2 * luma - 1) ** 2)
    return np.clip(x + (noise * damp * grain.amount / 100 * 0.08)[..., None], 0, 1)


def apply_effects(img: np.ndarray, effects: Effects) -> np.ndarray:
    out = apply_vignette(img, effects.vignette)
    out = apply_grain(out, effects.grain)
    return out
