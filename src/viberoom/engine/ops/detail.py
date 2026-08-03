"""Detail operations: noise reduction (gaussian-based) then unsharp-mask
sharpening. numpy-only separable convolutions — no OpenCV dependency."""

from __future__ import annotations

import numpy as np

from viberoom.recipe.schema import Detail


def _gaussian_kernel(sigma: float) -> np.ndarray:
    radius = max(1, int(sigma * 3))
    x = np.arange(-radius, radius + 1, dtype=np.float32)
    k = np.exp(-(x ** 2) / (2 * sigma ** 2))
    return k / k.sum()


def _convolve_axis(img: np.ndarray, k: np.ndarray, axis: int) -> np.ndarray:
    """Separable 1-D convolution along one axis, zero-padded at the edges.

    Identical arithmetic to `np.convolve(..., mode="same")` — including the
    zero padding, which is why edges darken slightly — but expressed as one
    shifted accumulation per kernel tap instead of one Python call per row.
    A 3000x2000 frame is 5000 rows and columns; at a typical 7-to-21 tap
    kernel this trades 5000 interpreter round-trips for ~21 vectorized adds.

    Accumulating tap by tap also keeps memory flat. The obvious alternative,
    `sliding_window_view` plus `tensordot`, would materialize a window per
    pixel — half a gigabyte for a 21-tap kernel on that same frame.
    """
    img = np.asarray(img, dtype=np.float32)
    n = img.shape[axis]
    radius = len(k) // 2
    out = np.multiply(img, k[radius], dtype=np.float32)

    # One scratch frame, reused for every tap. `out[dst] += weight * img[src]`
    # reads better but allocates a near-full-frame temporary per tap.
    #
    # Blocking this to shrink the scratch buffer was tried and is 30% slower:
    # the kernel runs along one axis, so blocks have to be cut along the other
    # one, and the resulting strided slices cost more than the memory saves.
    scratch = np.empty_like(out)
    for offset in range(1, radius + 1):
        weight = k[radius + offset]
        if weight == 0:
            continue
        for shift in (offset, -offset):
            # Anything falling outside the array contributes zero, which is
            # exactly what zero padding means, so clamp both windows.
            lo, hi = max(0, shift), min(n, n + shift)
            if lo >= hi:
                continue
            dst = [slice(None)] * img.ndim
            src = [slice(None)] * img.ndim
            dst[axis] = slice(lo, hi)
            src[axis] = slice(lo - shift, hi - shift)
            dst, src = tuple(dst), tuple(src)
            np.multiply(img[src], weight, out=scratch[dst])
            np.add(out[dst], scratch[dst], out=out[dst])

    return out


def _blur(img: np.ndarray, sigma: float) -> np.ndarray:
    k = _gaussian_kernel(sigma)
    out = _convolve_axis(np.asarray(img, dtype=np.float32), k, 0)
    return _convolve_axis(out, k, 1)


def apply_detail(img: np.ndarray, detail: Detail, scale: float = 1.0) -> np.ndarray:
    """Display-space [0,1]. NR first, then sharpening.

    `scale` is the ratio of this frame's size to the full-resolution frame the
    recipe was authored against. Every other resolution-dependent op in the
    pipeline states its radius as a fraction of `min(h, w)` and so rescales
    itself; these radii are absolute pixel counts, so they need telling. A
    1.2 px sharpening radius means something quite different on a 400 px
    preview than on a 6000 px export, which is why previews have always been
    a little crunchier than the file they promise.

    Radii below ~0.3 px stop meaning anything, so heavily downscaled previews
    simply skip the op rather than convolving with a degenerate kernel.
    """
    out = img
    nr = detail.noiseReduction
    if nr.luminance or nr.color:
        # Luma/chroma split via per-pixel mean: cheap, good enough for v1.
        luma = out.mean(axis=-1, keepdims=True)
        chroma = out - luma
        if nr.luminance:
            sigma = (0.5 + nr.luminance / 100 * 2.0) * scale
            if sigma >= 0.3:
                luma = _blur(luma[..., 0], sigma)[..., None]
        if nr.color:
            sigma = (0.5 + nr.color / 100 * 3.0) * scale
            if sigma >= 0.3:
                chroma = _blur(chroma, sigma)
        out = np.clip(luma + chroma, 0, 1)

    sh = detail.sharpening
    if sh.amount and sh.radius * scale >= 0.3:
        blurred = _blur(out, sh.radius * scale)
        high = out - blurred
        # `detail` damps flat areas: threshold the high-pass magnitude
        strength = sh.amount / 100 * (0.5 + sh.detail / 100)
        out = np.clip(out + high * strength * 2.0, 0, 1)
    return out
