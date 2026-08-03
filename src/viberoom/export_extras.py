"""Export finishing: watermarks, output sharpening, filename templates, and
named export presets (stored in ~/.viberoom/export-presets/)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Literal

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from viberoom.config import APP_DIR_NAME

EXPORT_PRESETS_DIR = Path.home() / APP_DIR_NAME / "export-presets"

_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9 _\-]{0,63}$")

Position = Literal[
    "bottom-right", "bottom-left", "top-right", "top-left", "center", "bottom-center"
]

# output sharpening (screen/matte/glossy): unsharp radius & strength tuned
# for the medium, applied after the final resize like Lightroom's
_SHARPEN = {"screen": (0.8, 0.5), "matte": (1.2, 0.7), "glossy": (1.0, 0.6)}


def output_sharpen(im: Image.Image, medium: str) -> Image.Image:
    radius, strength = _SHARPEN[medium]
    arr = np.asarray(im, dtype=np.float32) / 255.0
    from viberoom.engine.ops.blur import fast_blur

    blurred = fast_blur(arr, radius)
    out = np.clip(arr + (arr - blurred) * strength * 2.0, 0, 1)
    return Image.fromarray((out * 255).round().astype(np.uint8))


def apply_watermark(
    im: Image.Image,
    *,
    text: str | None = None,
    image_path: str | None = None,
    position: Position = "bottom-right",
    opacity: float = 60,
    scale: float = 20,
    margin: float = 2.5,
) -> Image.Image:
    """Stamp a text or PNG watermark. scale = watermark width as % of the
    image's long edge; margin = % inset from the edges."""
    base = im.convert("RGBA")
    long_edge = max(base.size)
    target_w = max(16, int(long_edge * scale / 100))

    if image_path:
        with Image.open(image_path) as wm_src:
            wm = wm_src.convert("RGBA")
        ratio = target_w / wm.width
        wm = wm.resize((target_w, max(1, int(wm.height * ratio))), Image.LANCZOS)
    elif text:
        font_size = max(10, int(target_w / max(len(text), 1) * 1.8))
        try:
            font = ImageFont.load_default(size=font_size)
        except TypeError:  # older Pillow
            font = ImageFont.load_default()
        probe = Image.new("RGBA", (1, 1))
        bbox = ImageDraw.Draw(probe).textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        wm = Image.new("RGBA", (tw + 8, th + 8), (0, 0, 0, 0))
        draw = ImageDraw.Draw(wm)
        draw.text((4 - bbox[0], 4 - bbox[1]), text, font=font,
                  fill=(255, 255, 255, 255), stroke_width=max(1, font_size // 16),
                  stroke_fill=(0, 0, 0, 160))
    else:
        return im

    alpha = wm.getchannel("A").point(lambda a: int(a * opacity / 100))
    wm.putalpha(alpha)

    mx = int(base.width * margin / 100)
    my = int(base.height * margin / 100)
    positions = {
        "bottom-right": (base.width - wm.width - mx, base.height - wm.height - my),
        "bottom-left": (mx, base.height - wm.height - my),
        "top-right": (base.width - wm.width - mx, my),
        "top-left": (mx, my),
        "center": ((base.width - wm.width) // 2, (base.height - wm.height) // 2),
        "bottom-center": ((base.width - wm.width) // 2, base.height - wm.height - my),
    }
    base.alpha_composite(wm, positions[position])
    return base.convert("RGB")


def render_filename(template: str, *, name: str, seq: int, rating: int,
                    taken_at: str | None, ext: str) -> str:
    date = (taken_at or "")[:10] or "undated"
    rel = template.format(name=name, seq=f"{seq:04d}", rating=rating, date=date, ext=ext)
    rel = rel.lstrip("/")
    if ".." in Path(rel).parts:
        raise ValueError("filename template must not contain '..'")
    return rel


# ---------- export presets ----------

class ExportPresetError(ValueError):
    pass


def _path(name: str) -> Path:
    if not _NAME_RE.match(name):
        raise ExportPresetError(
            "export preset names are 1-64 chars: letters, digits, spaces, '-', '_'"
        )
    return EXPORT_PRESETS_DIR / f"{name}.json"


def save_export_preset(name: str, settings: dict) -> dict:
    p = _path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(settings, indent=2) + "\n")
    return {"name": name, "settings": settings}


def load_export_preset(name: str) -> dict:
    p = _path(name)
    if not p.exists():
        raise KeyError(name)
    return json.loads(p.read_text())


def delete_export_preset(name: str) -> None:
    p = _path(name)
    if not p.exists():
        raise KeyError(name)
    p.unlink()


def list_export_presets() -> list[dict]:
    if not EXPORT_PRESETS_DIR.is_dir():
        return []
    out = []
    for p in sorted(EXPORT_PRESETS_DIR.glob("*.json")):
        try:
            out.append({"name": p.stem, "settings": json.loads(p.read_text())})
        except (json.JSONDecodeError, OSError):
            continue
    return out
