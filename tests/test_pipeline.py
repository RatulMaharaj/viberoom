import numpy as np
import pytest

from viberoom.engine.ops.color import apply_color, apply_white_balance
from viberoom.engine.ops.geometry import apply_geometry
from viberoom.engine.ops.tone import apply_contrast, apply_exposure, apply_tone_curve
from viberoom.engine.pipeline import render
from viberoom.recipe.schema import Color, Crop, Geometry, Recipe, ToneCurve, WhiteBalance


def gradient(h=32, w=32):
    g = np.linspace(0.1, 0.5, w, dtype=np.float32)
    return np.broadcast_to(g[None, :, None], (h, w, 3)).copy()


def test_noop_recipe_is_identity_shape():
    img = gradient()
    out = render(img, Recipe())
    assert out.shape == img.shape and out.dtype == np.uint8


def test_exposure_doubles_linear():
    img = gradient()
    out = apply_exposure(img, 1.0)
    np.testing.assert_allclose(out, img * 2, rtol=1e-6)


def test_contrast_pivots_midgray():
    img = np.full((4, 4, 3), 0.5, dtype=np.float32)
    out = apply_contrast(img, 50)
    np.testing.assert_allclose(out, 0.5, atol=0.02)


def test_tone_curve_lut():
    img = np.full((4, 4, 3), 0.5, dtype=np.float32)
    curve = ToneCurve(points=[(0, 0), (128, 192), (255, 255)])
    out = apply_tone_curve(img, curve)
    assert out.mean() > 0.6  # midtones lifted


def test_warm_wb_boosts_red_cuts_blue():
    img = np.full((4, 4, 3), 0.5, dtype=np.float32)
    out = apply_white_balance(img, WhiteBalance(temp=8000))
    assert out[0, 0, 0] > 0.5 > out[0, 0, 2]


def test_saturation_zero_kills_color():
    img = np.zeros((4, 4, 3), dtype=np.float32)
    img[..., 0] = 0.8  # pure red
    out = apply_color(img, Color(saturation=-100))
    np.testing.assert_allclose(out[..., 0], out[..., 1], atol=1e-5)


def test_crop_and_orientation():
    img = gradient(40, 20)
    geo = Geometry(orientation=90, crop=Crop(left=0.0, top=0.0, right=0.5, bottom=0.5))
    out = apply_geometry(img, geo)
    # rot90 makes it 20x40, crop halves both dims
    assert out.shape[:2] == (10, 20)


def test_flip_h():
    img = gradient()
    out = apply_geometry(img, Geometry(flipH=True))
    np.testing.assert_allclose(out[:, 0], img[:, -1])


# ---------- preview render resolution ----------

def test_preview_scale_shrinks_to_requested_size():
    """A small preview should render small, not render big and then shrink."""
    from viberoom.engine.cache import _preview_scale

    linear = gradient(2000, 3000)
    assert _preview_scale(linear, Recipe(), 400) < 0.2
    # Never upscales, however large the request.
    assert _preview_scale(linear, Recipe(), 4096) == 1.0


def test_preview_scale_keeps_resolution_for_a_crop():
    """Cropping to a quarter means the survivor carries the whole output, so
    four times the input has to be kept."""
    from viberoom.engine.cache import _preview_scale

    linear = gradient(2000, 3000)
    full = _preview_scale(linear, Recipe(), 600)
    cropped = _preview_scale(
        linear,
        Recipe(geometry=Geometry(crop=Crop(left=0.25, top=0.25, right=0.5, bottom=0.5))),
        600,
    )
    assert cropped > full * 3.5


def test_downscale_linear_preserves_range_and_shape():
    from viberoom.engine.cache import _downscale_linear

    linear = gradient(400, 600)
    out = _downscale_linear(linear, 0.25)
    assert out.shape == (100, 150, 3) and out.dtype == np.float32
    # Lanczos overshoot must not produce negative light.
    assert out.min() >= 0.0
    assert abs(float(out.mean()) - float(linear.mean())) < 0.01
    # scale 1.0 is a pass-through, not a resample
    assert _downscale_linear(linear, 1.0) is linear


def test_detail_scale_matches_a_downscaled_frame_to_the_full_one():
    """Sharpening radius is in absolute pixels, so a half-size frame needs a
    half-size radius to look like the same edit."""
    from viberoom.engine.cache import _downscale_linear
    from viberoom.recipe.schema import Detail, Sharpening

    rng = np.random.default_rng(11)
    linear = np.clip(
        rng.random((400, 400, 3), dtype=np.float32) * 0.3 + 0.35, 0, 1
    ).astype(np.float32)
    recipe = Recipe(detail=Detail(sharpening=Sharpening(amount=80, radius=2.0)))

    full = render(linear, recipe).astype(np.float32)
    half = _downscale_linear(linear, 0.5)

    scaled = render(half, recipe, 0.5).astype(np.float32)
    unscaled = render(half, recipe, 1.0).astype(np.float32)

    # Compare each against the full render brought down to the same size.
    from PIL import Image

    ref = np.asarray(
        Image.fromarray(full.astype(np.uint8)).resize((200, 200), Image.LANCZOS)
    ).astype(np.float32)

    assert abs(scaled - ref).mean() < abs(unscaled - ref).mean()


# ---------- decode cache ----------

def test_decode_cache_evicts_by_bytes_not_entries():
    """Entry-count bounding made browsing pathological: a third image evicted
    the first, so paging back and forth re-decoded every time."""
    from viberoom.engine.cache import DecodeCache

    cache = DecodeCache(max_bytes=10 * 1024 * 1024)
    small = np.zeros((512, 512, 3), dtype=np.float32)  # 3 MB each

    for i in range(3):
        cache.put((f"img{i}", 0, True), small.copy())
    assert cache.resident_mb < 10
    assert len(cache._store) == 3, "three small images should all fit"

    # One oversized entry is still admitted — evicting what was just decoded
    # would mean decoding it again immediately.
    cache.put(("huge", 0, False), np.zeros((2048, 2048, 3), dtype=np.float32))
    assert len(cache._store) == 1


def test_decode_cache_hands_out_read_only_arrays():
    """Entries are shared by reference, so an in-place op would poison every
    later render of the same file. Fail loudly instead."""
    from viberoom.engine.cache import DecodeCache

    cache = DecodeCache()
    arr = np.ones((8, 8, 3), dtype=np.float32)
    cache.put(("x", 0, True), arr)

    with pytest.raises(ValueError):
        cache._store[("x", 0, True)] *= 2


def _read_only_gradient():
    img = gradient(48, 64)
    img.flags.writeable = False
    return img


def test_render_never_writes_into_a_read_only_decode_cache_entry():
    """Decoded arrays are handed out by reference and marked read-only, so any
    op that started writing in place would raise here rather than quietly
    poisoning every later render of the same file."""
    from viberoom.recipe.schema import (
        BrushMask,
        BrushStroke,
        LocalAdjustments,
        Tone,
    )

    recipes = [
        Recipe(),  # every op early-returns its input: the aliasing worst case
        Recipe(whiteBalance=WhiteBalance(temp=7200, tint=8)),
        Recipe(tone=Tone(exposure=0.5, contrast=30, clarity=20)),
        Recipe(color=Color(saturation=40)),
        Recipe(
            masks=[
                BrushMask(
                    strokes=[BrushStroke(points=[(0.4, 0.4)], radius=0.15)],
                    adjustments=LocalAdjustments(exposure=0.8),
                )
            ]
        ),
    ]
    for recipe in recipes:
        img = _read_only_gradient()
        before = np.asarray(img).copy()
        render(img, recipe)
        np.testing.assert_array_equal(img, before)


def test_render_float_leaves_a_writable_caller_array_alone():
    """The in-place clip at the end of render_float may only touch buffers the
    pipeline allocated itself — a caller's array is not one of them."""
    from viberoom.engine.pipeline import render_float

    img = gradient(16, 16) * 2.0  # out of range, so the final clip has work
    before = img.copy()
    out = render_float(img, Recipe())
    np.testing.assert_array_equal(img, before)
    assert out.dtype == np.float32 and out.max() <= 1.0


def test_render_uint8_conversion_matches_the_unfused_expression():
    from viberoom.engine.pipeline import render_float
    from viberoom.recipe.schema import Tone

    img = gradient(24, 32)
    recipe = Recipe(tone=Tone(exposure=0.4, contrast=20), color=Color(vibrance=35))
    reference = (render_float(img, recipe) * 255).round().astype(np.uint8)
    np.testing.assert_array_equal(render(img, recipe), reference)


def test_owned_rejects_everything_the_pipeline_did_not_allocate():
    """`_owned` is the whole safety argument for the in-place clip and the
    fused uint8 conversion. It has to reject the source array, views of it,
    and read-only decode-cache entries — being writable is not enough."""
    from viberoom.engine.pipeline import _owned

    src = np.zeros((8, 8, 3), dtype=np.float32)
    assert not _owned(src, src)
    assert not _owned(src[2:6], src)  # a crop view still writes into src
    frozen = np.zeros((8, 8, 3), dtype=np.float32)
    frozen.flags.writeable = False
    assert not _owned(frozen, src)
    assert not _owned(np.zeros((8, 8, 3), dtype=np.float64), src)
    assert _owned(np.zeros((8, 8, 3), dtype=np.float32), src)
