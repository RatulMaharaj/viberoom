"""Caching: disk cache for rendered previews, in-memory LRU for decoded
linear arrays (decode is the expensive step when iterating on a recipe)."""

from __future__ import annotations

import hashlib
import io
from collections import OrderedDict
from pathlib import Path

import numpy as np
from PIL import Image

from viberoom.engine.decode import decode_linear
from viberoom.engine.pipeline import render
from viberoom.recipe.schema import Recipe


class DecodeCache:
    """Tiny LRU of decoded linear ndarrays keyed by (path, mtime, half_size)."""

    def __init__(self, max_entries: int = 2):
        self._max = max_entries
        self._store: OrderedDict[tuple, np.ndarray] = OrderedDict()

    def get(self, path: Path, half_size: bool) -> np.ndarray:
        key = (str(path), path.stat().st_mtime, half_size)
        if key in self._store:
            self._store.move_to_end(key)
            return self._store[key]
        arr = decode_linear(path, half_size=half_size)
        self._store[key] = arr
        while len(self._store) > self._max:
            self._store.popitem(last=False)
        return arr


_decode_cache = DecodeCache()


def preview_cache_key(path: Path, recipe: Recipe, size: int) -> str:
    raw = f"{path}|{path.stat().st_mtime}|{recipe.canonical_json()}|{size}"
    return hashlib.sha1(raw.encode()).hexdigest()


def render_preview(path: Path, recipe: Recipe, size: int, cache_dir: Path) -> bytes:
    """Rendered-with-recipe JPEG preview, disk-cached."""
    key = preview_cache_key(path, recipe, size)
    cached = cache_dir / f"{key}.jpg"
    if cached.exists():
        return cached.read_bytes()

    linear = _decode_cache.get(path, half_size=True)
    rgb = render(linear, recipe)
    im = Image.fromarray(rgb)
    im.thumbnail((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    data = buf.getvalue()
    cached.write_bytes(data)
    return data


def render_full(path: Path, recipe: Recipe) -> np.ndarray:
    """Full-resolution render for export (no disk cache)."""
    linear = decode_linear(path, half_size=False)
    return render(linear, recipe)
