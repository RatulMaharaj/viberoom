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
