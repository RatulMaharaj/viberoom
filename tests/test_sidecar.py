import json
from pathlib import Path

from viberoom.recipe.schema import Recipe
from viberoom.recipe.sidecar import Sidecar, load_sidecar, save_sidecar, sidecar_path


def test_sidecar_roundtrip(tmp_path: Path):
    img = tmp_path / "IMG_0001.CR3"
    img.write_bytes(b"fake")
    sc = Sidecar(rating=4, flag="pick")
    sc.recipe.tone.exposure = 1.5
    save_sidecar(img, sc)

    assert sidecar_path(img).name == "IMG_0001.CR3.vibe.json"
    loaded = load_sidecar(img)
    assert loaded.rating == 4
    assert loaded.flag == "pick"
    assert loaded.recipe.tone.exposure == 1.5


def test_missing_sidecar_defaults(tmp_path: Path):
    img = tmp_path / "IMG_0002.NEF"
    img.write_bytes(b"fake")
    sc = load_sidecar(img)
    assert sc.rating == 0 and sc.flag is None and sc.recipe == Recipe()


def test_malformed_sidecar_is_safe(tmp_path: Path):
    img = tmp_path / "IMG_0003.ARW"
    img.write_bytes(b"fake")
    sidecar_path(img).write_text("{ not json")
    assert load_sidecar(img) == Sidecar()


def test_sidecar_is_pretty_json(tmp_path: Path):
    img = tmp_path / "a.dng"
    img.write_bytes(b"fake")
    save_sidecar(img, Sidecar(rating=2))
    text = sidecar_path(img).read_text()
    assert json.loads(text)["rating"] == 2
    assert "\n" in text  # pretty-printed for diffability
