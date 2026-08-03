"""Manual lens corrections: geometric distortion, vignetting compensation,
lateral chromatic aberration, and defringe. Runs first in the pipeline on
linear data (remapping doesn't care about color state; vignetting gain is
physically a linear-light effect)."""

from __future__ import annotations

import numpy as np

from viberoom.recipe.schema import Lens

#: Scratch budget for one band of the remap/vignette pass, in bytes. The
#: coordinate math is float64 (see `_radial_grid`) and every intermediate is
#: frame-shaped, so at 6 MP the whole-frame form needs the better part of a
#: gigabyte of temporaries. Rows are independent, so banding is bit-identical
#: — it just reaches the same answer out of a cache-sized buffer.
_BAND_BYTES = 24 << 20

#: Bytes of scratch one band pixel costs at the peak: the float64 radius,
#: scale and two coordinate planes, plus the plan's four index and four
#: weight planes, the gather accumulators and the output.
_BAND_BYTES_PER_PX = 96


def _remap_bilinear(channel: np.ndarray, plan: tuple) -> np.ndarray:
    """Sample a 2-D channel at the coords of a `_plan`.

    The four corner gathers are accumulated one at a time rather than
    materialized together: each is a full band of float32, and holding all
    four plus the two interpolation halves was six live copies where three
    will do.
    """
    x0, y0, x1, y1, fx, fy, ifx, ify = plan

    top = channel[y0, x0]
    top *= ifx
    corner = channel[y0, x1]
    corner *= fx
    top += corner

    bot = channel[y1, x0]
    bot *= ifx
    corner = channel[y1, x1]
    corner *= fx
    bot += corner

    top *= ify
    bot *= fy
    top += bot
    return top


def _plan(cx: float, cy: float, dx: np.ndarray, dy: np.ndarray, scale, h: int, w: int):
    """Integer and fractional source coords for one sampling scale.

    Shared by every channel that samples at the same scale, which with CA off
    is all three of them — one plan for the band instead of three, and the
    per-corner weights come along rather than being rebuilt per channel.
    """
    x = np.clip(cx + dx * scale, 0, w - 1.001)
    y = np.clip(cy + dy * scale, 0, h - 1.001)
    x0 = x.astype(np.int32)
    y0 = y.astype(np.int32)
    fx = (x - x0).astype(np.float32)
    fy = (y - y0).astype(np.float32)
    return x0, y0, x0 + 1, y0 + 1, fx, fy, 1.0 - fx, 1.0 - fy


def _radial_grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray, float]:
    """Centered pixel coords and the corner radius they are normalized by.

    `dx` is a row and `dy` a column rather than two full frames: each varies
    along one axis only, so broadcasting reproduces the grid exactly and for
    free where materializing it costs two frames per call.
    """
    cy, cx = (h - 1) / 2, (w - 1) / 2
    dx = np.arange(w, dtype=np.float32) - cx
    dy = np.arange(h, dtype=np.float32) - cy
    # A plain float, not the np.float64 that np.sqrt hands back: under NEP 50 a
    # numpy scalar promotes whatever it touches, so dividing by that one would
    # widen the radius, then the vignette gain, then the frame — and every
    # frame after it, for the rest of the pipeline.
    return dx, dy, float(np.sqrt(cx * cx + cy * cy))


def apply_lens(img: np.ndarray, lens: Lens) -> np.ndarray:
    if lens == Lens():
        return img
    out = img
    h, w = out.shape[:2]
    cy, cx = (h - 1) / 2, (w - 1) / 2

    needs_remap = bool(lens.distortion or lens.caRed or lens.caBlue)
    if needs_remap or lens.vignette:
        dx, dy, norm = _radial_grid(h, w)
        dx2 = dx * dx
        # distortion: sample source at r*(1 + k r^2); positive k pulls edges
        # outward in the source = corrects barrel in the output
        k = lens.distortion / 100 * 0.15
        vig = lens.vignette / 100 * 0.8
        # Channels sharing a CA setting share their sampling plan; the green
        # channel is never shifted, so CA off collapses to a single plan.
        groups: dict[float, list[int]] = {}
        for i, ca in ((0, lens.caRed), (1, 0.0), (2, lens.caBlue)):
            groups.setdefault(float(ca), []).append(i)

        # float32 is the pipeline's declared working precision, and staying in
        # it matters twice over: a float64 frame doubles memory, and it also
        # fails pipeline._owned(), which silently disables in-place reuse for
        # every op downstream of a vignette.
        out = np.empty((h, w, 3), dtype=np.float32)
        rows = max(1, _BAND_BYTES // (w * _BAND_BYTES_PER_PX))
        for a in range(0, h, rows):
            b = min(a + rows, h)
            dyb = dy[a:b, None]
            r = np.sqrt(dx2 + dyb * dyb) / norm
            band = out[a:b]

            if needs_remap:
                base = 1.0 + k * r * r if k else 1.0
                for ca, chans in groups.items():
                    scale = base * (1.0 + ca / 100 * 0.001)
                    if np.isscalar(scale) and scale == 1.0:
                        for i in chans:
                            band[..., i] = img[a:b, :, i]
                        continue
                    plan = _plan(cx, cy, dx, dyb, scale, h, w)
                    for i in chans:
                        band[..., i] = _remap_bilinear(img[..., i], plan)
            else:
                band[...] = img[a:b]

            if lens.vignette:
                r *= r
                r *= vig
                r += 1.0
                band *= r[..., None]

    if lens.defringe.amount:
        out = _defringe(out, lens.defringe.amount)

    if out is img:  # defringe-only recipe: never write into the caller's array
        return np.clip(out, 0, None)
    return np.clip(out, 0, None, out=out)


def _defringe(img: np.ndarray, amount: float) -> np.ndarray:
    """Desaturate purple/green pixels near strong luminance edges, where
    lateral CA fringes live."""
    from viberoom.engine.ops.blur import fast_blur

    luma = img[..., 0] * 0.2126
    luma += img[..., 1] * 0.7152
    luma += img[..., 2] * 0.0722
    gy, gx = np.gradient(luma)
    gx *= gx
    gy *= gy
    gx += gy
    del gy
    edge = np.sqrt(gx, out=gx)
    # np.percentile has to partition a copy of the whole frame; a subsample
    # would be cheaper but would pick a different threshold, so it stays.
    scale = max(float(np.percentile(edge, 99)), 1e-6)
    # dilate so the mask covers the fringe band beside the edge, not just
    # the single high-gradient line
    edge /= scale * 0.5
    np.clip(edge, 0, 1, out=edge)
    edge_w = fast_blur(edge, 1.5)
    edge_w = np.multiply(edge_w, 2, out=edge_w if edge_w is not edge else None)
    np.clip(edge_w, 0, 1, out=edge_w)

    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    # Pairwise, not a reduction over the length-3 last axis: that axis is the
    # fastest-varying one and reducing along it defeats numpy's inner loop.
    mx = np.maximum(np.maximum(r, g), b)
    np.maximum(mx, 1e-6, out=mx)
    # purple fringe: red+blue high vs green; green fringe: the opposite
    fringe = np.minimum(r, b)
    fringe -= g
    fringe /= mx
    np.clip(fringe, 0, 1, out=fringe)
    green = np.maximum(r, b)
    np.subtract(g, green, out=green)
    green /= mx
    np.clip(green, 0, 1, out=green)
    del mx

    fringe += green
    del green
    fringe *= 3
    np.clip(fringe, 0, 1, out=fringe)
    fringe *= edge_w
    fringe *= amount / 100

    # Band the composite: whole-frame, the desaturated copy and the weighted
    # original are both live alongside the input and the result, which is four
    # frames for what is a per-pixel blend.
    h, w = img.shape[:2]
    out = np.empty_like(img)
    rows = max(1, _BAND_BYTES // (w * 24))
    for a in range(0, h, rows):
        b = min(a + rows, h)
        src, gray, fw = img[a:b], luma[a:b, :, None], fringe[a:b, :, None]
        desat = src - gray
        desat *= 0.2
        desat += gray
        desat *= fw
        np.multiply(src, 1.0 - fw, out=out[a:b])
        out[a:b] += desat
    return out
