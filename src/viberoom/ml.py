"""Optional ML runtime (install with `viberoom[ml]` → onnxruntime).

Two consumers:
- enhance: run any single-input image-to-image ONNX model (denoise,
  super-resolution) from ~/.viberoom/models/ over an image, tiled with
  overlap so full-resolution photos fit in memory.
- faces: UltraFace (version-RFB-320) detection — a small model with a
  simple output contract (scores + normalized boxes), auto-downloadable
  via the API."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from viberoom.config import APP_DIR_NAME

MODELS_DIR = Path.home() / APP_DIR_NAME / "models"

ULTRAFACE_NAME = "ultraface-rfb-320"
ULTRAFACE_URL = (
    "https://github.com/onnx/models/raw/main/validated/vision/body_analysis/"
    "ultraface/models/version-RFB-320.onnx"
)


class MLUnavailable(RuntimeError):
    pass


def get_ort():
    try:
        import onnxruntime

        return onnxruntime
    except ImportError:
        raise MLUnavailable(
            "onnxruntime is not installed - install the ml extra: uv sync --extra ml"
        )


def model_path(name: str) -> Path:
    return MODELS_DIR / f"{name}.onnx"


def list_models() -> list[str]:
    if not MODELS_DIR.is_dir():
        return []
    return sorted(p.stem for p in MODELS_DIR.glob("*.onnx"))


def download_ultraface() -> Path:
    """Fetch the UltraFace detector (~1.2 MB) if not present."""
    import urllib.request

    dest = model_path(ULTRAFACE_NAME)
    if dest.exists():
        return dest
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    urllib.request.urlretrieve(ULTRAFACE_URL, tmp)  # noqa: S310 - fixed https URL
    tmp.rename(dest)
    return dest


# ---------- tiled image-to-image (denoise / super-resolution) ----------

def _session(path: Path):
    ort = get_ort()
    return ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])


def run_image_model(
    img: np.ndarray, name: str, tile: int = 512, overlap: int = 32
) -> np.ndarray:
    """Run a single-input NCHW float32 image model tile-by-tile. The model's
    per-tile output size determines the scale factor (1x denoise, Nx SR).
    Input/output are float [0,1] HxWx3."""
    path = model_path(name)
    if not path.exists():
        raise MLUnavailable(f"no model named {name!r} in {MODELS_DIR}")
    sess = _session(path)
    input_name = sess.get_inputs()[0].name

    h, w = img.shape[:2]
    x = np.clip(img, 0, 1).astype(np.float32)

    # probe scale with one corner tile
    ts = min(tile, h, w)
    probe = x[:ts, :ts].transpose(2, 0, 1)[None]
    out_probe = sess.run(None, {input_name: probe})[0]
    if out_probe.ndim != 4 or out_probe.shape[1] != 3:
        raise MLUnavailable(
            f"model {name!r} must map NCHW RGB to NCHW RGB, got output {out_probe.shape}"
        )
    scale = out_probe.shape[2] / probe.shape[2]
    if scale != int(scale):
        raise MLUnavailable(f"model {name!r} has non-integer scale {scale}")
    scale = int(scale)

    out = np.zeros((h * scale, w * scale, 3), dtype=np.float32)
    weight = np.zeros((h * scale, w * scale, 1), dtype=np.float32)
    step = max(1, tile - 2 * overlap)
    for y0 in range(0, h, step):
        for x0 in range(0, w, step):
            y1, x1 = min(y0 + tile, h), min(x0 + tile, w)
            patch = x[y0:y1, x0:x1].transpose(2, 0, 1)[None]
            res = sess.run(None, {input_name: patch})[0][0].transpose(1, 2, 0)
            oy0, ox0 = y0 * scale, x0 * scale
            oy1, ox1 = oy0 + res.shape[0], ox0 + res.shape[1]
            out[oy0:oy1, ox0:ox1] += res
            weight[oy0:oy1, ox0:ox1] += 1.0
            if x1 >= w:
                break
        if y1 >= h:
            break
    return np.clip(out / np.maximum(weight, 1e-8), 0, 1)


# ---------- face detection (UltraFace) ----------

def detect_faces(img: np.ndarray, threshold: float = 0.7) -> list[dict]:
    """Detect faces; returns [{box: [x0,y0,x1,y1] normalized, score}]."""
    path = model_path(ULTRAFACE_NAME)
    if not path.exists():
        raise MLUnavailable(
            f"face model missing - POST /faces/setup downloads it to {path}"
        )
    from PIL import Image

    sess = _session(path)
    input_name = sess.get_inputs()[0].name
    small = np.asarray(
        Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).resize((320, 240)),
        dtype=np.float32,
    )
    blob = ((small - 127.0) / 128.0).transpose(2, 0, 1)[None]
    scores, boxes = sess.run(None, {input_name: blob})
    scores, boxes = scores[0], boxes[0]  # (N,2), (N,4) normalized x0,y0,x1,y1
    keep = scores[:, 1] >= threshold
    cand = [
        {"box": [float(v) for v in box], "score": float(s)}
        for box, s in zip(boxes[keep], scores[keep, 1])
    ]
    # greedy NMS
    cand.sort(key=lambda c: -c["score"])
    result: list[dict] = []
    for c in cand:
        if all(_iou(c["box"], r["box"]) < 0.4 for r in result):
            result.append(c)
    return result


def _iou(a: list[float], b: list[float]) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / max(area_a + area_b - inter, 1e-8)
