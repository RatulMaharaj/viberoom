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


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data)) + tag + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def _write_png16(arr: np.ndarray, out_path: Path, icc: bytes | None = None) -> None:
    """Minimal 16-bit RGB PNG writer (big-endian samples, per PNG spec).

    Full-res 16-bit frames are large enough that holding the pixels, the
    filtered scanlines and the deflate output alive at once dominates export
    memory, so the scanlines are built as one array and streamed straight into
    the file: the IDAT length is back-patched once the stream is finished."""
    h, w = arr.shape[:2]
    stride = w * 3 * 2
    if arr.dtype != np.uint16:
        arr = arr.astype(np.uint16)

    # Column 0 of every row stays zero: PNG filter type 0 (None).
    rows = np.zeros((h, 1 + stride), dtype=np.uint8)
    samples = rows[:, 1:].reshape(h, w * 3, 2)
    flat = arr.reshape(h, w * 3)
    samples[..., 0] = flat >> 8
    samples[..., 1] = flat & 0xFF

    ihdr = struct.pack(">IIBBBBB", w, h, 16, 2, 0, 0, 0)  # depth 16, color RGB
    color_chunk = (
        _chunk(b"iCCP", b"ICC profile\x00\x00" + zlib.compress(icc, 6))
        if icc else _chunk(b"sRGB", b"\x00")
    )

    # Feed deflate in row blocks of roughly 4 MiB so no full copy of the
    # scanlines or of the compressed payload ever exists as bytes.
    block = max(1, (4 << 20) // (1 + stride))
    comp = zlib.compressobj(6)
    crc = zlib.crc32(b"IDAT")
    length = 0

    with open(out_path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + color_chunk)
        len_pos = fh.tell()
        fh.write(struct.pack(">I", 0) + b"IDAT")
        for y in range(0, h, block):
            piece = comp.compress(rows[y:y + block].tobytes())
            if piece:
                crc = zlib.crc32(piece, crc)
                length += len(piece)
                fh.write(piece)
        piece = comp.flush()
        if piece:
            crc = zlib.crc32(piece, crc)
            length += len(piece)
            fh.write(piece)
        fh.write(struct.pack(">I", crc & 0xFFFFFFFF) + _chunk(b"IEND", b""))
        fh.seek(len_pos)
        fh.write(struct.pack(">I", length))


def _read_exif(src: Path) -> Image.Exif:
    """Source EXIF, best-effort: RAW and odd sources may not open at all."""
    try:
        with Image.open(src) as orig:
            return orig.getexif()
    except Exception:
        return Image.Exif()


def _source_exif(exif: Image.Exif, iptc: dict | None = None) -> bytes:
    """Basic EXIF carry-over when the source has it (best-effort for RAW),
    plus IPTC-style description fields mapped onto standard EXIF tags."""
    for tag, key in ((270, "caption"), (315, "creator"), (33432, "copyright")):
        if iptc and iptc.get(key):
            exif[tag] = iptc[key]
    try:
        return exif.tobytes()
    except Exception:
        return b""


ColorSpace = Literal["srgb", "display-p3", "adobe-rgb", "prophoto"]


def export_image(
    src: Path,
    recipe: Recipe,
    out_path: Path,
    fmt: ExportFormat = "jpeg",
    quality: int = 90,
    bit_depth: Literal[8, 16] = 8,
    max_dimension: int | None = None,
    iptc: dict | None = None,
    color_space: ColorSpace = "srgb",
    watermark: dict | None = None,
    output_sharpen: Literal["screen", "matte", "glossy"] | None = None,
) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if color_space == "srgb":
        icc = _SRGB_ICC
        convert = None
    else:
        from viberoom.color_mgmt import convert_from_srgb, profile_bytes

        icc = profile_bytes(color_space)
        convert = lambda arr: convert_from_srgb(arr, color_space)[0]  # noqa: E731

    if fmt == "png" and bit_depth == 16:
        rgbf = render_full_float(src, recipe)
        if max_dimension:
            # Only the target size is wanted here, so probe with a blank
            # single-channel image rather than converting the real pixels.
            probe = Image.new("L", (rgbf.shape[1], rgbf.shape[0]))
            probe.thumbnail((max_dimension, max_dimension), Image.LANCZOS)
            # resize in float via PIL per channel to keep 16-bit precision
            th, tw = probe.height, probe.width
            chans = [
                np.asarray(
                    Image.fromarray(rgbf[..., c], mode="F").resize((tw, th), Image.LANCZOS)
                )
                for c in range(3)
            ]
            rgbf = np.clip(np.stack(chans, axis=-1), 0, 1)
        if convert is not None:
            rgbf = convert(rgbf)
        _write_png16(
            (rgbf * 65535).round().astype(np.uint16), out_path,
            icc=None if color_space == "srgb" else icc,
        )
        return out_path

    rgb = render_full(src, recipe)
    if convert is not None:
        rgb = (convert(rgb.astype(np.float32) / 255.0) * 255).round().astype(np.uint8)
    im = Image.fromarray(rgb)
    if max_dimension:
        im.thumbnail((max_dimension, max_dimension), Image.LANCZOS)

    if output_sharpen:
        from viberoom.export_extras import output_sharpen as sharpen_fn

        im = sharpen_fn(im, output_sharpen)
    if watermark and (watermark.get("text") or watermark.get("image")):
        from viberoom.export_extras import apply_watermark

        im = apply_watermark(
            im,
            text=watermark.get("text"),
            image_path=watermark.get("image"),
            position=watermark.get("position", "bottom-right"),
            opacity=watermark.get("opacity", 60),
            scale=watermark.get("scale", 20),
            margin=watermark.get("margin", 2.5),
        )

    if fmt == "png":
        im.save(out_path, "PNG", icc_profile=icc)
        return out_path

    exif = _source_exif(_read_exif(src), iptc)
    if fmt == "jpeg":
        im.save(
            out_path, "JPEG",
            quality=quality, icc_profile=icc, exif=exif, optimize=True,
        )
    else:  # tiff
        im.save(
            out_path, "TIFF",
            icc_profile=icc, compression="tiff_deflate", exif=exif,
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
