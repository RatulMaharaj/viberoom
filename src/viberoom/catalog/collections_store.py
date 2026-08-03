"""Collections: named groups of images stored per-library in
`.viberoom/collections.json`. Static collections hold explicit id lists;
smart collections hold a saved /images filter query evaluated live."""

from __future__ import annotations

import json
import re
from pathlib import Path

from viberoom.config import Library

_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9 _\-]{0,63}$")

# keys a smart collection query may use (mirrors /images filters)
SMART_KEYS = {
    "rating_gte", "flag", "label", "keyword", "camera", "lens",
    "iso_gte", "iso_lte", "taken_after", "taken_before", "q", "folder",
    "ext", "has_edits",
}


class CollectionError(ValueError):
    pass


def _file(library: Library) -> Path:
    return library.app_dir / "collections.json"


def _load(library: Library) -> dict:
    f = _file(library)
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _save(library: Library, data: dict) -> None:
    _file(library).write_text(json.dumps(data, indent=2) + "\n")


def list_collections(library: Library) -> list[dict]:
    return [
        {"name": name, **spec} for name, spec in sorted(_load(library).items())
    ]


def get_collection(library: Library, name: str) -> dict:
    data = _load(library)
    if name not in data:
        raise KeyError(name)
    return data[name]


def save_collection(library: Library, name: str, spec: dict) -> dict:
    if not _NAME_RE.match(name):
        raise CollectionError(
            "collection names are 1-64 chars: letters, digits, spaces, '-', '_'"
        )
    kind = spec.get("type")
    if kind == "static":
        ids = spec.get("ids", [])
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise CollectionError("static collection needs 'ids': list of image ids")
        clean = {"type": "static", "ids": list(dict.fromkeys(ids))}
    elif kind == "smart":
        query = spec.get("query", {})
        bad = set(query) - SMART_KEYS
        if bad:
            raise CollectionError(f"unknown smart query keys: {sorted(bad)}; allowed: {sorted(SMART_KEYS)}")
        clean = {"type": "smart", "query": query}
    else:
        raise CollectionError("collection 'type' must be 'static' or 'smart'")
    data = _load(library)
    data[name] = clean
    _save(library, data)
    return {"name": name, **clean}


def delete_collection(library: Library, name: str) -> None:
    data = _load(library)
    if name not in data:
        raise KeyError(name)
    del data[name]
    _save(library, data)


def edit_static(library: Library, name: str, add: list[str], remove: list[str]) -> dict:
    data = _load(library)
    if name not in data:
        raise KeyError(name)
    spec = data[name]
    if spec["type"] != "static":
        raise CollectionError("can only add/remove images on a static collection")
    ids = [i for i in spec["ids"] if i not in set(remove)]
    ids += [i for i in add if i not in set(ids)]
    spec["ids"] = ids
    _save(library, data)
    return {"name": name, **spec}
