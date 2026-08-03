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
