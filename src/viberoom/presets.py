"""Develop presets: named partial recipes stored as plain JSON under
`~/.viberoom/presets/<name>.json`, shared across libraries. A preset is a
merge-patch — applying it deep-merges into an image's existing recipe, so a
"warm film" preset can coexist with per-image crops and masks."""

from __future__ import annotations

import json
import re
from pathlib import Path

from pydantic import ValidationError

from viberoom.config import APP_DIR_NAME
from viberoom.recipe.schema import Recipe

PRESETS_DIR = Path.home() / APP_DIR_NAME / "presets"

_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9 _\-]{0,63}$")


class PresetError(ValueError):
    pass


def _path(name: str) -> Path:
    if not _NAME_RE.match(name):
        raise PresetError(
            "preset names are 1-64 chars: letters, digits, spaces, '-', '_' (no leading symbol)"
        )
    return PRESETS_DIR / f"{name}.json"


def validate_patch(patch: dict) -> None:
    """A preset must deep-merge cleanly into a default recipe."""
    from viberoom.recipe.merge import deep_merge

    try:
        Recipe.model_validate(deep_merge(Recipe().model_dump(mode="json"), patch))
    except ValidationError as e:
        raise PresetError(f"invalid recipe patch: {e.errors(include_url=False)}")


def save_preset(name: str, patch: dict) -> dict:
    validate_patch(patch)
    p = _path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(patch, indent=2) + "\n")
    return {"name": name, "patch": patch}


def load_preset(name: str) -> dict:
    p = _path(name)
    if not p.exists():
        raise KeyError(name)
    return json.loads(p.read_text())


def delete_preset(name: str) -> None:
    p = _path(name)
    if not p.exists():
        raise KeyError(name)
    p.unlink()


def list_presets() -> list[dict]:
    if not PRESETS_DIR.is_dir():
        return []
    out = []
    for p in sorted(PRESETS_DIR.glob("*.json")):
        try:
            out.append({"name": p.stem, "patch": json.loads(p.read_text())})
        except (json.JSONDecodeError, OSError):
            continue
    return out
