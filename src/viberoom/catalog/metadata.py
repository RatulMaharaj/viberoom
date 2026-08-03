"""Reliable image metadata extraction with a quality-ordered fallback chain:

1. exiftool (if installed) — the gold standard, reads everything incl. CR3,
   maker notes, video. `brew install exiftool` to enable.
2. exifread — pure-Python, solid for TIFF-based formats (ARW/NEF/DNG/CR2/JPEG).
3. Pillow — last resort, mostly for PNG/WebP/HEIC basics.

Returns (width, height, exif_dict). The dict always normalizes a summary set
of keys the UI relies on (Make, Model, LensModel, DateTimeOriginal,
ExposureTime, FNumber, ISO, FocalLength) and keeps everything else the
backend found alongside them.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path

from PIL import ExifTags, Image

_EXIFTOOL = shutil.which("exiftool")

# exiftool tag -> normalized key (exiftool -n gives numeric values)
_EXIFTOOL_MAP = {
    "Make": "Make", "Model": "Model", "LensModel": "LensModel",
    "DateTimeOriginal": "DateTimeOriginal", "ExposureTime": "ExposureTime",
    "FNumber": "FNumber", "ISO": "ISO", "FocalLength": "FocalLength",
}

# exifread tag -> normalized key
_EXIFREAD_MAP = {
    "Image Make": "Make", "Image Model": "Model",
    "EXIF LensModel": "LensModel", "EXIF DateTimeOriginal": "DateTimeOriginal",
    "EXIF ExposureTime": "ExposureTime", "EXIF FNumber": "FNumber",
    "EXIF ISOSpeedRatings": "ISO", "EXIF FocalLength": "FocalLength",
}

_PILLOW_MAP = {
    "Make": "Make", "Model": "Model", "LensModel": "LensModel",
    "DateTimeOriginal": "DateTimeOriginal", "ExposureTime": "ExposureTime",
    "FNumber": "FNumber", "ISOSpeedRatings": "ISO",
    "PhotographicSensitivity": "ISO", "FocalLength": "FocalLength",
}


def _ratio_str(v: str) -> str:
    """exifread renders rationals like '1/250' or '28/10' — normalize to
    decimal strings except shutter-style fractions, which stay readable."""
    try:
        f = Fraction(v)
        if f.denominator == 1:
            return str(f.numerator)
        if f < 1:  # shutter speed: keep fractional form
            return v
        return f"{float(f):g}"
    except (ValueError, ZeroDivisionError):
        return v


def _read_exiftool(path: Path) -> tuple[int | None, int | None, dict] | None:
    try:
        out = subprocess.run(
            [_EXIFTOOL, "-json", "-n", "-fast2", str(path)],
            capture_output=True, timeout=20, check=True,
        )
        data = json.loads(out.stdout)[0]
    except Exception:
        return None
    return _from_exiftool(data)


def _read_exiftool_many(
    paths: list[Path],
) -> dict[str, tuple[int | None, int | None, dict]] | None:
    """One exiftool process for many files, keyed by the path we passed in.

    Spawning exiftool per file dominates a cold scan; it happily takes a whole
    batch of paths per invocation. Returns None if the invocation itself failed,
    so the caller can retry the files individually."""
    try:
        out = subprocess.run(
            [_EXIFTOOL, "-json", "-n", "-fast2", *[str(p) for p in paths]],
            capture_output=True, timeout=20 + len(paths), check=True,
        )
        data = json.loads(out.stdout)
    except Exception:
        return None
    # exiftool echoes SourceFile verbatim, and skips files it could not read
    return {str(d.get("SourceFile", "")): _from_exiftool(d) for d in data}


def _from_exiftool(data: dict) -> tuple[int | None, int | None, dict]:
    exif: dict = {}
    # normalized summary keys first, then everything else exiftool found
    for tag, key in _EXIFTOOL_MAP.items():
        if tag in data:
            exif[key] = str(data[tag])
    skip = {"SourceFile", "Directory", "FileName", "FilePermissions"}
    for tag, val in data.items():
        if tag not in exif and tag not in skip and isinstance(val, (str, int, float)):
            exif[tag] = str(val)
    return data.get("ImageWidth"), data.get("ImageHeight"), exif


def _read_exifread(path: Path) -> tuple[int | None, int | None, dict] | None:
    try:
        import exifread

        with open(path, "rb") as fh:
            tags = exifread.process_file(fh, details=False)
    except Exception:
        return None
    if not tags:
        return None
    exif: dict = {}
    for tag, key in _EXIFREAD_MAP.items():
        if tag in tags:
            exif[key] = _ratio_str(str(tags[tag]))
    for tag, val in tags.items():
        short = tag.split(" ", 1)[-1]
        if short not in exif and not tag.startswith(("Thumbnail", "MakerNote")):
            exif[short] = str(val)[:200]
    w = tags.get("EXIF ExifImageWidth") or tags.get("Image ImageWidth")
    h = tags.get("EXIF ExifImageLength") or tags.get("Image ImageLength")
    try:
        return int(str(w)), int(str(h)), exif
    except (TypeError, ValueError):
        return None, None, exif


def _read_pillow(path: Path) -> tuple[int | None, int | None, dict]:
    try:
        with Image.open(path) as im:
            raw = im.getexif()
            exif: dict = {}
            for tag_id, value in raw.items():
                name = ExifTags.TAGS.get(tag_id)
                if name in _PILLOW_MAP:
                    exif[_PILLOW_MAP[name]] = str(value)
            return im.width, im.height, exif
    except Exception:
        return None, None, {}


def _without_exiftool(path: Path) -> tuple[int | None, int | None, dict]:
    result = _read_exifread(path)
    if result and result[2]:
        # exifread rarely knows true pixel dims for RAW; borrow from Pillow if missing
        if result[0] is None:
            w, h, _ = _read_pillow(path)
            return w, h, result[2]
        return result
    return _read_pillow(path)


def read_metadata(path: Path) -> tuple[int | None, int | None, dict]:
    if _EXIFTOOL:
        result = _read_exiftool(path)
        if result and result[2]:
            return result
    return _without_exiftool(path)


def read_metadata_batch(
    paths: list[Path], chunk: int = 200
) -> dict[Path, tuple[int | None, int | None, dict]]:
    """read_metadata for many files, with exiftool batched across them.

    Per file the outcome is identical to read_metadata — anything exiftool
    cannot give us still falls through exifread and Pillow."""
    out: dict[Path, tuple[int | None, int | None, dict]] = {}
    if _EXIFTOOL:
        for i in range(0, len(paths), chunk):
            group = paths[i:i + chunk]
            batch = _read_exiftool_many(group)
            for p in group:
                # a failed batch gets a per-file retry: one unreadable file must
                # not cost its neighbours their exiftool data
                res = batch.get(str(p)) if batch is not None else _read_exiftool(p)
                if res and res[2]:
                    out[p] = res
    for p in paths:
        if p not in out:
            out[p] = _without_exiftool(p)
    return out
