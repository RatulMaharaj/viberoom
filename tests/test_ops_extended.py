"""Tests for presence, color grading, RGB curves, effects and local masks."""

import numpy as np

from viberoom.engine.ops.color import apply_color_grading
from viberoom.engine.ops.effects import apply_grain, apply_vignette
from viberoom.engine.ops.masks import apply_masks, mask_weight
from viberoom.engine.ops.presence import apply_clarity, apply_dehaze, apply_texture
from viberoom.engine.ops.tone import apply_tone_curve
from viberoom.engine.pipeline import render
from viberoom.recipe.schema import (
    ColorGrading,
    ColorRangeMask,
    Grain,
    GradeBand,
    LinearGradientMask,
    LocalAdjustments,
    LuminanceRangeMask,
    RadialGradientMask,
    Recipe,
    ToneCurve,
    Vignette,
)


def gradient(h=48, w=48):
    g = np.linspace(0.05, 0.85, w, dtype=np.float32)
    return np.broadcast_to(g[None, :, None], (h, w, 3)).copy()


def flat(value=0.5, h=32, w=32):
    return np.full((h, w, 3), value, dtype=np.float32)


# ---------- presence ----------

def test_clarity_increases_local_contrast():
    img = gradient()
    out = apply_clarity(img, 60)
    assert out.std() > img.std()


def test_negative_clarity_softens():
    img = gradient()
    out = apply_clarity(img, -60)
    assert out.std() < img.std()


def test_texture_noop_at_zero():
    img = gradient()
    np.testing.assert_array_equal(apply_texture(img, 0), img)


def test_dehaze_darkens_hazy_flat_field():
    img = flat(0.6)
    out = apply_dehaze(img, 50)
    assert out.mean() < img.mean()


def test_negative_dehaze_lifts_toward_haze():
    img = flat(0.3)
    out = apply_dehaze(img, -50)
    assert out.mean() > img.mean()


# ---------- color grading & RGB curves ----------

def test_grading_tints_shadows_blue():
    img = flat(0.15)
    grading = ColorGrading(shadows=GradeBand(hue=240, saturation=80))
    out = apply_color_grading(img, grading)
    assert out[0, 0, 2] > out[0, 0, 0]  # blue channel lifted vs red


def test_grading_highlight_tint_spares_shadows():
    img = gradient()
    grading = ColorGrading(highlights=GradeBand(hue=45, saturation=80), blending=20)
    out = apply_color_grading(img, grading)
    dark_shift = np.abs(out[:, 0] - img[:, 0]).mean()
    bright_shift = np.abs(out[:, -1] - img[:, -1]).mean()
    assert bright_shift > dark_shift * 3


def test_rgb_channel_curve_only_touches_channel():
    img = flat(0.5)
    curve = ToneCurve(red=[(0, 60), (255, 255)])
    out = apply_tone_curve(img, curve)
    assert out[0, 0, 0] > 0.5
    np.testing.assert_allclose(out[0, 0, 1], 0.5, atol=1e-4)
    np.testing.assert_allclose(out[0, 0, 2], 0.5, atol=1e-4)


# ---------- effects ----------

def test_vignette_darkens_corners_not_center():
    img = flat(0.5, 64, 64)
    out = apply_vignette(img, Vignette(amount=-70, midpoint=30))
    assert out[0, 0, 0] < 0.4  # corner
    np.testing.assert_allclose(out[32, 32, 0], 0.5, atol=0.02)  # center


def test_grain_is_deterministic():
    img = flat(0.5, 64, 64)
    a = apply_grain(img, Grain(amount=50, size=30))
    b = apply_grain(img, Grain(amount=50, size=30))
    np.testing.assert_array_equal(a, b)
    assert a.std() > img.std()


# ---------- masks ----------

def test_linear_mask_full_at_start_zero_at_end():
    img = flat(0.5, 40, 40)
    m = LinearGradientMask(start=(0.5, 0.0), end=(0.5, 0.5))
    w = mask_weight(m, img)
    assert w[0, 20] > 0.99  # at start
    assert w[-1, 20] < 0.01  # past end


def test_radial_mask_inside_vs_outside():
    img = flat(0.5, 40, 40)
    m = RadialGradientMask(center=(0.5, 0.5), radiusX=0.25, radiusY=0.25, feather=20)
    w = mask_weight(m, img)
    assert w[20, 20] > 0.99
    assert w[0, 0] < 0.01


def test_luminance_mask_selects_darks():
    img = gradient()
    m = LuminanceRangeMask(lumMin=0, lumMax=30, feather=10)
    w = mask_weight(m, img)
    assert w[0, 0] > 0.9  # darkest column selected
    assert w[0, -1] < 0.05  # brightest not


def test_color_mask_targets_hue():
    img = flat(0.2)
    img[..., 2] = 0.8  # blue-dominant
    w = mask_weight(ColorRangeMask(hue=240, range=40), img)
    assert w.mean() > 0.8
    w_off = mask_weight(ColorRangeMask(hue=60, range=40), img)
    assert w_off.mean() < 0.05


def test_masked_exposure_lifts_only_masked_side():
    img = flat(0.3, 40, 40)
    m = LinearGradientMask(
        start=(0.0, 0.5), end=(0.6, 0.5),
        adjustments=LocalAdjustments(exposure=1.5),
    )
    out = apply_masks(img, [m])
    assert out[20, 0, 0] > 0.4  # left side brightened
    np.testing.assert_allclose(out[20, -1, 0], 0.3, atol=0.01)  # right untouched


def test_mask_invert_and_opacity():
    img = flat(0.5, 20, 20)
    m = RadialGradientMask(
        center=(0.5, 0.5), radiusX=0.2, radiusY=0.2, feather=10,
        invert=True, opacity=50,
        adjustments=LocalAdjustments(exposure=-2),
    )
    out = apply_masks(img, [m])
    assert out[0, 0, 0] < out[10, 10, 0]  # corners darkened, center spared


def test_full_recipe_with_masks_renders_uint8():
    img = gradient(60, 80)
    recipe = Recipe.model_validate({
        "tone": {"clarity": 30, "dehaze": 10},
        "color": {"grading": {"shadows": {"hue": 220, "saturation": 40}}},
        "effects": {"vignette": {"amount": -30}, "grain": {"amount": 20}},
        "masks": [{"type": "radial", "center": [0.5, 0.5], "radiusX": 0.4,
                    "radiusY": 0.4, "adjustments": {"exposure": 0.5}}],
    })
    out = render(img, recipe)
    assert out.dtype == np.uint8 and out.shape == img.shape


def test_old_sidecar_recipe_still_validates():
    # a pre-upgrade recipe (no new fields) must load and render unchanged
    old = {"whiteBalance": {"temp": 6500}, "tone": {"exposure": 0.5},
           "geometry": {"crop": {"left": 0.1, "top": 0.1, "right": 0.9, "bottom": 0.9}}}
    recipe = Recipe.model_validate(old)
    out = render(gradient(), recipe)
    assert out.dtype == np.uint8


# ---------- brush masks (#3) ----------

def test_brush_stroke_paints_where_drawn():
    from viberoom.recipe.schema import BrushMask, BrushStroke
    img = flat(0.5, 100, 100)
    m = BrushMask(
        strokes=[BrushStroke(points=[(0.2, 0.5), (0.8, 0.5)], radius=0.08, feather=30)],
        adjustments=LocalAdjustments(exposure=-2),
    )
    w = mask_weight(m, img)
    assert w[50, 50] > 0.9  # on the stroke line
    assert w[10, 50] < 0.01  # far above it
    out = apply_masks(img, [m])
    assert out[50, 50, 0] < 0.3 and abs(out[10, 50, 0] - 0.5) < 0.01


def test_brush_erase_carves_out():
    from viberoom.recipe.schema import BrushMask, BrushStroke
    img = flat(0.5, 100, 100)
    m = BrushMask(strokes=[
        BrushStroke(points=[(0.5, 0.5)], radius=0.3, feather=10),
        BrushStroke(points=[(0.5, 0.5)], radius=0.1, feather=10, erase=True),
    ], adjustments=LocalAdjustments(exposure=1))
    w = mask_weight(m, img)
    assert w[50, 50] < 0.05  # erased center
    assert w[50, 25] > 0.8   # ring still painted


def test_brush_flow_accumulates():
    from viberoom.recipe.schema import BrushMask, BrushStroke
    img = flat(0.5, 80, 80)
    one = BrushMask(strokes=[BrushStroke(points=[(0.5, 0.5)], radius=0.2, flow=40)],
                    adjustments=LocalAdjustments(exposure=1))
    two = BrushMask(strokes=[BrushStroke(points=[(0.5, 0.5)], radius=0.2, flow=40)] * 2,
                    adjustments=LocalAdjustments(exposure=1))
    assert mask_weight(two, img)[40, 40] > mask_weight(one, img)[40, 40]


# ---------- retouch (#2) ----------

def test_clone_copies_source_patch():
    from viberoom.engine.ops.retouch import apply_retouch
    from viberoom.recipe.schema import RetouchSpot
    img = flat(0.2, 100, 100)
    img[40:60, 10:30] = 0.9  # bright square on the left
    spot = RetouchSpot(mode="clone", source=(0.2, 0.5), dest=(0.8, 0.5),
                       radius=0.08, feather=20)
    out = apply_retouch(img, [spot])
    assert out[50, 80, 0] > 0.8  # bright pixels cloned to the right
    assert abs(out[50, 20, 0] - 0.9) < 1e-5  # source untouched


def test_heal_removes_dark_spot():
    from viberoom.engine.ops.retouch import apply_retouch
    from viberoom.recipe.schema import RetouchSpot
    rng = np.random.default_rng(3)
    img = (0.6 + rng.normal(0, 0.02, (120, 120, 3))).astype(np.float32).clip(0, 1)
    img[55:65, 55:65] = 0.05  # a dark blemish
    spot = RetouchSpot(mode="heal", source=(0.2, 0.2), dest=(0.5, 0.5),
                       radius=0.09, feather=40)
    out = apply_retouch(img, [spot])
    assert out[60, 60, 0] > 0.4  # blemish gone, roughly background brightness


def test_retouch_near_edge_does_not_crash():
    from viberoom.engine.ops.retouch import apply_retouch
    from viberoom.recipe.schema import RetouchSpot
    img = flat(0.5, 60, 60)
    spots = [RetouchSpot(mode="clone", source=(0.02, 0.02), dest=(0.98, 0.98), radius=0.1)]
    out = apply_retouch(img, spots)
    assert out.shape == img.shape


def test_separable_blur_matches_numpy_convolve_exactly():
    """The vectorized blur replaced a per-row np.convolve loop. It has to be
    the same arithmetic, not merely a similar one — zero padding at the edges
    included."""
    from viberoom.engine.ops.detail import _blur, _gaussian_kernel

    def reference(img, sigma):
        k = _gaussian_kernel(sigma)
        out = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 0, img)
        out = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 1, out)
        return out.astype(np.float32)

    rng = np.random.default_rng(5)
    for shape in ((37, 51), (37, 51, 3)):
        for sigma in (0.5, 1.2, 3.5):
            img = rng.random(shape, dtype=np.float32)
            np.testing.assert_allclose(_blur(img, sigma), reference(img, sigma), atol=1e-6)


def test_separable_blur_does_not_mutate_its_input():
    from viberoom.engine.ops.detail import _blur

    img = np.random.default_rng(6).random((16, 16, 3), dtype=np.float32)
    before = img.copy()
    _blur(img, 1.5)
    np.testing.assert_array_equal(img, before)
