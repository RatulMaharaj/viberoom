"""Heal/clone spot removal. Runs after geometry (post-crop coordinates,
matching what an agent sees in a preview), before local masks.

Clone copies the source patch verbatim under a feathered circular alpha.
Heal keeps the source's texture (high frequency) but re-lights it with the
destination's illumination (low frequency) — a pragmatic Lightroom-like
heal, not full Poisson blending."""

from __future__ import annotations

import numpy as np

from viberoom.engine.ops.blur import fast_blur
from viberoom.recipe.schema import RetouchSpot


def _feathered_disc(size: int, radius: float, feather: float) -> np.ndarray:
    """(size x size) alpha disc centered in the patch."""
    c = (size - 1) / 2
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    d = np.sqrt((xx - c) ** 2 + (yy - c) ** 2)
    hard = radius * (1.0 - feather / 100)
    t = np.clip((d - hard) / max(radius - hard, 0.5), 0, 1)
    return (1.0 - t * t * (3 - 2 * t)).astype(np.float32)


def _clamped_patch(center_x: float, center_y: float, half: int, h: int, w: int):
    """Integer patch bounds around a center, clamped to the image; returns
    (y0, y1, x0, x1) or None if fully outside."""
    cx, cy = int(round(center_x)), int(round(center_y))
    y0, y1 = cy - half, cy + half + 1
    x0, x1 = cx - half, cx + half + 1
    if y1 <= 0 or x1 <= 0 or y0 >= h or x0 >= w:
        return None
    return y0, y1, x0, x1


def apply_retouch(img: np.ndarray, spots: list[RetouchSpot]) -> np.ndarray:
    if not spots:
        return img
    out = np.clip(img, 0, 1).copy()
    h, w = out.shape[:2]
    for spot in spots:
        r_px = spot.radius * min(h, w)
        half = max(2, int(np.ceil(r_px)))
        size = 2 * half + 1
        src_b = _clamped_patch(spot.source[0] * w, spot.source[1] * h, half, h, w)
        dst_b = _clamped_patch(spot.dest[0] * w, spot.dest[1] * h, half, h, w)
        if src_b is None or dst_b is None:
            continue
        # use the intersection of in-bounds offsets so src and dst stay aligned
        sy0, sy1, sx0, sx1 = src_b
        dy0, dy1, dx0, dx1 = dst_b
        # offsets into the (size x size) patch that are valid for BOTH patches
        top = max(-sy0, -dy0, 0)
        bottom = size - max(sy1 - h, dy1 - h, 0)
        left = max(-sx0, -dx0, 0)
        right = size - max(sx1 - w, dx1 - w, 0)
        if bottom <= top or right <= left:
            continue

        def crop(y0, x0):
            return out[y0 + top:y0 + bottom, x0 + left:x0 + right]

        src = crop(sy0, sx0).copy()
        dst = crop(dy0, dx0)
        alpha = _feathered_disc(size, r_px, spot.feather)[top:bottom, left:right, None]
        alpha = alpha * (spot.opacity / 100)

        if spot.mode == "heal":
            # match illumination using the patch border ring — the ring sits
            # outside the blemish, so the blemish itself can't bias the match
            ph, pw = dst.shape[:2]
            ring = max(2, min(ph, pw) // 6)
            mask2d = np.zeros((ph, pw), dtype=bool)
            mask2d[:ring] = mask2d[-ring:] = True
            mask2d[:, :ring] = mask2d[:, -ring:] = True
            offset = dst[mask2d].mean(axis=0) - src[mask2d].mean(axis=0)
            patch = src + offset
        else:
            patch = src
        blended = dst * (1 - alpha) + np.clip(patch, 0, 1) * alpha
        out[dy0 + top:dy0 + bottom, dx0 + left:dx0 + right] = blended
    return out
