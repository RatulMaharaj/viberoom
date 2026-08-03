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


def render_float(linear: np.ndarray, recipe: Recipe) -> np.ndarray:
    """Apply a recipe to a decoded linear image. Returns float32 sRGB HxWx3
    in [0,1] (use for high-bit-depth export)."""
    x = apply_lens(linear, recipe.lens)
    x = apply_white_balance(x, recipe.whiteBalance)
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
    x = apply_detail(x, recipe.detail)

    x = apply_geometry(x, recipe.geometry)
    x = apply_retouch(x, recipe.retouch)
    x = apply_masks(x, recipe.masks)
    x = apply_effects(x, recipe.effects)

    return np.clip(x, 0, 1).astype(np.float32)


def render(linear: np.ndarray, recipe: Recipe) -> np.ndarray:
    """Apply a recipe to a decoded linear image. Returns uint8 sRGB HxWx3."""
    return (render_float(linear, recipe) * 255).round().astype(np.uint8)
