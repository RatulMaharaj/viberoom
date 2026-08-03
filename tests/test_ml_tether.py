"""Wave F tests: AI masks (subject/sky/background), tethered capture
(mocked gphoto2), GPS extraction + map, face detection and ML enhance
(skipped when onnxruntime is unavailable)."""

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from viberoom.engine.ops.masks import apply_masks, mask_weight
from viberoom.main import app
from viberoom.recipe.schema import AiMask, LocalAdjustments

try:
    import onnxruntime  # noqa: F401

    HAS_ORT = True
except ImportError:
    HAS_ORT = False


# ---------- AI masks (#4) ----------

def _scene(h=96, w=96):
    """Bright blue smooth sky on top, textured dark ground, bright blob subject."""
    rng = np.random.default_rng(2)
    img = np.zeros((h, w, 3), dtype=np.float32)
    img[: h // 2] = [0.55, 0.7, 0.95]  # sky
    ground = rng.uniform(0.1, 0.35, (h - h // 2, w, 3)).astype(np.float32)
    img[h // 2:] = ground
    img[60:80, 40:60] = [0.9, 0.7, 0.3]  # subject blob on the ground
    return img


def test_sky_mask_selects_top_not_ground():
    img = _scene()
    w = mask_weight(AiMask(type="sky"), img)
    assert w[10, :].mean() > 0.6      # sky rows selected
    assert w[85, :].mean() < 0.25     # ground mostly not


def test_subject_and_background_complement():
    img = _scene()
    ws = mask_weight(AiMask(type="subject"), img)
    wb = mask_weight(AiMask(type="background"), img)
    np.testing.assert_allclose(ws + wb, 1.0, atol=1e-4)
    assert 0.01 < ws.mean() < 0.9  # nontrivial selection either backend


def test_ai_mask_applies_adjustments():
    img = _scene()
    m = AiMask(type="sky", adjustments=LocalAdjustments(exposure=-2))
    out = apply_masks(img, [m])
    assert out[10, 48, 2] < img[10, 48, 2]  # sky darkened
    np.testing.assert_allclose(out[85, 20], img[85, 20], atol=0.06)  # ground ~kept


# ---------- fixtures ----------

@pytest.fixture()
def client(tmp_path, monkeypatch):
    import viberoom.config as config

    monkeypatch.setattr(config, "STATE_FILE", tmp_path / "state.json")
    lib = tmp_path / "photos"
    lib.mkdir()
    rng = np.random.default_rng(5)
    for name in ("a.jpg", "b.jpg"):
        arr = rng.integers(20, 230, (48, 64, 3), dtype=np.uint8)
        Image.fromarray(arr).save(lib / name)
    with TestClient(app) as c:
        c.post("/api/v1/library", json={"path": str(lib)})
        yield c, lib, tmp_path


def _ids(c):
    return [i["id"] for i in c.get("/api/v1/images").json()["images"]]


# ---------- tether (#20) ----------

def test_tether_status_without_gphoto2(client, monkeypatch):
    import viberoom.tether as tether

    monkeypatch.setattr(tether, "GPHOTO2", None)
    c, _, _ = client
    r = c.get("/api/v1/tether")
    assert r.json()["available"] is False
    assert "gphoto2" in r.json()["reason"]


def test_tether_capture_with_fake_gphoto2(client, tmp_path, monkeypatch):
    import viberoom.tether as tether

    c, lib, _ = client
    # a fake gphoto2 that "captures" by writing a JPEG at the requested path
    fake = tmp_path / "fake-gphoto2"
    fake.write_text(f"""#!/bin/sh
if [ "$1" = "--capture-image-and-download" ]; then
  out=$(echo "$3" | sed 's/%Y%m%d-%H%M%S/20260803-120000/; s/%C/jpg/')
  cp "{lib}/a.jpg" "$out"
  echo "Saving file as $out"
else
  echo unsupported >&2; exit 1
fi
""")
    fake.chmod(0o755)
    monkeypatch.setattr(tether, "GPHOTO2", str(fake))

    c.put("/api/v1/presets/tether-look", json={"patch": {"tone": {"contrast": 18}}})
    r = c.post("/api/v1/tether/capture", json={
        "subfolder": "studio", "preset": "tether-look", "keywords": ["session-1"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert "/studio/" in body["path"]
    img = c.get(f"/api/v1/images/{body['id']}").json()
    assert img["keywords"] == ["session-1"]
    rec = c.get(f"/api/v1/images/{body['id']}/recipe").json()
    assert rec["tone"]["contrast"] == 18
    c.delete("/api/v1/presets/tether-look")


def test_tether_capture_no_camera_returns_503(client, monkeypatch):
    import viberoom.tether as tether

    monkeypatch.setattr(tether, "GPHOTO2", None)
    c, _, _ = client
    assert c.post("/api/v1/tether/capture", json={}).status_code == 503


# ---------- GPS / map (#18) ----------

def test_gps_parsing_both_formats():
    from viberoom.catalog.scanner import _parse_gps

    # exiftool numeric style
    lat, lon = _parse_gps({"GPSLatitude": "-33.9249", "GPSLongitude": "18.4241"})
    assert abs(lat + 33.9249) < 1e-6 and abs(lon - 18.4241) < 1e-6
    # exifread dms style with refs
    lat, lon = _parse_gps({
        "GPSLatitude": "[33, 55, 2969/100]", "GPSLatitudeRef": "S",
        "GPSLongitude": "[18, 25, 1234/100]", "GPSLongitudeRef": "E",
    })
    assert abs(lat + (33 + 55 / 60 + 29.69 / 3600)) < 1e-4
    assert lon > 18
    # garbage rejected
    assert _parse_gps({"GPSLatitude": "banana"}) == (None, None)


def test_map_and_has_gps_filter(client):
    c, _, _ = client
    ids = _ids(c)
    # inject coordinates directly (JPEG fixtures carry no GPS EXIF)
    from viberoom import state

    state.db().execute(
        "UPDATE images SET gps_lat=-33.9, gps_lon=18.4 WHERE id=?", (ids[0],)
    )
    pts = c.get("/api/v1/map").json()["points"]
    assert len(pts) == 1 and abs(pts[0]["gps_lat"] + 33.9) < 1e-6
    assert c.get("/api/v1/map", params={"lat_min": 0}).json()["points"] == []
    assert c.get("/api/v1/images", params={"has_gps": True}).json()["total"] == 1


# ---------- faces + enhance (#18, #8) ----------

@pytest.mark.skipif(not HAS_ORT, reason="onnxruntime not installed")
def test_enhance_with_tiny_onnx_model(client, monkeypatch):
    import onnx
    from onnx import TensorProto, helper

    import viberoom.ml as ml

    c, lib, tmp = client
    monkeypatch.setattr(ml, "MODELS_DIR", tmp / "models")
    (tmp / "models").mkdir()
    k = np.zeros((3, 3, 3, 3), dtype=np.float32)
    for ch in range(3):
        k[ch, ch] = 1.0 / 9.0
    node = helper.make_node("Conv", ["x", "w"], ["y"], pads=[1, 1, 1, 1])
    graph = helper.make_graph(
        [node], "blur",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 3, None, None])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, 3, None, None])],
        [helper.make_tensor("w", TensorProto.FLOAT, k.shape, k.flatten())],
    )
    onnx.save(
        helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)]),
        tmp / "models" / "denoise-lite.onnx",
    )
    assert "denoise-lite" in c.get("/api/v1/models").json()["models"]

    iid = _ids(c)[0]
    r = c.post(f"/api/v1/images/{iid}/enhance", json={"model": "denoise-lite", "tile": 128})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["path"].endswith("-enhanced.png") and body["scale"] == 1
    # the result is a first-class library image
    assert c.get(f"/api/v1/images/{body['id']}/preview", params={"size": 256}).status_code == 200


def test_enhance_without_model_is_graceful(client, monkeypatch, tmp_path):
    import viberoom.ml as ml

    monkeypatch.setattr(ml, "MODELS_DIR", tmp_path / "empty-models")
    c, _, _ = client
    iid = _ids(c)[0]
    r = c.post(f"/api/v1/images/{iid}/enhance", json={"model": "nope"})
    assert r.status_code == 503


@pytest.mark.skipif(not HAS_ORT, reason="onnxruntime not installed")
def test_faces_scan_stores_counts_and_filters(client, monkeypatch):
    import viberoom.ml as ml

    c, _, _ = client
    ids = _ids(c)

    def fake_detect(img, threshold=0.7):
        return [{"box": [0.1, 0.1, 0.4, 0.5], "score": 0.93}]

    monkeypatch.setattr(ml, "detect_faces", fake_detect)
    r = c.post("/api/v1/faces/scan", json={"image_ids": [ids[0]]})
    assert r.json()["scanned"] == 1 and r.json()["with_faces"] == 1
    faced = c.get("/api/v1/images", params={"faces_gte": 1}).json()
    assert faced["total"] == 1 and faced["images"][0]["faces"] == 1
