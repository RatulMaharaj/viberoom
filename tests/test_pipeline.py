import numpy as np

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
