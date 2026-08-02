"""The non-destructive render pipeline: linear float32 in, uint8 sRGB out.

Order of operations:
  linear space : white balance -> exposure -> highlights/shadows/whites/blacks
  display space: sRGB gamma -> contrast -> tone curve -> color/HSL -> NR/sharpen
  final        : geometry (orientation/rotate/flip/crop) -> uint8
"""

from __future__ import annotations

import numpy as np

from viberoom.engine.decode import linear_to_srgb
from viberoom.engine.ops.color import apply_color, apply_white_balance
from viberoom.engine.ops.detail import apply_detail
from viberoom.engine.ops.geometry import apply_geometry
from viberoom.engine.ops.tone import (
    apply_contrast,
    apply_exposure,
    apply_regions,
    apply_tone_curve,
)
from viberoom.recipe.schema import Recipe


def render(linear: np.ndarray, recipe: Recipe) -> np.ndarray:
    """Apply a recipe to a decoded linear image. Returns uint8 sRGB HxWx3."""
    x = apply_white_balance(linear, recipe.whiteBalance)
    x = apply_exposure(x, recipe.tone.exposure)
    x = apply_regions(x, recipe.tone)

    x = linear_to_srgb(x)
    x = apply_contrast(x, recipe.tone.contrast)
    x = apply_tone_curve(x, recipe.tone.toneCurve)
    x = apply_color(x, recipe.color)
    x = apply_detail(x, recipe.detail)
    x = apply_geometry(x, recipe.geometry)

    return (np.clip(x, 0, 1) * 255).round().astype(np.uint8)
