"""Content-aware masks: subject / background / sky.

Backend ladder for subject: rembg (U2-Net, if the optional `ml` extra is
installed) -> spectral-residual saliency (pure numpy, always available).
Sky uses a color/position/smoothness heuristic that needs no model.
Background is 1 - subject. Weights are cached per (kind, image signature)
because segmentation is the slow part of a render."""

from __future__ import annotations

import hashlib

import numpy as np

from viberoom.engine.ops.blur import fast_blur

_cache: dict[tuple, np.ndarray] = {}
_CACHE_MAX = 8


def _signature(img: np.ndarray, kind: str) -> tuple:
    probe = (np.clip(img[::16, ::16], 0, 1) * 255).astype(np.uint8)
    return (kind, img.shape[:2], hashlib.sha1(probe.tobytes()).hexdigest()[:16])


def _rembg_subject(img: np.ndarray) -> np.ndarray | None:
    try:
        from rembg import remove
        from PIL import Image
    except ImportError:
        return None
    try:
        small_h = 512
        scale = max(1, img.shape[0] // small_h)
        small = (np.clip(img[::scale, ::scale], 0, 1) * 255).astype(np.uint8)
        result = remove(Image.fromarray(small))
        alpha = np.asarray(result.getchannel("A"), dtype=np.float32) / 255.0
        big = np.asarray(
            Image.fromarray((alpha * 255).astype(np.uint8)).resize(
                (img.shape[1], img.shape[0])
            ),
            dtype=np.float32,
        ) / 255.0
        return big
    except Exception:
        return None


def _saliency_subject(img: np.ndarray) -> np.ndarray:
    """Spectral-residual saliency (Hou & Zhang 2007): coarse but dependable
    subject-ish weighting with zero dependencies."""
    from PIL import Image

    luma = img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722
    small = np.asarray(
        Image.fromarray((np.clip(luma, 0, 1) * 255).astype(np.uint8)).resize((128, 128)),
        dtype=np.float32,
    ) / 255.0
    spectrum = np.fft.fft2(small)
    log_amp = np.log(np.abs(spectrum) + 1e-8)
    phase = np.angle(spectrum)
    residual = log_amp - fast_blur(log_amp, 1.0)
    sal = np.abs(np.fft.ifft2(np.exp(residual + 1j * phase))) ** 2
    sal = fast_blur(sal.astype(np.float32), 3.0)
    sal = (sal - sal.min()) / max(sal.max() - sal.min(), 1e-8)
    # gentle center prior: photos usually keep subjects off the edges
    yy, xx = np.mgrid[0:128, 0:128].astype(np.float32) / 127.0
    center = 1.0 - 0.5 * np.sqrt((yy - 0.5) ** 2 + (xx - 0.5) ** 2) * 2
    sal = np.clip(sal * center * 2.2, 0, 1)
    big = np.asarray(
        Image.fromarray((sal * 255).astype(np.uint8)).resize((img.shape[1], img.shape[0])),
        dtype=np.float32,
    ) / 255.0
    return big


def _sky_weight(img: np.ndarray) -> np.ndarray:
    """Sky heuristic: bright, low-texture, blue-leaning regions connected to
    the top of the frame."""
    x = np.clip(img, 0, 1)
    h, w = x.shape[:2]
    luma = x[..., 0] * 0.2126 + x[..., 1] * 0.7152 + x[..., 2] * 0.0722
    blueness = np.clip(x[..., 2] - (x[..., 0] + x[..., 1]) / 2 + 0.5, 0, 1)
    smooth = 1.0 - np.clip(np.abs(luma - fast_blur(luma, 2.0)) * 25, 0, 1)
    brightness = np.clip(luma * 1.4, 0, 1)
    score = np.clip(blueness * 0.5 + smooth * 0.3 + brightness * 0.4 - 0.35, 0, 1) * 2
    score = np.clip(score, 0, 1)

    # connectivity: sky must reach down from the top; walk rows, letting the
    # reachable mask shrink as scores drop
    reach = np.clip(score[0] * 1.5, 0, 1)
    weight = np.zeros_like(score)
    weight[0] = reach
    for row in range(1, h):
        spread = np.maximum(reach, np.maximum(np.roll(reach, 1), np.roll(reach, -1)))
        reach = np.minimum(spread, np.clip(score[row] * 1.5, 0, 1))
        weight[row] = reach
    return fast_blur(weight, max(2.0, min(h, w) / 200))


def ai_mask_weight(kind: str, img: np.ndarray) -> np.ndarray:
    key = _signature(img, kind)
    if key in _cache:
        return _cache[key]
    if kind == "sky":
        weight = _sky_weight(img)
    else:
        subject = _rembg_subject(img)
        if subject is None:
            subject = _saliency_subject(img)
        weight = subject if kind == "subject" else 1.0 - subject
    weight = weight.astype(np.float32)
    if len(_cache) >= _CACHE_MAX:
        _cache.pop(next(iter(_cache)))
    _cache[key] = weight
    return weight
