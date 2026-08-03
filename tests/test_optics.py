"""Optics tests: lens corrections, perspective, crop aspect helper, LUTs."""

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from viberoom.engine.ops.geometry import apply_geometry
from viberoom.engine.ops.lens import apply_lens
from viberoom.engine.ops.lut import parse_cube
from viberoom.main import app
from viberoom.recipe.schema import Defringe, Geometry, Lens, Perspective


def checkerboard(h=80, w=80, cell=10):
    yy, xx = np.mgrid[0:h, 0:w]
    board = (((yy // cell) + (xx // cell)) % 2).astype(np.float32)
    return np.stack([board] * 3, axis=-1) * 0.8 + 0.1


# ---------- lens (#5) ----------

def test_lens_vignette_correction_brightens_corners():
    img = np.full((60, 60, 3), 0.4, dtype=np.float32)
    out = apply_lens(img, Lens(vignette=80))
    assert out[0, 0, 0] > 0.45          # corner lifted
    np.testing.assert_allclose(out[30, 30, 0], 0.4, atol=0.01)  # center untouched


def test_lens_distortion_moves_edge_content():
    img = checkerboard()
    out = apply_lens(img, Lens(distortion=60))
    # remap must change edge-region pixels but keep the exact center fixed
    assert np.abs(out[5, 5] - img[5, 5]).max() >= 0 and not np.array_equal(out, img)
    np.testing.assert_allclose(out[40, 40], img[40, 40], atol=0.05)


def test_lens_ca_shifts_red_channel_only():
    img = checkerboard()
    out = apply_lens(img, Lens(caRed=100))
    assert not np.array_equal(out[..., 0], img[..., 0])  # red remapped
    np.testing.assert_array_equal(out[..., 1], img[..., 1])  # green untouched


def test_defringe_desaturates_purple_edge():
    img = np.full((40, 40, 3), 0.2, dtype=np.float32)
    img[:, 20:] = 0.9  # hard edge
    img[:, 19:22, 0] = 0.7  # purple-ish fringe (R+B, low G)
    img[:, 19:22, 2] = 0.7
    img[:, 19:22, 1] = 0.2
    out = apply_lens(img, Lens(defringe=Defringe(amount=100)))
    before = img[20, 20, 0] - img[20, 20, 1]
    after = out[20, 20, 0] - out[20, 20, 1]
    assert after < before  # fringe chroma reduced


# ---------- perspective (#6) ----------

def test_perspective_vertical_changes_top_not_center():
    img = checkerboard()
    out = apply_geometry(img, Geometry(perspective=Perspective(vertical=50)))
    assert out.shape == img.shape
    assert not np.array_equal(out[:10], img[:10])  # top rows warped
    np.testing.assert_allclose(out[40, 40], img[40, 40], atol=0.25)


def test_perspective_scale_zooms():
    img = checkerboard()
    out = apply_geometry(img, Geometry(perspective=Perspective(scale=150)))
    # zooming in: the corner cell pattern changes
    assert not np.array_equal(out, img)


# ---------- LUT parsing (#7) ----------

def test_parse_3d_cube_and_identity():
    n = 2
    lines = ["LUT_3D_SIZE 2"]
    for b in range(n):
        for g in range(n):
            for r in range(n):
                lines.append(f"{r} {g} {b}")
    kind, data = parse_cube("\n".join(lines))
    assert kind == "3D" and data.shape == (2, 2, 2, 3)
    # identity: applying it changes nothing
    from viberoom.engine.ops.lut import _apply_3d
    img = np.random.default_rng(1).uniform(0, 1, (16, 16, 3)).astype(np.float32)
    np.testing.assert_allclose(_apply_3d(img, data), img, atol=1e-5)


def test_parse_1d_cube():
    kind, data = parse_cube("LUT_1D_SIZE 3\n0 0 0\n0.6 0.5 0.5\n1 1 1")
    assert kind == "1D" and data.shape == (3, 3)


def test_parse_cube_rejects_garbage():
    from viberoom.engine.ops.lut import LutError
    with pytest.raises(LutError):
        parse_cube("not a lut")


# ---------- API: LUT install + render, crop aspect ----------

@pytest.fixture()
def client(tmp_path, monkeypatch):
    import viberoom.config as config
    import viberoom.engine.ops.lut as lut_mod

    monkeypatch.setattr(config, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(lut_mod, "LUTS_DIR", tmp_path / "luts")
    lib = tmp_path / "photos"
    lib.mkdir()
    arr = np.random.default_rng(7).integers(0, 255, (60, 90, 3), dtype=np.uint8)
    Image.fromarray(arr).save(lib / "a.jpg")
    with TestClient(app) as c:
        c.post("/api/v1/library", json={"path": str(lib)})
        yield c


def _first(c):
    return c.get("/api/v1/images").json()["images"][0]["id"]


def test_lut_install_use_and_delete(client):
    c = client
    # a warming 1D LUT: lifts red, cuts blue
    cube = "LUT_1D_SIZE 2\n0 0 0\n1 0.9 0.7"
    assert c.put("/api/v1/luts/warm", json={"content": cube}).status_code == 200
    assert "warm" in c.get("/api/v1/luts").json()["luts"]

    iid = _first(c)
    c.patch(f"/api/v1/images/{iid}/recipe", json={"color": {"lut": {"name": "warm"}}})
    r = c.get(f"/api/v1/images/{iid}/preview", params={"size": 256})
    assert r.status_code == 200
    # LUT render vs original render differ
    orig = c.get(f"/api/v1/images/{iid}/preview", params={"size": 256, "original": True})
    assert r.content != orig.content

    assert c.delete("/api/v1/luts/warm").status_code == 200
    # missing LUT never breaks rendering
    r2 = c.get(f"/api/v1/images/{iid}/preview", params={"size": 257})
    assert r2.status_code == 200


def test_lut_rejects_bad_content(client):
    assert client.put("/api/v1/luts/bad", json={"content": "junk"}).status_code == 422


def test_crop_aspect_square(client):
    c = client
    iid = _first(c)
    r = c.post(f"/api/v1/images/{iid}/crop", json={"aspect": "1:1"})
    crop = r.json()["crop"]
    # 90x60 image -> square crop trims width: (0.9-0.6*... ) width fraction = 60/90
    assert crop["top"] == 0 and crop["bottom"] == 1
    np.testing.assert_allclose(crop["right"] - crop["left"], 60 / 90, atol=0.01)


def test_crop_aspect_auto_matches_orientation(client):
    c = client
    iid = _first(c)
    r = c.post(f"/api/v1/images/{iid}/crop", json={"aspect": "3:2"})
    crop = r.json()["crop"]
    # landscape image keeps landscape 3:2 -> full width, trimmed height
    assert crop["left"] == 0 and crop["right"] == 1
    frac = crop["bottom"] - crop["top"]
    np.testing.assert_allclose(frac, (90 / 1.5) / 60, atol=0.01)


# ---------- lens: exactness and buffer safety after the memory rework ----------

def _reference_lens(img, lens):
    """The obvious whole-frame form of apply_lens, kept as an oracle.

    apply_lens processes the frame in bands and shares one sampling plan
    between channels; both are supposed to be bit-identical to doing it all at
    once, and "supposed to" is what a test is for.
    """
    h, w = img.shape[:2]
    cy, cx = (h - 1) / 2, (w - 1) / 2
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dx, dy = xx - cx, yy - cy
    # float(), so the radius stays float32 — dividing by the np.float64 that
    # np.sqrt returns would promote this whole reference to float64 and make it
    # an oracle for the promotion bug rather than for the banding.
    r = np.sqrt(dx * dx + dy * dy) / float(np.sqrt(cx * cx + cy * cy))
    out = img
    if lens.distortion or lens.caRed or lens.caBlue:
        k = lens.distortion / 100 * 0.15
        base = 1.0 + k * r * r if k else 1.0
        planes = []
        for i, ca in ((0, lens.caRed), (1, 0.0), (2, lens.caBlue)):
            scale = base * (1.0 + ca / 100 * 0.001)
            if np.isscalar(scale) and scale == 1.0:
                planes.append(out[..., i])
                continue
            sx = np.clip(cx + dx * scale, 0, w - 1.001)
            sy = np.clip(cy + dy * scale, 0, h - 1.001)
            x0, y0 = sx.astype(np.int32), sy.astype(np.int32)
            fx = (sx - x0).astype(np.float32)
            fy = (sy - y0).astype(np.float32)
            c = out[..., i]
            top = c[y0, x0] * (1 - fx) + c[y0, x0 + 1] * fx
            bot = c[y0 + 1, x0] * (1 - fx) + c[y0 + 1, x0 + 1] * fx
            planes.append((top * (1 - fy) + bot * fy).astype(np.float32))
        out = np.stack(planes, axis=-1)
    if lens.vignette:
        out = out * (1.0 + lens.vignette / 100 * 0.8 * (r * r))[..., None]
    if lens.defringe.amount:
        from viberoom.engine.ops.lens import _defringe

        out = _defringe(out, lens.defringe.amount)
    return np.clip(out, 0, None)


LENS_CASES = [
    Lens(distortion=35, vignette=40),
    Lens(caRed=60, caBlue=-45, defringe=Defringe(amount=70)),
    Lens(distortion=-25),
    Lens(vignette=-70),
    Lens(distortion=20, caRed=-40, caBlue=40, vignette=55, defringe=Defringe(amount=100)),
]


@pytest.mark.parametrize("lens", LENS_CASES)
def test_lens_is_bit_identical_to_the_whole_frame_form(lens, monkeypatch):
    # a band budget this small forces several bands over a 71-row frame, so
    # the seams between them are actually exercised
    monkeypatch.setattr("viberoom.engine.ops.lens._BAND_BYTES", 1 << 13)
    img = np.random.default_rng(3).random((71, 53, 3), dtype=np.float32)
    got = apply_lens(img, lens)
    want = _reference_lens(img, lens)
    assert got.dtype == want.dtype
    np.testing.assert_array_equal(got, want)


@pytest.mark.parametrize("lens", LENS_CASES)
def test_lens_never_writes_into_a_read_only_input(lens):
    """apply_lens clips its result in place now; the buffer it clips must be
    one it allocated, not the read-only decode-cache array."""
    img = np.random.default_rng(4).random((40, 47, 3), dtype=np.float32)
    before = img.copy()
    img.flags.writeable = False
    apply_lens(img, lens)
    np.testing.assert_array_equal(img, before)


# ---------- geometry: resampling in float rather than through uint8 ----------

def test_rotation_keeps_more_precision_than_8_bits():
    """The rotate/perspective resample used to round-trip through uint8, which
    quantized the whole frame to 1/255 steps mid-pipeline."""
    yy = np.linspace(0.2, 0.8, 96, dtype=np.float32)[:, None]
    img = np.repeat((yy + np.zeros((1, 96), dtype=np.float32))[..., None], 3, axis=-1)
    out = apply_geometry(img, Geometry(rotate=7))
    levels = out[10:-10, 10:-10] * 255
    assert np.abs(levels - np.round(levels)).max() > 1e-3


def test_perspective_keeps_more_precision_than_8_bits():
    xx = np.linspace(0.1, 0.9, 96, dtype=np.float32)[None, :]
    img = np.repeat((xx + np.zeros((96, 1), dtype=np.float32))[..., None], 3, axis=-1)
    out = apply_geometry(img, Geometry(perspective=Perspective(vertical=25)))
    levels = out[10:-10, 10:-10] * 255
    assert np.abs(levels - np.round(levels)).max() > 1e-3


def test_geometry_resample_stays_in_range_and_float32():
    img = np.random.default_rng(5).random((64, 80, 3), dtype=np.float32)
    out = apply_geometry(img, Geometry(rotate=12, perspective=Perspective(horizontal=30)))
    assert out.dtype == np.float32
    assert out.min() >= 0.0 and out.max() <= 1.0


@pytest.mark.parametrize("lens", LENS_CASES)
def test_lens_stays_in_the_pipeline_working_precision(lens):
    """A vignette used to widen the frame to float64, because the radius was
    divided by the np.float64 that np.sqrt returns and NEP 50 promotes on
    contact. That cost twice the memory and, worse, made the result fail
    pipeline._owned(), silently disabling in-place reuse for every op
    downstream of it."""
    from viberoom.engine.pipeline import _owned

    img = np.random.default_rng(9).random((40, 47, 3), dtype=np.float32)
    out = apply_lens(img, lens)
    assert out.dtype == np.float32
    assert _owned(out, img), "result must be a buffer later ops can write into"
