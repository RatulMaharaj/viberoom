"""Image decoding: RAW via rawpy (LibRaw), everything else via Pillow.

Output is always float32 linear RGB in [0, 1] so the pipeline has one
contract regardless of source format.
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import rawpy
from PIL import Image, ImageOps

from viberoom.config import is_raw

_SRGB_GAMMA = 2.4


def _srgb_to_linear(x: np.ndarray) -> np.ndarray:
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** _SRGB_GAMMA)


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / _SRGB_GAMMA) - 0.055)


def decode_linear(path: Path, half_size: bool = False) -> np.ndarray:
    """Decode to float32 linear RGB [0,1], camera WB applied, no auto-bright."""
    if is_raw(path):
        with rawpy.imread(str(path)) as raw:
            rgb = raw.postprocess(
                use_camera_wb=True,
                no_auto_bright=True,
                output_bps=16,
                gamma=(1, 1),  # keep linear
                half_size=half_size,
                output_color=rawpy.ColorSpace.sRGB,
            )
        return rgb.astype(np.float32) / 65535.0

    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        if half_size:
            im.thumbnail((im.width // 2, im.height // 2), Image.LANCZOS)
        arr = np.asarray(im, dtype=np.float32) / 255.0
    return _srgb_to_linear(arr)


def extract_thumbnail(path: Path, max_px: int = 400) -> bytes:
    """Fast JPEG thumbnail: embedded preview for RAW, downscale otherwise.
    Shows the camera rendering, not viberoom edits."""
    im: Image.Image
    if is_raw(path):
        try:
            with rawpy.imread(str(path)) as raw:
                thumb = raw.extract_thumb()
            if thumb.format == rawpy.ThumbFormat.JPEG:
                im = Image.open(io.BytesIO(thumb.data))
            else:
                im = Image.fromarray(thumb.data)
        except Exception:
            # No usable embedded thumb — fall back to a fast half-size decode.
            arr = decode_linear(path, half_size=True)
            im = Image.fromarray((linear_to_srgb(arr) * 255).astype(np.uint8))
    else:
        im = Image.open(path)
    im = ImageOps.exif_transpose(im).convert("RGB")
    im.thumbnail((max_px, max_px), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return buf.getvalue()
