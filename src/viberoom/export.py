"""Export: full-res render -> resize -> sRGB JPEG/PNG/TIFF.

JPEG and TIFF are 8-bit via Pillow. PNG supports 16-bit RGB through a small
dependency-free encoder (Pillow has no 16-bit RGB mode), rendered from the
float pipeline so the extra depth is real, not upscaled 8-bit."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path
from typing import Literal

import numpy as np
from PIL import Image, ImageCms

from viberoom.engine.cache import render_full, render_full_float
from viberoom.recipe.schema import Recipe

_SRGB_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()

ExportFormat = Literal["jpeg", "png", "tiff"]

_EXTENSIONS = {"jpeg": ".jpg", "png": ".png", "tiff": ".tif"}


def default_extension(fmt: ExportFormat) -> str:
    return _EXTENSIONS[fmt]


def _write_png16(arr: np.ndarray, out_path: Path) -> None:
    """Minimal 16-bit RGB PNG writer (big-endian samples, per PNG spec)."""
    h, w = arr.shape[:2]
    raw = arr.astype(">u2").tobytes()
    stride = w * 3 * 2
    scanlines = b"".join(
        b"\x00" + raw[y * stride:(y + 1) * stride] for y in range(h)
    )

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 16, 2, 0, 0, 0)  # depth 16, color RGB
    payload = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"sRGB", b"\x00")
        + chunk(b"IDAT", zlib.compress(scanlines, 6))
        + chunk(b"IEND", b"")
    )
    out_path.write_bytes(payload)


def _source_exif(src: Path, iptc: dict | None = None) -> bytes:
    """Basic EXIF carry-over when the source has it (best-effort for RAW),
    plus IPTC-style description fields mapped onto standard EXIF tags."""
    try:
        with Image.open(src) as orig:
            exif = orig.getexif()
    except Exception:
        exif = Image.Exif()
    for tag, key in ((270, "caption"), (315, "creator"), (33432, "copyright")):
        if iptc and iptc.get(key):
            exif[tag] = iptc[key]
    try:
        return exif.tobytes()
    except Exception:
        return b""


def export_image(
    src: Path,
    recipe: Recipe,
    out_path: Path,
    fmt: ExportFormat = "jpeg",
    quality: int = 90,
    bit_depth: Literal[8, 16] = 8,
    max_dimension: int | None = None,
    iptc: dict | None = None,
) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if fmt == "png" and bit_depth == 16:
        rgbf = render_full_float(src, recipe)
        if max_dimension:
            im8 = Image.fromarray((rgbf * 255).round().astype(np.uint8))
            im8.thumbnail((max_dimension, max_dimension), Image.LANCZOS)
            # resize in float via PIL per channel to keep 16-bit precision
            th, tw = im8.height, im8.width
            chans = [
                np.asarray(
                    Image.fromarray(rgbf[..., c], mode="F").resize((tw, th), Image.LANCZOS)
                )
                for c in range(3)
            ]
            rgbf = np.clip(np.stack(chans, axis=-1), 0, 1)
        _write_png16((rgbf * 65535).round().astype(np.uint16), out_path)
        return out_path

    rgb = render_full(src, recipe)
    im = Image.fromarray(rgb)
    if max_dimension:
        im.thumbnail((max_dimension, max_dimension), Image.LANCZOS)

    if fmt == "jpeg":
        im.save(
            out_path, "JPEG",
            quality=quality, icc_profile=_SRGB_ICC, exif=_source_exif(src, iptc), optimize=True,
        )
    elif fmt == "png":
        im.save(out_path, "PNG", icc_profile=_SRGB_ICC)
    else:  # tiff
        im.save(
            out_path, "TIFF",
            icc_profile=_SRGB_ICC, compression="tiff_deflate", exif=_source_exif(src, iptc),
        )
    return out_path


def export_jpeg(
    src: Path,
    recipe: Recipe,
    out_path: Path,
    quality: int = 90,
    max_dimension: int | None = None,
) -> Path:
    """Back-compat wrapper used by older callers/tests."""
    return export_image(src, recipe, out_path, "jpeg", quality=quality, max_dimension=max_dimension)
