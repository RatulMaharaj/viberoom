"""Manual lens corrections: geometric distortion, vignetting compensation,
lateral chromatic aberration, and defringe. Runs first in the pipeline on
linear data (remapping doesn't care about color state; vignetting gain is
physically a linear-light effect)."""

from __future__ import annotations

import numpy as np

from viberoom.recipe.schema import Lens


def _remap_bilinear(channel: np.ndarray, src_x: np.ndarray, src_y: np.ndarray) -> np.ndarray:
    """Sample a 2-D channel at fractional coords (clamped to edges)."""
    h, w = channel.shape
    x = np.clip(src_x, 0, w - 1.001)
    y = np.clip(src_y, 0, h - 1.001)
    x0 = x.astype(np.int32)
    y0 = y.astype(np.int32)
    fx = (x - x0).astype(np.float32)
    fy = (y - y0).astype(np.float32)
    c00 = channel[y0, x0]
    c01 = channel[y0, x0 + 1]
    c10 = channel[y0 + 1, x0]
    c11 = channel[y0 + 1, x0 + 1]
    top = c00 * (1 - fx) + c01 * fx
    bot = c10 * (1 - fx) + c11 * fx
    return (top * (1 - fy) + bot * fy).astype(np.float32)


def _radial_grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Centered pixel coords (dx, dy) and radius normalized so the corner ~ 1."""
    cy, cx = (h - 1) / 2, (w - 1) / 2
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dx, dy = xx - cx, yy - cy
    r = np.sqrt(dx * dx + dy * dy) / np.sqrt(cx * cx + cy * cy)
    return dx, dy, r


def apply_lens(img: np.ndarray, lens: Lens) -> np.ndarray:
    if lens == Lens():
        return img
    out = img
    h, w = out.shape[:2]
    cy, cx = (h - 1) / 2, (w - 1) / 2

    needs_remap = lens.distortion or lens.caRed or lens.caBlue
    if needs_remap:
        dx, dy, r = _radial_grid(h, w)
        # distortion: sample source at r*(1 + k r^2); positive k pulls edges
        # outward in the source = corrects barrel in the output
        k = lens.distortion / 100 * 0.15
        base = 1.0 + k * r * r if k else 1.0
        channels = []
        for i, ca in ((0, lens.caRed), (1, 0.0), (2, lens.caBlue)):
            scale = base * (1.0 + ca / 100 * 0.001)
            if np.isscalar(scale) and scale == 1.0:
                channels.append(out[..., i])
                continue
            src_x = cx + dx * scale
            src_y = cy + dy * scale
            channels.append(_remap_bilinear(out[..., i], src_x, src_y))
        out = np.stack(channels, axis=-1)

    if lens.vignette:
        _, _, r = _radial_grid(h, w)
        out = out * (1.0 + lens.vignette / 100 * 0.8 * (r * r))[..., None]

    if lens.defringe.amount:
        out = _defringe(out, lens.defringe.amount)

    return np.clip(out, 0, None)


def _defringe(img: np.ndarray, amount: float) -> np.ndarray:
    """Desaturate purple/green pixels near strong luminance edges, where
    lateral CA fringes live."""
    from viberoom.engine.ops.blur import fast_blur

    luma = img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722
    gy, gx = np.gradient(luma)
    edge = np.sqrt(gx * gx + gy * gy)
    scale = max(float(np.percentile(edge, 99)), 1e-6)
    # dilate so the mask covers the fringe band beside the edge, not just
    # the single high-gradient line
    edge_w = np.clip(fast_blur(np.clip(edge / (scale * 0.5), 0, 1), 1.5) * 2, 0, 1)

    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    mx = np.maximum(img.max(axis=-1), 1e-6)
    # purple fringe: red+blue high vs green; green fringe: the opposite
    purple = np.clip((np.minimum(r, b) - g) / mx, 0, 1)
    green = np.clip((g - np.maximum(r, b)) / mx, 0, 1)
    fringe_w = np.clip((purple + green) * 3, 0, 1) * edge_w * (amount / 100)

    gray = luma[..., None]
    return img * (1 - fringe_w[..., None]) + (gray + (img - gray) * 0.2) * fringe_w[..., None]
