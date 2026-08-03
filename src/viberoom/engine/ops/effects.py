"""Post-crop effects: vignette and film grain. Run last (after geometry), in
display space [0,1], so they track the final frame like Lightroom's
post-crop vignette."""

from __future__ import annotations

import numpy as np

from viberoom.engine.ops.blur import fast_blur
from viberoom.recipe.schema import Effects, Grain, Vignette

#: Scratch budget for one band of the vignette composite, in bytes. The gain
#: is float64 (the corner normalizer is a numpy scalar), so the product is a
#: double-width frame and the naive expression keeps three of them alive.
_BAND_BYTES = 24 << 20

#: Rows of noise generated at a time. Filling the frame band by band draws
#: exactly the same sequence as one whole-frame call — the generator is
#: sequential — so the grain pattern is unchanged.
_NOISE_BAND_ROWS = 256


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
    # smoothstep, folded into `d` in place: written out it needs two more
    # full frames of float64 for temporaries.
    d -= start
    d /= max(width, 1e-6)
    np.clip(d, 0, 1, out=d)
    fall = d * d
    d *= -2.0
    d += 3.0
    fall *= d  # (t*t) * (3 - 2*t), in that order: float multiply is not associative
    del d  # a float64 frame, and the composite below is about to want the room
    fall *= vig.amount / 100
    fall += 1.0

    out = np.empty(img.shape, dtype=fall.dtype)
    rows = max(1, _BAND_BYTES // (w * 24))
    for a in range(0, h, rows):
        b = min(a + rows, h)
        np.clip(img[a:b], 0, 1, out=out[a:b])
        out[a:b] *= fall[a:b, :, None]
    return np.clip(out, 0, 1, out=out)


def apply_grain(img: np.ndarray, grain: Grain, out: np.ndarray | None = None) -> np.ndarray:
    """Monochrome film grain. `out` may be `img` itself, but only when the
    caller owns that buffer; see `pipeline._owned`."""
    if grain.amount == 0:
        return img
    h, w = img.shape[:2]
    # deterministic per-size seed so re-renders (and the preview cache) agree
    rng = np.random.default_rng(h * 73_856_093 ^ w * 19_349_663)
    # The generator only produces float64; drawing straight into a float32
    # frame would need the double-width copy of the whole thing to exist at
    # once, so it is converted a band at a time instead.
    noise = np.empty((h, w), dtype=np.float32)
    draw = np.empty((min(_NOISE_BAND_ROWS, h), w), dtype=np.float64)
    for a in range(0, h, _NOISE_BAND_ROWS):
        b = min(a + _NOISE_BAND_ROWS, h)
        rng.standard_normal(out=draw[: b - a])
        noise[a:b] = draw[: b - a]
    del draw
    if grain.size > 0:
        sigma = grain.size / 100 * min(h, w) / 500
        if sigma >= 0.6:
            noise = fast_blur(noise, sigma)
            std = noise.std()
            if std > 1e-6:
                noise /= std  # renormalize after blur
    x = np.clip(img, 0, 1, out=out)
    # monochrome grain, damped in deep shadows/highlights like film
    damp = x[..., 0] * 0.2126
    damp += x[..., 1] * 0.7152
    damp += x[..., 2] * 0.0722
    # luma folds into the damping curve in place: 0.3 + 0.7*(1 - (2L-1)^2)
    damp *= 2.0
    damp -= 1.0
    damp *= damp
    np.subtract(1.0, damp, out=damp)
    damp *= 0.7
    damp += 0.3
    # Not in place: `damp` follows the frame's dtype, and an in-place multiply
    # would quietly round the product back down to the noise's float32.
    noise = noise * damp
    noise *= grain.amount
    noise /= 100
    noise *= 0.08
    x += noise[..., None]
    return np.clip(x, 0, 1, out=x)


def apply_effects(img: np.ndarray, effects: Effects) -> np.ndarray:
    out = apply_vignette(img, effects.vignette)
    # apply_vignette either hands back its input or a buffer it just made, so
    # anything other than `img` is ours for the grain to overwrite.
    return apply_grain(out, effects.grain, out=out if out is not img else None)
