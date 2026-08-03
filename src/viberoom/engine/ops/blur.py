"""Fast approximate gaussian blur: three chained box blurs via cumulative
sums. O(n) regardless of radius, so large-sigma ops (clarity, dehaze,
vignette-scale work) stay usable at full export resolution."""

from __future__ import annotations

import numpy as np

#: Ceiling on the float64 scratch one cumsum pass may hold at once. The
#: float64 accumulator is load-bearing — a float32 cumsum drifts badly once a
#: line is a few thousand samples long — but it does not have to span the
#: whole frame: every line accumulates independently, so slicing across the
#: other axis gives bit-identical results out of a cache-sized temporary
#: instead of a temporary twice the size of the image.
_CUMSUM_SCRATCH_BYTES = 16 << 20


def _box_blur_axis(
    img: np.ndarray, radius: int, axis: int, out: np.ndarray | None = None
) -> np.ndarray:
    """Box blur along one axis with edge clamping, via cumsum.

    `out` is written in place when given; it must not alias `img`.
    """
    n = img.shape[axis]
    if radius <= 0 or n <= 1:
        return img
    radius = min(radius, n - 1)
    denom = 2 * radius + 1
    pad = [(0, 0)] * img.ndim
    pad[axis] = (radius + 1, radius)

    if out is None:
        out = np.empty(img.shape, dtype=np.float32)

    # Plain slices of the cumsum, not np.take with an arange: fancy indexing
    # would materialise two more full float64 arrays where a view costs
    # nothing.
    hi = [slice(None)] * img.ndim
    lo = [slice(None)] * img.ndim
    hi[axis] = slice(denom, denom + n)
    lo[axis] = slice(0, n)
    hi, lo = tuple(hi), tuple(lo)

    split = next((a for a in range(img.ndim) if a != axis), None)
    if split is None:
        n_split, step = 1, 1
    else:
        n_split = img.shape[split]
        # csum plus the difference buffer, both float64, over the padded span
        f64_bytes = (img.size // n) * (n + denom) * 8 * 2
        step = max(1, min(n_split, _CUMSUM_SCRATCH_BYTES * n_split // max(f64_bytes, 1)))

    key = [slice(None)] * img.ndim
    for j in range(0, n_split, step):
        if split is not None:
            key[split] = slice(j, min(j + step, n_split))
        k = tuple(key)
        csum = np.cumsum(np.pad(img[k], pad, mode="edge"), axis=axis, dtype=np.float64)
        window = csum[hi] - csum[lo]
        window /= denom
        out[k] = window
    return out


def box_radius(sigma: float) -> int:
    """Radius of each of the three box passes `fast_blur` uses for `sigma`.

    Exposed so callers that need to know how far a blur reaches — e.g. how
    much context to keep around a cropped region — can ask rather than guess.
    """
    return max(1, int(round(sigma * np.sqrt(12 / 3 + 1) / 2 - 0.5)))


def fast_blur(img: np.ndarray, sigma: float) -> np.ndarray:
    """Approximate gaussian blur of an HxW or HxWxC float array."""
    if sigma <= 0:
        return img
    # three equal box passes approximate a gaussian; box radius from sigma
    radius = box_radius(sigma)
    src = img.astype(np.float32, copy=False)
    # Ping-pong between two scratch buffers rather than letting each of the six
    # passes allocate its own result; the input itself is never written to.
    scratch = [np.empty(src.shape, dtype=np.float32) for _ in range(2)]
    for i in range(6):
        dst = scratch[0] if scratch[0] is not src else scratch[1]
        src = _box_blur_axis(src, radius, i % 2, out=dst)
    return src
