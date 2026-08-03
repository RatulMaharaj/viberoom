"""Caching: disk cache for rendered previews, in-memory LRU for decoded
linear arrays (decode is the expensive step when iterating on a recipe)."""

from __future__ import annotations

import hashlib
import io
import os
from collections import OrderedDict
from pathlib import Path

import numpy as np
from PIL import Image

from viberoom.engine.decode import decode_linear
from viberoom.engine.pipeline import render
from viberoom.recipe.schema import Recipe


#: How much decoded imagery to keep resident, in MB. A half-size decode of a
#: 24 MP RAW is ~70 MB, so the default holds a filmstrip's worth; full-size
#: decodes are ~290 MB and a couple will fit. Override for small machines.
DECODE_CACHE_MB = int(os.environ.get("VIBEROOM_DECODE_CACHE_MB", "1024"))


class DecodeCache:
    """LRU of decoded linear ndarrays, bounded by total bytes.

    Bounding by *entry count* was the original design and it made browsing
    pathological: two entries meant a third image evicted the first, so paging
    back and forth through a filmstrip re-ran LibRaw every single time. Sizes
    here vary by two orders of magnitude between a half-size JPEG and a
    full-size RAW, so bytes are the only budget that means anything.
    """

    def __init__(self, max_bytes: int | None = None):
        self._max_bytes = max_bytes if max_bytes is not None else DECODE_CACHE_MB * 1024 * 1024
        self._store: OrderedDict[tuple, np.ndarray] = OrderedDict()
        self._bytes = 0

    def _key(self, path: Path, half_size: bool) -> tuple:
        # st_mtime_ns rather than st_mtime: the float loses sub-microsecond
        # resolution, so a file rewritten twice inside one tick can collide.
        return (str(path), path.stat().st_mtime_ns, half_size)

    def get(self, path: Path, half_size: bool) -> np.ndarray:
        key = self._key(path, half_size)
        if key in self._store:
            self._store.move_to_end(key)
            return self._store[key]

        arr = decode_linear(path, half_size=half_size)
        self.put(key, arr)
        return arr

    def put(self, key: tuple, arr: np.ndarray) -> None:
        # Entries are handed out by reference, so an in-place op anywhere in
        # the pipeline would silently poison every later render of the same
        # file. Making them read-only turns that from a corrupted image into
        # an immediate ValueError at the offending line.
        arr.flags.writeable = False
        if key in self._store:
            self._bytes -= self._store.pop(key).nbytes
        self._store[key] = arr
        self._bytes += arr.nbytes
        # Always keep the entry just inserted, even if it alone busts the
        # budget — evicting it would mean decoding it again immediately.
        while self._bytes > self._max_bytes and len(self._store) > 1:
            self._bytes -= self._store.popitem(last=False)[1].nbytes

    def clear(self) -> None:
        self._store.clear()
        self._bytes = 0

    @property
    def resident_mb(self) -> float:
        return self._bytes / (1024 * 1024)


_decode_cache = DecodeCache()


# bump when pipeline math changes so cached previews re-render
# 4: previews render at preview resolution rather than decode resolution
PIPELINE_VERSION = 4


def preview_cache_key(path: Path, recipe: Recipe, size: int) -> str:
    raw = f"v{PIPELINE_VERSION}|{path}|{path.stat().st_mtime}|{recipe.canonical_json()}|{size}"
    return hashlib.sha1(raw.encode()).hexdigest()


#: Extra input resolution kept beyond what the output strictly needs, so that
#: rotation and perspective have real pixels to resample from at the edges
#: instead of inventing them.
_RESAMPLE_MARGIN = 1.15


def _preview_scale(linear: np.ndarray, recipe: Recipe, size: int) -> float:
    """How much to shrink the decoded frame before rendering it.

    A crop is the reason this is not simply `size / long_edge`: cropping to a
    quarter of the frame means the surviving quarter has to carry the whole
    output, so four times the input is needed to hold detail.

    Returns 1.0 when the frame is already small enough — never upscales.
    """
    crop = recipe.geometry.crop
    kept = min(max(crop.right - crop.left, 1e-3), 1.0), min(
        max(crop.bottom - crop.top, 1e-3), 1.0
    )
    needed = size / min(kept) * _RESAMPLE_MARGIN
    return min(1.0, needed / max(linear.shape[0], linear.shape[1]))


def _downscale_linear(linear: np.ndarray, scale: float) -> np.ndarray:
    """Shrink a linear float32 image, resampling per channel with Lanczos.

    Done in linear light, which is where averaging pixels is physically
    meaningful — the same reduction applied after the sRGB transfer curve
    would darken every gradient.
    """
    h, w = linear.shape[:2]
    th, tw = max(1, round(h * scale)), max(1, round(w * scale))
    if (th, tw) == (h, w):
        return linear

    # PIL's float mode is single-channel, so the channels go one at a time.
    out = np.empty((th, tw, linear.shape[2]), dtype=np.float32)
    for c in range(linear.shape[2]):
        plane = Image.fromarray(np.ascontiguousarray(linear[..., c]), mode="F")
        # reducing_gap lets PIL box-reduce most of the way before the Lanczos
        # pass, which is where nearly all of this function's time went.
        out[..., c] = np.asarray(
            plane.resize((tw, th), Image.LANCZOS, reducing_gap=3.0), dtype=np.float32
        )
    # Lanczos overshoots at hard edges; negative light is not a thing.
    return np.clip(out, 0, None, out=out)


def render_preview(path: Path, recipe: Recipe, size: int, cache_dir: Path) -> bytes:
    """Rendered-with-recipe JPEG preview, disk-cached."""
    key = preview_cache_key(path, recipe, size)
    cached = cache_dir / f"{key}.jpg"
    if cached.exists():
        return cached.read_bytes()

    linear = _decode_cache.get(path, half_size=True)

    # Render at roughly the size actually being asked for. This used to run
    # the whole pipeline at decode resolution and shrink the result at the
    # very end, which meant a 400 px grid thumbnail cost exactly as much as a
    # 1600 px loupe view — the expensive part being every op in between.
    scale = _preview_scale(linear, recipe, size)
    rgb = render(_downscale_linear(linear, scale), recipe, scale)

    im = Image.fromarray(rgb)
    im.thumbnail((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    data = buf.getvalue()
    cached.write_bytes(data)
    return data


def render_full(path: Path, recipe: Recipe) -> np.ndarray:
    """Full-resolution render for export (no disk cache).

    Goes through the decode cache: exporting several variants or formats of
    one image used to re-run LibRaw for each, which is by far the most
    expensive step. Safe now that the cache is bounded by bytes rather than
    entries — a ~290 MB full decode can be admitted and evicted sensibly.
    """
    linear = _decode_cache.get(path, half_size=False)
    return render(linear, recipe)


def render_full_float(path: Path, recipe: Recipe) -> np.ndarray:
    """Full-resolution float [0,1] render for high-bit-depth export."""
    from viberoom.engine.pipeline import render_float

    linear = _decode_cache.get(path, half_size=False)
    return render_float(linear, recipe)
