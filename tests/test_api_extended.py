"""API tests: labels, keywords, rich filtering, batch ops, presets, export
formats."""

import json

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from viberoom.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import viberoom.config as config
    import viberoom.presets as presets

    monkeypatch.setattr(config, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(presets, "PRESETS_DIR", tmp_path / "presets")

    lib = tmp_path / "photos"
    lib.mkdir()
    rng = np.random.default_rng(7)
    for name in ["a.jpg", "b.jpg", "c.jpg"]:
        arr = rng.integers(0, 255, (64, 96, 3), dtype=np.uint8)
        Image.fromarray(arr).save(lib / name)

    with TestClient(app) as c:
        r = c.post("/api/v1/library", json={"path": str(lib)})
        assert r.status_code == 200 and r.json()["total"] == 3
        yield c, lib


def _ids(c):
    return [i["id"] for i in c.get("/api/v1/images").json()["images"]]


# ---------- labels ----------

def test_label_set_filter_and_sidecar(client):
    c, lib = client
    iid = _ids(c)[0]
    r = c.put(f"/api/v1/images/{iid}/label", json={"label": "red"})
    assert r.json()["label"] == "red"
    assert c.get("/api/v1/images", params={"label": "red"}).json()["total"] == 1
    assert c.get("/api/v1/images", params={"label": "none"}).json()["total"] == 2
    filename = c.get(f"/api/v1/images/{iid}").json()["filename"]
    assert json.loads((lib / f"{filename}.vibe.json").read_text())["label"] == "red"
    # clear
    c.put(f"/api/v1/images/{iid}/label", json={"label": None})
    assert c.get("/api/v1/images", params={"label": "none"}).json()["total"] == 3


def test_invalid_label_rejected(client):
    c, _ = client
    iid = _ids(c)[0]
    assert c.put(f"/api/v1/images/{iid}/label", json={"label": "pink"}).status_code == 422


# ---------- keywords ----------

def test_keywords_add_remove_filter_and_listing(client):
    c, _ = client
    ids = _ids(c)
    c.patch(f"/api/v1/images/{ids[0]}/keywords", json={"add": ["sunset", "Beach"]})
    c.patch(f"/api/v1/images/{ids[1]}/keywords", json={"add": ["beach"]})

    # case-insensitive keyword filter
    assert c.get("/api/v1/images", params={"keyword": "BEACH"}).json()["total"] == 2
    assert c.get("/api/v1/images", params={"keyword": "sunset"}).json()["total"] == 1

    kws = c.get("/api/v1/keywords").json()["keywords"]
    assert kws[0]["count"] == 2  # beach used twice

    # dedupe: adding an existing keyword (any case) is a no-op
    r = c.patch(f"/api/v1/images/{ids[0]}/keywords", json={"add": ["SUNSET"]})
    assert sorted(k.lower() for k in r.json()["keywords"]) == ["beach", "sunset"]

    r = c.patch(f"/api/v1/images/{ids[0]}/keywords", json={"remove": ["sunset"]})
    assert [k.lower() for k in r.json()["keywords"]] == ["beach"]


def test_keywords_survive_rescan(client):
    c, _ = client
    iid = _ids(c)[0]
    c.patch(f"/api/v1/images/{iid}/keywords", json={"add": ["portrait"]})
    c.post("/api/v1/library/scan", params={"full": True})
    assert c.get(f"/api/v1/images/{iid}").json()["keywords"] == ["portrait"]


# ---------- rich filtering ----------

def test_filename_search(client):
    c, _ = client
    assert c.get("/api/v1/images", params={"q": "a.j"}).json()["total"] == 1
    assert c.get("/api/v1/images", params={"q": "nope"}).json()["total"] == 0


# ---------- batch ----------

def test_batch_recipe_sync(client):
    c, _ = client
    ids = _ids(c)
    r = c.post("/api/v1/batch/recipe", json={
        "image_ids": ids, "patch": {"tone": {"contrast": 25, "clarity": 10}},
    })
    assert r.json()["done"] == 3 and not r.json()["errors"]
    for iid in ids:
        rec = c.get(f"/api/v1/images/{iid}/recipe").json()
        assert rec["tone"]["contrast"] == 25


def test_batch_recipe_reports_bad_ids(client):
    c, _ = client
    ids = _ids(c)
    r = c.post("/api/v1/batch/recipe", json={
        "image_ids": [ids[0], "doesnotexist"], "patch": {"tone": {"exposure": 0.3}},
    })
    body = r.json()
    assert body["done"] == 1 and len(body["errors"]) == 1


def test_batch_meta(client):
    c, _ = client
    ids = _ids(c)
    r = c.post("/api/v1/batch/meta", json={
        "image_ids": ids, "rating": 4, "flag": "pick",
        "label": "green", "add_keywords": ["shoot-42"],
    })
    assert r.json()["done"] == 3
    imgs = c.get("/api/v1/images", params={"rating_gte": 4, "flag": "pick", "label": "green"}).json()
    assert imgs["total"] == 3
    # clear works
    c.post("/api/v1/batch/meta", json={"image_ids": ids, "flag": "clear", "label": "clear"})
    assert c.get("/api/v1/images", params={"flag": "none"}).json()["total"] == 3


def test_batch_export(client):
    c, lib = client
    ids = _ids(c)
    r = c.post("/api/v1/batch/export", json={
        "image_ids": ids, "format": "jpeg", "quality": 80, "max_dimension": 64,
    })
    body = r.json()
    assert body["done"] == 3
    for res in body["results"]:
        assert res["path"].endswith(".jpg")


# ---------- presets ----------

def test_preset_crud_and_apply(client):
    c, _ = client
    ids = _ids(c)
    patch = {"tone": {"contrast": 30}, "effects": {"grain": {"amount": 20}}}
    assert c.put("/api/v1/presets/warm film", json={"patch": patch}).status_code == 200

    names = [p["name"] for p in c.get("/api/v1/presets").json()["presets"]]
    assert "warm film" in names
    assert c.get("/api/v1/presets/warm film").json()["patch"] == patch

    r = c.post("/api/v1/presets/warm film/apply", json={"image_ids": [ids[0]]})
    assert r.json()["done"] == 1
    rec = c.get(f"/api/v1/images/{ids[0]}/recipe").json()
    assert rec["tone"]["contrast"] == 30 and rec["effects"]["grain"]["amount"] == 20

    assert c.delete("/api/v1/presets/warm film").status_code == 200
    assert c.get("/api/v1/presets/warm film").status_code == 404


def test_preset_rejects_invalid_patch(client):
    c, _ = client
    r = c.put("/api/v1/presets/bad", json={"patch": {"tone": {"exposure": 99}}})
    assert r.status_code == 422


def test_preset_rejects_bad_name(client):
    c, _ = client
    r = c.put("/api/v1/presets/..%2Fescape", json={"patch": {}})
    assert r.status_code in (404, 422)


# ---------- export formats ----------

def test_export_png_and_tiff(client):
    c, _ = client
    iid = _ids(c)[0]
    for fmt, pil_fmt in (("png", "PNG"), ("tiff", "TIFF")):
        r = c.post(f"/api/v1/images/{iid}/export", json={"format": fmt, "max_dimension": 64})
        assert r.status_code == 200
        with Image.open(r.json()["path"]) as im:
            assert im.format == pil_fmt and max(im.size) == 64


def test_export_png16(client):
    c, _ = client
    iid = _ids(c)[0]
    r = c.post(f"/api/v1/images/{iid}/export", json={"format": "png", "bit_depth": 16})
    assert r.status_code == 200
    path = r.json()["path"]
    with Image.open(path) as im:
        assert im.format == "PNG"
        assert im.mode in ("RGB", "I;16", "RGB;16")  # PIL reads 16-bit RGB as RGB
    # verify the file really declares 16-bit depth in its IHDR
    raw = open(path, "rb").read()
    ihdr = raw.index(b"IHDR")
    assert raw[ihdr + 12] == 16  # bit depth byte


def test_export_16bit_jpeg_rejected(client):
    c, _ = client
    iid = _ids(c)[0]
    r = c.post(f"/api/v1/images/{iid}/export", json={"format": "jpeg", "bit_depth": 16})
    assert r.status_code == 422


# ---------- recipe with masks over the API ----------

def test_recipe_with_masks_roundtrip_and_preview(client):
    c, _ = client
    iid = _ids(c)[0]
    patch = {"masks": [{"type": "radial", "center": [0.5, 0.5], "radiusX": 0.4,
                          "radiusY": 0.4, "adjustments": {"exposure": 1.0}}]}
    r = c.patch(f"/api/v1/images/{iid}/recipe", json=patch)
    assert r.status_code == 200
    assert r.json()["masks"][0]["type"] == "radial"
    pv = c.get(f"/api/v1/images/{iid}/preview", params={"size": 256})
    assert pv.status_code == 200 and pv.content[:2] == b"\xff\xd8"


def test_auto_preserves_masks_and_effects(client):
    c, _ = client
    iid = _ids(c)[0]
    c.patch(f"/api/v1/images/{iid}/recipe", json={
        "effects": {"vignette": {"amount": -30}},
        "masks": [{"type": "linear", "start": [0, 0], "end": [1, 1],
                    "adjustments": {"saturation": 10}}],
    })
    r = c.post(f"/api/v1/images/{iid}/auto", json={"white_balance": True})
    body = r.json()
    assert body["effects"]["vignette"]["amount"] == -30
    assert len(body["masks"]) == 1


# ---------- history / snapshots (#10) ----------

def test_history_records_and_restores(client):
    c, _ = client
    iid = _ids(c)[0]
    c.patch(f"/api/v1/images/{iid}/recipe", json={"tone": {"exposure": 1.0}})
    c.patch(f"/api/v1/images/{iid}/recipe", json={"tone": {"exposure": 2.0}})
    h = c.get(f"/api/v1/images/{iid}/history").json()
    assert len(h["entries"]) == 2  # default recipe, then exposure=1.0

    entry = c.get(f"/api/v1/images/{iid}/history/1").json()
    assert entry["recipe"]["tone"]["exposure"] == 1.0

    r = c.post(f"/api/v1/images/{iid}/history/1/restore")
    assert r.json()["tone"]["exposure"] == 1.0
    assert c.get(f"/api/v1/images/{iid}/recipe").json()["tone"]["exposure"] == 1.0
    # the restore itself pushed exposure=2.0 to history (undoable)
    h2 = c.get(f"/api/v1/images/{iid}/history").json()
    assert len(h2["entries"]) == 3


def test_unchanged_recipe_writes_no_history(client):
    c, _ = client
    iid = _ids(c)[0]
    c.patch(f"/api/v1/images/{iid}/recipe", json={"tone": {"exposure": 1.0}})
    c.patch(f"/api/v1/images/{iid}/recipe", json={"tone": {"exposure": 1.0}})  # no-op
    h = c.get(f"/api/v1/images/{iid}/history").json()
    assert len(h["entries"]) == 1


def test_snapshot_save_restore_delete(client):
    c, _ = client
    iid = _ids(c)[0]
    c.patch(f"/api/v1/images/{iid}/recipe", json={"tone": {"contrast": 40}})
    c.put(f"/api/v1/images/{iid}/snapshots/punchy")
    c.patch(f"/api/v1/images/{iid}/recipe", json={"tone": {"contrast": 0}})

    r = c.post(f"/api/v1/images/{iid}/snapshots/punchy/restore")
    assert r.json()["tone"]["contrast"] == 40
    assert c.get(f"/api/v1/images/{iid}/recipe").json()["tone"]["contrast"] == 40

    assert c.delete(f"/api/v1/images/{iid}/snapshots/punchy").status_code == 200
    assert c.post(f"/api/v1/images/{iid}/snapshots/punchy/restore").status_code == 404


# ---------- virtual copies (#11) ----------

def test_variant_create_render_export_promote(client):
    c, _ = client
    iid = _ids(c)[0]
    c.patch(f"/api/v1/images/{iid}/recipe", json={"tone": {"exposure": 0.5}})
    # variant with an explicit recipe
    r = c.put(f"/api/v1/images/{iid}/variants/bw", json={
        "recipe": {"color": {"saturation": -100}},
    })
    assert r.status_code == 200
    assert "bw" in c.get(f"/api/v1/images/{iid}/history").json()["variants"]

    # renders independently of the main recipe
    pv = c.get(f"/api/v1/images/{iid}/preview", params={"size": 256, "variant": "bw"})
    assert pv.status_code == 200
    assert c.get(f"/api/v1/images/{iid}/preview",
                 params={"size": 256, "variant": "nope"}).status_code == 404

    # exports with a variant-suffixed filename
    ex = c.post(f"/api/v1/images/{iid}/export", json={"variant": "bw", "max_dimension": 64})
    assert ex.json()["path"].endswith("-bw.jpg")

    # promote: variant becomes main, old main goes to history
    c.post(f"/api/v1/images/{iid}/variants/bw/promote")
    main = c.get(f"/api/v1/images/{iid}/recipe").json()
    assert main["color"]["saturation"] == -100

    assert c.delete(f"/api/v1/images/{iid}/variants/bw").status_code == 200


def test_variant_copies_current_recipe_when_body_omitted(client):
    c, _ = client
    iid = _ids(c)[0]
    c.patch(f"/api/v1/images/{iid}/recipe", json={"tone": {"clarity": 33}})
    r = c.put(f"/api/v1/images/{iid}/variants/copy")
    assert r.json()["recipe"]["tone"]["clarity"] == 33
