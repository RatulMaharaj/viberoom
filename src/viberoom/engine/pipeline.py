"""The non-destructive render pipeline: linear float32 in, uint8 sRGB out.

Order of operations:
  linear space : white balance -> exposure -> highlights/shadows/whites/blacks
  display space: sRGB gamma -> contrast -> tone curve (luma + RGB) -> color/HSL
                 -> color grading -> dehaze/clarity/texture -> NR/sharpen
  final        : geometry (orientation/rotate/flip/crop) -> local masks
                 -> vignette/grain -> uint8

Masks and effects run after geometry so their coordinates live in the final
rendered frame — what an agent sees in a preview is what it addresses.
"""

from __future__ import annotations

import numpy as np

from viberoom.engine.decode import linear_to_srgb
from viberoom.engine.ops.color import apply_color, apply_color_grading, apply_white_balance
from viberoom.engine.ops.detail import apply_detail
from viberoom.engine.ops.effects import apply_effects
from viberoom.engine.ops.geometry import apply_geometry
from viberoom.engine.ops.lens import apply_lens
from viberoom.engine.ops.lut import apply_lut
from viberoom.engine.ops.masks import apply_masks
from viberoom.engine.ops.presence import apply_presence
from viberoom.engine.ops.retouch import apply_retouch
from viberoom.engine.ops.tone import (
    apply_contrast,
    apply_exposure,
    apply_regions,
    apply_tone_curve,
)
from viberoom.recipe.schema import Recipe


def _owned(x: np.ndarray, src: np.ndarray) -> bool:
    """True when `x` is a buffer this pipeline allocated and may write into.

    Every op returns its input untouched when its slider is at zero, so even
    after twenty of them `x` can still be `src` — which is either the caller's
    array or a decode-cache entry that is deliberately read-only. `base is
    None` rules out the views `apply_geometry` can hand back of the same
    memory.
    """
    return (
        x is not src
        and x.base is None
        and x.dtype == np.float32
        and x.flags.writeable
    )


def render_float(linear: np.ndarray, recipe: Recipe, scale: float = 1.0) -> np.ndarray:
    """Apply a recipe to a decoded linear image. Returns float32 sRGB HxWx3
    in [0,1] (use for high-bit-depth export).

    `scale` says how large this frame is relative to the full-resolution one,
    so ops whose radii are absolute pixel counts can compensate. Everything
    else here sizes itself from the frame it is handed. Default 1.0 means
    "this is the real thing", which is what export and the tests want.
    """
    x = apply_lens(linear, recipe.lens)
    x = apply_white_balance(x, recipe.whiteBalance, out=x if _owned(x, linear) else None)
    x = apply_exposure(x, recipe.tone.exposure)
    x = apply_regions(x, recipe.tone)

    x = linear_to_srgb(x)
    if recipe.color.lut.stage == "pre":
        x = apply_lut(x, recipe.color.lut)
    x = apply_contrast(x, recipe.tone.contrast)
    x = apply_tone_curve(x, recipe.tone.toneCurve)
    x = apply_color(x, recipe.color)
    x = apply_color_grading(x, recipe.color.grading)
    if recipe.color.lut.stage == "post":
        x = apply_lut(x, recipe.color.lut)
    x = apply_presence(x, recipe.tone.texture, recipe.tone.clarity, recipe.tone.dehaze)
    x = apply_detail(x, recipe.detail, scale)

    x = apply_geometry(x, recipe.geometry)
    x = apply_retouch(x, recipe.retouch)
    x = apply_masks(x, recipe.masks)
    x = apply_effects(x, recipe.effects)

    if _owned(x, linear):
        return np.clip(x, 0, 1, out=x)
    return np.clip(x, 0, 1).astype(np.float32, copy=False)


def render(linear: np.ndarray, recipe: Recipe, scale: float = 1.0) -> np.ndarray:
    """Apply a recipe to a decoded linear image. Returns uint8 sRGB HxWx3."""
    x = render_float(linear, recipe, scale)
    # Scale and round through one buffer: the naive expression keeps the
    # float32 frame, the x255 product and the rounded product all alive at
    # once, which at 24 MP is three 288 MB arrays for one uint8 result.
    if not _owned(x, linear):
        x = x.copy()
    x *= 255
    np.round(x, out=x)
    return x.astype(np.uint8)
