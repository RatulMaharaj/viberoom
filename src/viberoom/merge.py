"""Multi-image merge: HDR exposure fusion and simple panorama stitching.

HDR uses Mertens-style exposure fusion (contrast x saturation x
well-exposedness weights, heavily smoothed) after translation alignment by
FFT phase correlation — no radiance map or tone mapping step needed.

Panorama is translation-only: pairwise phase-correlation offsets with
feathered blending. Great for tripod pans, honest-best-effort handheld.

Both write a 16-bit PNG into the library so the result becomes a normal
image with its own recipe."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from viberoom.engine.decode import decode_linear, linear_to_srgb
from viberoom.engine.ops.blur import fast_blur


def _luma(img: np.ndarray) -> np.ndarray:
    return img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722


def _phase_offset(a: np.ndarray, b: np.ndarray) -> tuple[int, int]:
    """(dy, dx) shift that aligns b onto a, via phase correlation."""
    fa = np.fft.rfft2(a - a.mean())
    fb = np.fft.rfft2(b - b.mean())
    cross = fa * np.conj(fb)
    cross /= np.maximum(np.abs(cross), 1e-12)
    corr = np.fft.irfft2(cross, s=a.shape)
    peak = np.unravel_index(np.argmax(corr), corr.shape)
    dy, dx = int(peak[0]), int(peak[1])
    if dy > a.shape[0] // 2:
        dy -= a.shape[0]
    if dx > a.shape[1] // 2:
        dx -= a.shape[1]
    return dy, dx


def _shift(img: np.ndarray, dy: int, dx: int) -> np.ndarray:
    out = np.roll(img, (dy, dx), axis=(0, 1))
    return out


def _load_display(path: Path, half_size: bool = True) -> np.ndarray:
    return np.clip(linear_to_srgb(decode_linear(path, half_size=half_size)), 0, 1)


def merge_hdr(paths: list[Path], half_size: bool = False) -> np.ndarray:
    """Exposure-fuse aligned frames. Returns float [0,1] HxWx3."""
    imgs = [_load_display(p, half_size=half_size) for p in paths]
    h = min(i.shape[0] for i in imgs)
    w = min(i.shape[1] for i in imgs)
    imgs = [i[:h, :w] for i in imgs]

    ref_luma = _luma(imgs[len(imgs) // 2])
    aligned = []
    for img in imgs:
        dy, dx = _phase_offset(ref_luma, _luma(img))
        aligned.append(_shift(img, dy, dx))

    weights = []
    for img in aligned:
        luma = _luma(img)
        gy, gx = np.gradient(luma)
        contrast = np.abs(gx) + np.abs(gy)
        saturation = img.std(axis=-1)
        well_exposed = np.exp(-((luma - 0.5) ** 2) / (2 * 0.2 ** 2))
        w_map = (contrast + 1e-4) * (saturation + 1e-4) * (well_exposed + 1e-4)
        weights.append(w_map)

    total = np.sum(weights, axis=0)
    sigma = max(4.0, min(h, w) * 0.01)
    fused = np.zeros_like(aligned[0])
    norm = np.zeros((h, w), dtype=np.float32)
    for img, w_map in zip(aligned, weights):
        smooth = fast_blur((w_map / np.maximum(total, 1e-8)).astype(np.float32), sigma)
        fused += img * smooth[..., None]
        norm += smooth
    return np.clip(fused / np.maximum(norm, 1e-8)[..., None], 0, 1)


def merge_pano(paths: list[Path], half_size: bool = False) -> np.ndarray:
    """Left-to-right translation stitch with feathered overlap blending."""
    imgs = [_load_display(p, half_size=half_size) for p in paths]
    h = min(i.shape[0] for i in imgs)
    imgs = [i[:h] for i in imgs]

    # pairwise offsets on padded same-size lumas
    offsets = [(0, 0)]
    for a, b in zip(imgs, imgs[1:]):
        w = min(a.shape[1], b.shape[1])
        dy, dx = _phase_offset(_luma(a[:, -w:]), _luma(b[:, :w]))
        # b sits to the right of a: correlation gives the overlap shift
        dx_total = a.shape[1] - w + (dx % w if dx > 0 else dx + w)
        offsets.append((dy, dx_total))

    # absolute placements
    abs_pos = [(0, 0)]
    for dy, dx in offsets[1:]:
        py, px = abs_pos[-1]
        abs_pos.append((py + dy, px + dx))

    min_y = min(p[0] for p in abs_pos)
    abs_pos = [(p[0] - min_y, p[1]) for p in abs_pos]
    out_h = h + max(p[0] for p in abs_pos)
    out_w = max(p[1] + img.shape[1] for p, img in zip(abs_pos, imgs))

    canvas = np.zeros((out_h, out_w, 3), dtype=np.float32)
    weight = np.zeros((out_h, out_w), dtype=np.float32)
    for (py, px), img in zip(abs_pos, imgs):
        ih, iw = img.shape[:2]
        # feather: ramp at the left/right edges
        ramp = np.minimum(np.linspace(0, 1, iw) * 8, np.linspace(1, 0, iw) * 8)
        w_map = np.clip(ramp, 0.05, 1.0)[None, :].repeat(ih, axis=0)
        canvas[py:py + ih, px:px + iw] += img * w_map[..., None]
        weight[py:py + ih, px:px + iw] += w_map
    merged = canvas / np.maximum(weight, 1e-8)[..., None]

    # crop rows that not every column covers (top/bottom drift bands)
    covered = weight > 1e-6
    good_rows = covered.all(axis=1)
    if good_rows.any():
        merged = merged[good_rows]
    return np.clip(merged, 0, 1)
