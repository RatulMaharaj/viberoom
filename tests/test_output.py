"""Output tests: export extras (watermark, sharpening, templates, presets),
color management (wide gamut + ICC + proofing), HDR/pano merge."""

import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageCms

from viberoom.color_mgmt import conversion_matrix, convert_from_srgb, profile_bytes
from viberoom.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import viberoom.config as config
    import viberoom.export_extras as ee

    monkeypatch.setattr(config, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(ee, "EXPORT_PRESETS_DIR", tmp_path / "export-presets")
    lib = tmp_path / "photos"
    lib.mkdir()
    rng = np.random.default_rng(11)
    for name in ("a.jpg", "b.jpg", "c.jpg"):
        arr = rng.integers(30, 220, (48, 72, 3), dtype=np.uint8)
        Image.fromarray(arr).save(lib / name)
    with TestClient(app) as c:
        c.post("/api/v1/library", json={"path": str(lib)})
        yield c, lib


def _ids(c):
    return [i["id"] for i in c.get("/api/v1/images").json()["images"]]


# ---------- color management (#12) ----------

def test_profiles_parse_with_littlecms():
    for space in ("display-p3", "adobe-rgb", "prophoto"):
        prof = ImageCms.ImageCmsProfile(io.BytesIO(profile_bytes(space)))
        assert "viberoom" in ImageCms.getProfileDescription(prof)


def test_conversion_matrix_identity_and_invertibility():
    assert np.allclose(conversion_matrix("srgb", "srgb"), np.eye(3), atol=1e-9)
    m = conversion_matrix("srgb", "prophoto")
    m_inv = conversion_matrix("prophoto", "srgb")
    assert np.allclose(m @ m_inv, np.eye(3), atol=1e-6)


def test_srgb_content_fits_wide_gamuts():
    img = np.random.default_rng(0).uniform(0, 1, (16, 16, 3))
    for space in ("display-p3", "prophoto"):
        _, oog = convert_from_srgb(img, space)
        assert oog.mean() < 0.01  # sRGB is inside both


def test_export_wide_gamut_embeds_profile(client):
    c, _ = client
    iid = _ids(c)[0]
    r = c.post(f"/api/v1/images/{iid}/export", json={
        "format": "jpeg", "color_space": "adobe-rgb", "max_dimension": 64,
    })
    with Image.open(r.json()["path"]) as im:
        icc = im.info.get("icc_profile")
    assert icc and b"Adobe RGB compatible" in icc


def test_export_png16_wide_gamut_has_iccp(client):
    c, _ = client
    iid = _ids(c)[0]
    r = c.post(f"/api/v1/images/{iid}/export", json={
        "format": "png", "bit_depth": 16, "color_space": "display-p3",
    })
    raw = open(r.json()["path"], "rb").read()
    assert b"iCCP" in raw


def test_soft_proof_endpoint(client):
    c, _ = client
    iid = _ids(c)[0]
    r = c.get(f"/api/v1/images/{iid}/proof", params={"space": "display-p3", "warn": True})
    assert r.status_code == 200 and r.content[:2] == b"\xff\xd8"
    assert "x-out-of-gamut-percent" in {k.lower() for k in r.headers}


def test_soft_proof_returns_proofed_pixels(client):
    """The endpoint used to compute the proofed image and then encode the
    unproofed one, so every space looked identical to the plain preview."""
    c, _ = client
    iid = _ids(c)[0]
    # A wide-gamut target is the case where proofing actually moves pixels.
    plain = c.get(f"/api/v1/images/{iid}/preview", params={"size": 256}).content
    proofed = c.get(
        f"/api/v1/images/{iid}/proof", params={"space": "prophoto", "size": 256}
    ).content
    assert proofed != plain


# ---------- export extras (#19) ----------

def test_watermark_text_changes_corner(client):
    c, _ = client
    iid = _ids(c)[0]
    plain = c.post(f"/api/v1/images/{iid}/export", json={"max_dimension": 200}).json()["path"]
    marked = c.post(f"/api/v1/images/{iid}/export", json={
        "max_dimension": 200,
        "watermark": {"text": "© viberoom", "position": "bottom-right", "opacity": 100},
        "path": plain.replace(".jpg", "-wm.jpg"),
    }).json()["path"]
    a = np.asarray(Image.open(plain), dtype=np.int16)
    b = np.asarray(Image.open(marked), dtype=np.int16)
    h, w = a.shape[:2]
    corner_diff = np.abs(a[h // 2:, w // 2:] - b[h // 2:, w // 2:]).mean()
    top_diff = np.abs(a[: h // 4, : w // 4] - b[: h // 4, : w // 4]).mean()
    assert corner_diff > top_diff  # stamp lives bottom-right


def test_output_sharpen_increases_detail(client):
    c, _ = client
    iid = _ids(c)[0]
    plain = c.post(f"/api/v1/images/{iid}/export", json={"max_dimension": 64}).json()["path"]
    sharp = c.post(f"/api/v1/images/{iid}/export", json={
        "max_dimension": 64, "output_sharpen": "screen",
        "path": plain.replace(".jpg", "-sh.jpg"),
    }).json()["path"]
    a = np.asarray(Image.open(plain), dtype=np.float32)
    b = np.asarray(Image.open(sharp), dtype=np.float32)
    assert b.std() > a.std()


def test_batch_export_filename_template(client):
    c, _ = client
    ids = _ids(c)
    r = c.post("/api/v1/batch/export", json={
        "image_ids": ids, "max_dimension": 64,
        "filename": "web/{seq}-{name}{ext}",
    })
    body = r.json()
    assert body["done"] == 3
    assert all("/web/" in res["path"] for res in body["results"])
    assert any("0001-" in res["path"] for res in body["results"])


def test_export_preset_roundtrip(client):
    c, _ = client
    iid = _ids(c)[0]
    r = c.put("/api/v1/export-presets/web", json={"settings": {
        "format": "jpeg", "quality": 70, "max_dimension": 64,
        "output_sharpen": "screen",
    }})
    assert r.status_code == 200
    names = [p["name"] for p in c.get("/api/v1/export-presets").json()["presets"]]
    assert "web" in names
    # preset applies; explicit fields override
    out = c.post(f"/api/v1/images/{iid}/export", json={"preset": "web"}).json()
    with Image.open(out["path"]) as im:
        assert max(im.size) == 64
    assert c.delete("/api/v1/export-presets/web").status_code == 200


def test_export_preset_rejects_bad_settings(client):
    c, _ = client
    r = c.put("/api/v1/export-presets/bad", json={"settings": {"quality": 9999}})
    assert r.status_code == 422


# ---------- HDR / pano merge (#9) ----------

def test_hdr_merge_creates_library_image(client):
    c, lib = client
    # simulate a bracket: same scene at -2/0/+2 EV
    rng = np.random.default_rng(4)
    base = rng.uniform(0.2, 0.8, (48, 72, 3))
    for name, ev in (("u.jpg", 0.25), ("m.jpg", 1.0), ("o.jpg", 2.5)):
        Image.fromarray((np.clip(base * ev, 0, 1) * 255).astype(np.uint8)).save(lib / name)
    c.post("/api/v1/library/scan")
    imgs = c.get("/api/v1/images", params={"limit": 100}).json()["images"]
    bracket = [i["id"] for i in imgs if i["filename"] in ("u.jpg", "m.jpg", "o.jpg")]

    r = c.post("/api/v1/merge/hdr", json={"image_ids": bracket, "out_name": "merged"})
    assert r.status_code == 200
    body = r.json()
    assert body["path"].endswith("merged.png")
    # the merged image is in the library and renderable
    pv = c.get(f"/api/v1/images/{body['id']}/preview", params={"size": 256})
    assert pv.status_code == 200


def test_pano_merge_wider_than_inputs(client):
    c, lib = client
    # two overlapping halves of a wide gradient scene
    g = np.linspace(0, 1, 140)[None, :, None].repeat(48, 0).repeat(3, 2)
    scene = (g * 255).astype(np.uint8)
    Image.fromarray(scene[:, :90]).save(lib / "p1.jpg")
    Image.fromarray(scene[:, 50:]).save(lib / "p2.jpg")
    c.post("/api/v1/library/scan")
    imgs = c.get("/api/v1/images", params={"limit": 100}).json()["images"]
    pair = [i["id"] for i in imgs if i["filename"] in ("p1.jpg", "p2.jpg")]

    r = c.post("/api/v1/merge/pano", json={"image_ids": pair})
    assert r.status_code == 200
    with Image.open(r.json()["path"]) as im:
        assert im.width > 90  # wider than either input


def _decode_png16(path):
    """Decode a filter-0 16-bit RGB PNG back to uint16. Pillow downsamples
    16-bit RGB to 8-bit on load, so exact round-trip checks need this."""
    import struct
    import zlib

    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, size = 8, b"", None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            w, h, depth, color = struct.unpack(">IIBB", body[:10])
            size = (w, h, depth, color)
        elif tag == b"IDAT":
            idat += body
        pos += 12 + length
    w, h, depth, color = size
    raw = np.frombuffer(zlib.decompress(idat), np.uint8).reshape(h, 1 + w * 3 * 2)
    assert not raw[:, 0].any(), "filter bytes must all be 0"
    px = raw[:, 1:].reshape(h, w * 3, 2).astype(np.uint16)
    return (px[..., 0] << 8 | px[..., 1]).reshape(h, w, 3), depth, color


def test_png16_writer_is_lossless_and_16bit(tmp_path):
    """The 16-bit PNG writer must round-trip exactly. Values are chosen so a
    wrong byte order, a dropped filter byte or a row-stride slip all change
    the decoded pixels rather than merely reordering equal samples."""
    from viberoom.export import _write_png16

    rng = np.random.default_rng(1234)
    arr = rng.integers(0, 65536, (37, 53, 3)).astype(np.uint16)
    # asymmetric byte pairs so >u2 vs <u2 cannot decode the same
    arr[0, 0] = (0x00FF, 0xFF00, 0x0102)
    arr[-1, -1] = (0xFFFE, 0x0001, 0x8000)

    out = tmp_path / "sixteen.png"
    _write_png16(arr, out)

    back, depth, color = _decode_png16(out)
    assert (depth, color) == (16, 2)
    assert np.array_equal(back, arr)

    # and it is a PNG real decoders accept, at the right size
    with Image.open(out) as im:
        assert im.size == (53, 37)
        assert im.mode == "RGB"


def test_png16_header_declares_depth_16_rgb(tmp_path):
    """Guards the IHDR itself: Pillow would happily decode an 8-bit file too."""
    import struct

    from viberoom.export import _write_png16

    out = tmp_path / "hdr.png"
    _write_png16(np.full((4, 6, 3), 40000, np.uint16), out)
    data = out.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert data[12:16] == b"IHDR"
    w, h, depth, color = struct.unpack(">IIBB", data[16:26])
    assert (w, h, depth, color) == (6, 4, 16, 2)


def test_png16_chunk_lengths_and_crcs_are_valid(tmp_path):
    """The IDAT length is back-patched after streaming, so walk every chunk."""
    import struct
    import zlib

    from viberoom.export import _write_png16

    out = tmp_path / "chunks.png"
    rng = np.random.default_rng(7)
    _write_png16(rng.integers(0, 65536, (64, 96, 3)).astype(np.uint16), out)

    data = out.read_bytes()
    pos, tags, idat = 8, [], b""
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        (crc,) = struct.unpack(">I", data[pos + 8 + length:pos + 12 + length])
        assert crc == zlib.crc32(tag + body) & 0xFFFFFFFF, tag
        tags.append(tag)
        if tag == b"IDAT":
            idat += body
        pos += 12 + length
    assert pos == len(data)
    assert tags[0] == b"IHDR" and tags[-1] == b"IEND"
    # every scanline carries filter byte 0 and a full row of samples
    raw = zlib.decompress(idat)
    assert len(raw) == 64 * (1 + 96 * 3 * 2)
    assert set(raw[::1 + 96 * 3 * 2]) == {0}


def test_export_png16_matches_the_float_render(tmp_path, client):
    """End-to-end: what lands on disk is the quantised float render, exactly."""
    from viberoom.engine.cache import render_full_float
    from viberoom.export import export_image
    from viberoom.recipe.schema import Recipe

    _c, lib = client
    src = lib / "sixteen_src.jpg"
    g = np.linspace(0, 1, 61)[None, :, None].repeat(43, 0).repeat(3, 2)
    Image.fromarray((g * 255).astype(np.uint8)).save(src, quality=95)

    recipe = Recipe()
    out = export_image(src, recipe, tmp_path / "out.png", "png", bit_depth=16)
    expected = (render_full_float(src, recipe) * 65535).round().astype(np.uint16)
    back, depth, _color = _decode_png16(out)
    assert depth == 16
    assert np.array_equal(back, expected)
