"""Computational auto-adjust: derive Lightroom-style slider values from image
statistics. Heuristic, not ML — gray-world white balance, mid-gray exposure
targeting, percentile-based tone recovery."""

from __future__ import annotations

import numpy as np

from viberoom.recipe.schema import Recipe


def _luma(img: np.ndarray) -> np.ndarray:
    return img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722


def compute_auto_recipe(linear: np.ndarray, white_balance: bool = True) -> Recipe:
    """Analyze a linear [0,1] float image and produce an auto recipe.
    Replaces WB/tone/presence; leaves detail and geometry untouched."""
    recipe = Recipe()
    luma = _luma(linear)

    # --- exposure: push geometric mean toward mid-gray (0.18) ---
    gmean = float(np.exp(np.mean(np.log(np.clip(luma, 1e-4, None)))))
    ev = float(np.clip(np.log2(0.18 / gmean), -2.5, 2.5))
    recipe.tone.exposure = round(ev, 2)

    # post-exposure luma for the remaining analysis
    l2 = np.clip(luma * (2.0 ** ev), 0, None)
    p1, p5, p95, p99 = (float(np.percentile(l2, q)) for q in (1, 5, 95, 99))

    # --- highlights: recover if bright regions push toward clipping ---
    if p99 > 0.85:
        recipe.tone.highlights = round(float(np.clip(-120 * (p99 - 0.85), -80, 0)), 0)
    # --- shadows: lift if the dark end is crushed ---
    if p5 < 0.04:
        recipe.tone.shadows = round(float(np.clip(1200 * (0.04 - p5), 0, 60)), 0)
    # --- blacks/whites: gentle stretch toward full range ---
    if p1 > 0.02:
        recipe.tone.blacks = round(float(np.clip(-400 * (p1 - 0.02), -40, 0)), 0)
    if p95 < 0.7:
        recipe.tone.whites = round(float(np.clip(300 * (0.7 - p95), 0, 40)), 0)

    # --- white balance: gray-world on midtone pixels ---
    if white_balance:
        mid = (luma > 0.05) & (luma < 0.9)
        if mid.sum() > 100:
            means = linear[mid].mean(axis=0)
            r, g, b = (float(m) for m in np.maximum(means, 1e-6))
            # desired gains to equalize channels against green
            gr, gb = g / r, g / b
            # invert the temp model in ops/color.py: r*=2^(s/2), b*=2^(-s/2)
            s = float(np.clip(np.log2(gr / gb), -1.2, 1.2))
            recipe.whiteBalance.temp = round(5500 * 2.0 ** s, -1)
            gg = 1.0  # green is reference; tint from how far r*b product is off
            rb_geo = float(np.sqrt((r * 2.0 ** (s / 2)) * (b * 2.0 ** (-s / 2))))
            tint = float(np.clip(-150 / 0.3 * np.log2(max(g, 1e-6) / max(rb_geo, 1e-6)) * 0.3, -40, 40))
            recipe.whiteBalance.tint = round(tint, 0)

    # --- presence: mild vibrance ---
    recipe.color.vibrance = 15

    return recipe
