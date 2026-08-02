"""JPEG export: full-res render -> resize -> sRGB JPEG with ICC profile."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageCms

from viberoom.engine.cache import render_full
from viberoom.recipe.schema import Recipe

_SRGB_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def export_jpeg(
    src: Path,
    recipe: Recipe,
    out_path: Path,
    quality: int = 90,
    max_dimension: int | None = None,
) -> Path:
    rgb = render_full(src, recipe)
    im = Image.fromarray(rgb)
    if max_dimension:
        im.thumbnail((max_dimension, max_dimension), Image.LANCZOS)

    # carry over basic EXIF when the source has it (RAW exif via Pillow is
    # best-effort; missing EXIF is fine)
    exif_bytes = b""
    try:
        with Image.open(src) as orig:
            exif_bytes = orig.getexif().tobytes()
    except Exception:
        pass

    out_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(
        out_path,
        "JPEG",
        quality=quality,
        icc_profile=_SRGB_ICC,
        exif=exif_bytes,
        optimize=True,
    )
    return out_path
