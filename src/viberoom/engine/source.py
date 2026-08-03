"""Source frames for the client-side (GPU) preview.

The browser renders the pointwise part of the pipeline itself so that dragging
a slider is not a server round-trip. For that it needs the *decoded linear*
frame — the very array `render_preview` hands to `render()` — with its
highlight headroom intact.

PNG is not an option. Browsers decode PNG through ImageBitmap/drawImage, which
truncates every channel to 8 bits, and there is no way to get a 16-bit PNG's
samples into a WebGL texture without shipping a decoder. So the wire format is
raw texture bytes in one of the two layouts WebGL2 uploads directly:
RGB9_E5 (4 bytes/px, the default) and RGBA16F (8 bytes/px, the fallback).

The frame is produced at exactly the resolution `render_preview` renders at,
not at the resolution of the JPEG it finally emits. Anything else and the
client's frame and the server's frame are different images, so the swap from
the GPU preview to the settled server render would visibly jump.
"""

from __future__ import annotations

import hashlib
import struct
from pathlib import Path

import numpy as np

from viberoom.engine.cache import (
    PIPELINE_VERSION,
    _decode_cache,
    _downscale_linear,
    _preview_scale,
)
from viberoom.recipe.schema import Recipe

#: Wire formats the client may ask for. RGB9_E5 halves the payload and is
#: enough for a preview; RGBA16F exists for drivers that mishandle the packed
#: format, which is not hypothetical on older mobile GL.
SOURCE_FORMATS = ("rgb9e5", "rgba16f")

# GL_UNSIGNED_INT_5_9_9_9_REV: three 9-bit mantissas sharing one 5-bit
# exponent, biased by 15. Largest representable value is (2^9-1)/2^9 * 2^16.
_MANTISSA_BITS = 9
_EXP_BIAS = 15
_MAX_EXP = 31
_RGB9E5_MAX = 65408.0

#: float16 saturates here; beyond it the cast produces inf, which a shader
#: then propagates through every later op as NaN.
_F16_MAX = 65504.0

#: The cache file carries its own dimensions so a warm hit does not have to
#: decode the image again just to answer "how big is it".
_HEADER = struct.Struct("<II")


def encode_rgb9e5(arr: np.ndarray) -> bytes:
    """Pack float RGB into GL_UNSIGNED_INT_5_9_9_9_REV, 4 bytes per pixel.

    The shared exponent is why this format is here at all: it keeps relative
    precision across the whole frame, so linear values well above 1.0 — the
    highlight headroom a RAW decode carries — survive the trip, which no
    8-bit-per-channel transport can offer.
    """
    x = np.nan_to_num(np.asarray(arr, dtype=np.float32)[..., :3], nan=0.0)
    x = np.clip(x, 0.0, _RGB9E5_MAX)
    maxc = x.max(axis=-1)

    # exponent = floor(log2(max)) + 1 + bias. The all-zero pixel has no
    # logarithm, so it is substituted out and lands on a zero mantissa anyway.
    exp = np.floor(np.log2(np.where(maxc > 0, maxc, 1.0)))
    exp = np.maximum(exp, -_EXP_BIAS - 1) + 1 + _EXP_BIAS

    # Rounding the shared maximum can carry out of nine bits (511.5 -> 512);
    # the spec's remedy is to bump the exponent and quantize again.
    quantum = np.exp2(exp - _EXP_BIAS - _MANTISSA_BITS)
    exp = np.where(np.floor(maxc / quantum + 0.5) >= 512, exp + 1, exp)
    exp = np.clip(exp, 0, _MAX_EXP)

    quantum = np.exp2(exp - _EXP_BIAS - _MANTISSA_BITS)[..., None]
    m = np.clip(np.floor(x / quantum + 0.5), 0, 511).astype(np.uint32)

    packed = (
        m[..., 0]
        | (m[..., 1] << _MANTISSA_BITS)
        | (m[..., 2] << (2 * _MANTISSA_BITS))
        | (exp.astype(np.uint32) << (3 * _MANTISSA_BITS))
    )
    return packed.astype("<u4").tobytes()


def encode_rgba16f(arr: np.ndarray) -> bytes:
    """Half-float RGBA, 8 bytes per pixel, alpha pinned to 1.0."""
    x = np.clip(np.nan_to_num(np.asarray(arr, dtype=np.float32)[..., :3], nan=0.0), 0.0, _F16_MAX)
    out = np.empty(x.shape[:2] + (4,), dtype="<f2")
    out[..., :3] = x
    out[..., 3] = 1.0
    return out.tobytes()


def source_cache_key(path: Path, size: int, fmt: str) -> str:
    # PIPELINE_VERSION is in here because the *resolution* this frame is cut
    # to is a pipeline decision (`_preview_scale`), not just a decode one.
    raw = f"src-v{PIPELINE_VERSION}|{path}|{path.stat().st_mtime_ns}|{size}|{fmt}"
    return hashlib.sha1(raw.encode()).hexdigest()


def cached_source_dims(
    path: Path, size: int, fmt: str, cache_dir: Path
) -> tuple[int, int] | None:
    """Dimensions of an already-encoded frame, or None if it isn't cached.

    Lets a conditional request be answered with the full set of X-Source-*
    headers without paying for a decode.
    """
    cached = cache_dir / f"{source_cache_key(path, size, fmt)}.src"
    if not cached.exists():
        return None
    with cached.open("rb") as fh:
        head = fh.read(_HEADER.size)
    if len(head) < _HEADER.size:
        return None
    w, h = _HEADER.unpack(head)
    return w, h


def source_bytes(path: Path, size: int, fmt: str, cache_dir: Path) -> tuple[bytes, int, int]:
    """Encoded linear frame plus the dimensions it was encoded at, disk-cached."""
    if fmt not in SOURCE_FORMATS:
        raise ValueError(f"unknown source format {fmt!r}")

    cached = cache_dir / f"{source_cache_key(path, size, fmt)}.src"
    if cached.exists():
        blob = cached.read_bytes()
        w, h = _HEADER.unpack_from(blob)
        return blob[_HEADER.size :], w, h

    linear = _decode_cache.get(path, half_size=True)
    # A default recipe, deliberately: the client renderer only ever handles
    # recipes with no crop, so the scale it needs is the uncropped one — and
    # keying the cache on the recipe would defeat the whole point of a frame
    # that outlives every slider move.
    frame = _downscale_linear(linear, _preview_scale(linear, Recipe(), size))
    data = encode_rgb9e5(frame) if fmt == "rgb9e5" else encode_rgba16f(frame)

    h, w = frame.shape[:2]
    cached.write_bytes(_HEADER.pack(w, h) + data)
    return data, w, h
