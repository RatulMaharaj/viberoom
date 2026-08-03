"""The /source endpoint and the RGB9_E5 packing behind it.

The load-bearing property is dimensional: the client renders the frame this
endpoint hands it, and then swaps to the server's JPEG. If the two are cut
from different resolutions the swap jumps, so the dimension test here compares
against the array `render_preview` actually feeds to `render()`.
"""

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from viberoom.engine.source import encode_rgb9e5
from viberoom.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import viberoom.config as config

    monkeypatch.setattr(config, "STATE_FILE", tmp_path / "state.json")
    lib = tmp_path / "photos"
    lib.mkdir()
    # Big enough that `_preview_scale` actually shrinks it for small `size`
    # values — a 96 px test image would never exercise the downscale path.
    rng = np.random.default_rng(7)
    arr = rng.integers(0, 255, (600, 900, 3), dtype=np.uint8)
    Image.fromarray(arr).save(lib / "a.jpg", quality=95)

    with TestClient(app) as c:
        assert c.post("/api/v1/library", json={"path": str(lib)}).status_code == 200
        yield c, lib


def _first_id(c):
    return c.get("/api/v1/images").json()["images"][0]["id"]


def _decode_rgb9e5(blob: bytes, h: int, w: int) -> np.ndarray:
    packed = np.frombuffer(blob, dtype="<u4").reshape(h, w)
    exp = (packed >> 27).astype(np.int32)
    m = np.stack([(packed >> s) & 511 for s in (0, 9, 18)], axis=-1).astype(np.float32)
    return m * np.exp2(exp - 15 - 9).astype(np.float32)[..., None]


@pytest.mark.parametrize("size", [256, 512, 1600])
def test_source_dims_match_what_render_preview_renders(client, monkeypatch, size):
    c, _ = client
    iid = _first_id(c)

    # Capture the frame `render_preview` hands to the pipeline, which is the
    # thing the client has to agree with — not the JPEG that comes out.
    import viberoom.engine.cache as cache

    seen: list[tuple[int, int]] = []
    real_render = cache.render

    def spy(linear, recipe, scale=1.0):
        seen.append(linear.shape[:2])
        return real_render(linear, recipe, scale)

    monkeypatch.setattr(cache, "render", spy)
    assert c.get(f"/api/v1/images/{iid}/preview", params={"size": size}).status_code == 200
    assert seen, "render_preview served from cache; the spy saw nothing"

    r = c.get(f"/api/v1/images/{iid}/source", params={"size": size})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/octet-stream"
    h, w = seen[-1]
    assert (int(r.headers["X-Source-Height"]), int(r.headers["X-Source-Width"])) == (h, w)
    assert r.headers["X-Source-Format"] == "rgb9e5"
    assert len(r.content) == w * h * 4


def test_source_rgba16f_size_and_headers(client):
    c, _ = client
    iid = _first_id(c)
    r = c.get(f"/api/v1/images/{iid}/source", params={"size": 512, "format": "rgba16f"})
    assert r.status_code == 200
    w, h = int(r.headers["X-Source-Width"]), int(r.headers["X-Source-Height"])
    assert len(r.content) == w * h * 8
    assert r.headers["X-Source-Format"] == "rgba16f"
    # alpha is pinned so the shader never has to think about it
    px = np.frombuffer(r.content, dtype="<f2").reshape(h, w, 4)
    assert np.all(px[..., 3] == 1.0)


def test_source_etag_and_304(client):
    c, _ = client
    iid = _first_id(c)
    r = c.get(f"/api/v1/images/{iid}/source", params={"size": 512})
    etag = r.headers["ETag"]
    assert "immutable" in r.headers["Cache-Control"]

    again = c.get(
        f"/api/v1/images/{iid}/source",
        params={"size": 512},
        headers={"If-None-Match": etag},
    )
    assert again.status_code == 304
    assert again.content == b""
    # dimensions still ship, so a revalidating client is never left guessing
    assert again.headers["X-Source-Width"] == r.headers["X-Source-Width"]
    assert again.headers["X-Source-Height"] == r.headers["X-Source-Height"]

    stale = c.get(
        f"/api/v1/images/{iid}/source",
        params={"size": 512},
        headers={"If-None-Match": '"nope"'},
    )
    assert stale.status_code == 200


def test_source_size_changes_the_etag(client):
    c, _ = client
    iid = _first_id(c)
    a = c.get(f"/api/v1/images/{iid}/source", params={"size": 512})
    b = c.get(f"/api/v1/images/{iid}/source", params={"size": 1024})
    assert a.headers["ETag"] != b.headers["ETag"]


def test_rgb9e5_roundtrip_precision():
    rng = np.random.default_rng(3)
    src = rng.random((16, 24, 3), dtype=np.float32) * 1.2
    out = _decode_rgb9e5(encode_rgb9e5(src), 16, 24)

    # The exponent is shared, so the quantum is fixed by the brightest channel
    # of the pixel and every channel is off by at most half of it — worst case
    # max/256, and in practice a quarter of that, which is the number that
    # matters: it is far below what an 8-bit display can show.
    maxc = src.max(axis=-1)[..., None]
    err = np.abs(out - src) / maxc
    assert err.max() <= 1 / 256
    assert err.mean() < 1 / 1000


def test_rgb9e5_keeps_highlight_headroom():
    # The whole reason for a shared exponent: a RAW decode carries values well
    # past 1.0 and recovery sliders need them, so clipping here would be fatal.
    src = np.array([[[1.0, 4.0, 40.0], [900.0, 0.5, 0.0]]], dtype=np.float32)
    out = _decode_rgb9e5(encode_rgb9e5(src), 1, 2)
    assert np.all(np.abs(out - src) <= src.max(axis=-1)[..., None] / 256.0)
    assert out[0, 0, 2] > 39.0 and out[0, 1, 0] > 890.0


def test_rgb9e5_zero_and_nan_are_black():
    src = np.array([[[0.0, 0.0, 0.0], [np.nan, np.nan, np.nan]]], dtype=np.float32)
    assert np.all(_decode_rgb9e5(encode_rgb9e5(src), 1, 2) == 0)
