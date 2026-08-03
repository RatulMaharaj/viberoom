import json

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from viberoom.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # keep global state file out of the user's home during tests
    import viberoom.config as config

    monkeypatch.setattr(config, "STATE_FILE", tmp_path / "state.json")
    # create a small library of JPEGs (RAW decode is covered manually)
    lib = tmp_path / "photos"
    lib.mkdir()
    rng = np.random.default_rng(42)
    for name in ["a.jpg", "b.jpg", "c.jpg"]:
        arr = rng.integers(0, 255, (64, 96, 3), dtype=np.uint8)
        Image.fromarray(arr).save(lib / name)

    with TestClient(app) as c:
        r = c.post("/api/v1/library", json={"path": str(lib)})
        assert r.status_code == 200 and r.json()["total"] == 3
        yield c, lib


def _first_id(c):
    return c.get("/api/v1/images").json()["images"][0]["id"]


def test_list_and_filter(client):
    c, _ = client
    iid = _first_id(c)
    c.put(f"/api/v1/images/{iid}/rating", json={"rating": 5})
    r = c.get("/api/v1/images", params={"rating_gte": 4})
    assert r.json()["total"] == 1
    assert r.json()["images"][0]["id"] == iid


def test_rating_writes_sidecar(client):
    c, lib = client
    iid = _first_id(c)
    c.put(f"/api/v1/images/{iid}/rating", json={"rating": 3})
    filename = c.get(f"/api/v1/images/{iid}").json()["filename"]
    sc = json.loads((lib / f"{filename}.vibe.json").read_text())
    assert sc["rating"] == 3


def test_flag_and_filter(client):
    c, _ = client
    iid = _first_id(c)
    c.put(f"/api/v1/images/{iid}/flag", json={"flag": "pick"})
    assert c.get("/api/v1/images", params={"flag": "pick"}).json()["total"] == 1
    assert c.get("/api/v1/images", params={"flag": "none"}).json()["total"] == 2


def test_recipe_validation(client):
    c, _ = client
    iid = _first_id(c)
    bad = {"tone": {"exposure": 99}}
    assert c.put(f"/api/v1/images/{iid}/recipe", json=bad).status_code == 422
    assert c.patch(f"/api/v1/images/{iid}/recipe", json=bad).status_code == 422


def test_recipe_patch_merges(client):
    c, _ = client
    iid = _first_id(c)
    c.patch(f"/api/v1/images/{iid}/recipe", json={"tone": {"exposure": 1.0}})
    r = c.patch(f"/api/v1/images/{iid}/recipe", json={"color": {"vibrance": 20}})
    body = r.json()
    assert body["tone"]["exposure"] == 1.0 and body["color"]["vibrance"] == 20
    # reset
    c.delete(f"/api/v1/images/{iid}/recipe")
    assert c.get(f"/api/v1/images/{iid}/recipe").json()["tone"]["exposure"] == 0


def test_sidecar_edit_then_rescan(client):
    c, lib = client
    iid = _first_id(c)
    filename = c.get(f"/api/v1/images/{iid}").json()["filename"]
    sc_path = lib / f"{filename}.vibe.json"
    sc_path.write_text(json.dumps({"version": 1, "rating": 2, "flag": "reject", "recipe": {}}))
    c.post("/api/v1/library/scan")
    img = c.get(f"/api/v1/images/{iid}").json()
    assert img["rating"] == 2 and img["flag"] == "reject"


def test_preview_and_thumbnail(client):
    c, _ = client
    iid = _first_id(c)
    assert c.get(f"/api/v1/images/{iid}/thumbnail").headers["content-type"] == "image/jpeg"
    r = c.get(f"/api/v1/images/{iid}/preview", params={"size": 256})
    assert r.status_code == 200 and r.content[:2] == b"\xff\xd8"


def test_preview_and_thumbnail_revalidate_with_etag(client):
    """A second request carrying the ETag should get a bodyless 304."""
    c, _ = client
    iid = _first_id(c)

    for url, params in (
        (f"/api/v1/images/{iid}/thumbnail", {}),
        (f"/api/v1/images/{iid}/preview", {"size": 256}),
        (f"/api/v1/images/{iid}/proof", {"space": "display-p3"}),
    ):
        first = c.get(url, params=params)
        assert first.status_code == 200
        etag = first.headers["etag"]
        assert "immutable" in first.headers["cache-control"]

        again = c.get(url, params=params, headers={"If-None-Match": etag})
        assert again.status_code == 304, url
        assert not again.content
        assert again.headers["etag"] == etag


def test_preview_etag_changes_when_the_recipe_does(client):
    """The ETag has to track the recipe, or edits would never become visible."""
    c, _ = client
    iid = _first_id(c)
    before = c.get(f"/api/v1/images/{iid}/preview", params={"size": 256}).headers["etag"]

    c.patch(f"/api/v1/images/{iid}/recipe", json={"tone": {"exposure": 1.25}})
    after = c.get(f"/api/v1/images/{iid}/preview", params={"size": 256})

    assert after.status_code == 200
    assert after.headers["etag"] != before
    # The stale validator must not satisfy the new request.
    assert c.get(
        f"/api/v1/images/{iid}/preview",
        params={"size": 256},
        headers={"If-None-Match": before},
    ).status_code == 200


def test_export(client):
    c, lib = client
    iid = _first_id(c)
    c.patch(f"/api/v1/images/{iid}/recipe", json={"tone": {"exposure": 0.5}})
    r = c.post(f"/api/v1/images/{iid}/export", json={"quality": 80, "max_dimension": 64})
    out = r.json()["path"]
    with Image.open(out) as im:
        assert max(im.size) == 64
        assert im.format == "JPEG"


def test_recipe_schema_served(client):
    c, _ = client
    schema = c.get("/api/v1/recipe/schema").json()
    assert "whiteBalance" in schema["properties"]
