""".cube LUT support: parse 1D/3D LUTs, apply with (tri)linear
interpolation and strength blending. LUTs live in ~/.viberoom/luts/."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from viberoom.config import APP_DIR_NAME
from viberoom.recipe.schema import Lut

LUTS_DIR = Path.home() / APP_DIR_NAME / "luts"

_cache: dict[tuple[str, float], tuple[str, np.ndarray]] = {}


class LutError(ValueError):
    pass


def parse_cube(text: str) -> tuple[str, np.ndarray]:
    """Parse a .cube file. Returns ('1D', (N,3)) or ('3D', (N,N,N,3)) with
    values scaled to the 0-1 domain."""
    size_1d = size_3d = None
    dom_min, dom_max = np.zeros(3), np.ones(3)
    rows: list[list[float]] = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        upper = line.upper()
        if upper.startswith("TITLE"):
            continue
        if upper.startswith("LUT_1D_SIZE"):
            size_1d = int(line.split()[1])
        elif upper.startswith("LUT_3D_SIZE"):
            size_3d = int(line.split()[1])
        elif upper.startswith("DOMAIN_MIN"):
            dom_min = np.array([float(x) for x in line.split()[1:4]])
        elif upper.startswith("DOMAIN_MAX"):
            dom_max = np.array([float(x) for x in line.split()[1:4]])
        else:
            parts = line.split()
            if len(parts) == 3:
                try:
                    rows.append([float(p) for p in parts])
                except ValueError:
                    raise LutError(f"bad LUT data line: {line!r}")
    data = np.array(rows, dtype=np.float32)
    span = np.maximum(dom_max - dom_min, 1e-6)
    if size_1d:
        if data.shape != (size_1d, 3):
            raise LutError(f"expected {size_1d} 1D entries, got {len(data)}")
        return "1D", (data - dom_min) / span
    if size_3d:
        n = size_3d
        if data.shape != (n ** 3, 3):
            raise LutError(f"expected {n ** 3} 3D entries, got {len(data)}")
        # .cube ordering: red fastest, then green, then blue
        return "3D", ((data - dom_min) / span).reshape(n, n, n, 3)
    raise LutError("no LUT_1D_SIZE or LUT_3D_SIZE header found")


def load_lut(name: str) -> tuple[str, np.ndarray] | None:
    path = LUTS_DIR / f"{name}.cube"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    key = (name, mtime)
    if key not in _cache:
        _cache.clear()  # tiny cache: newest LUT only per name/mtime
        try:
            _cache[key] = parse_cube(path.read_text())
        except (OSError, LutError):
            return None
    return _cache[key]


def _apply_3d(img: np.ndarray, cube: np.ndarray) -> np.ndarray:
    n = cube.shape[0]
    x = np.clip(img, 0, 1) * (n - 1)
    i0 = np.clip(x.astype(np.int32), 0, n - 2)
    f = (x - i0).astype(np.float32)
    r0, g0, b0 = i0[..., 0], i0[..., 1], i0[..., 2]
    fr, fg, fb = f[..., 0:1], f[..., 1:2], f[..., 2:3]

    # trilinear over the 8 surrounding lattice points; cube is indexed [b,g,r]
    def c(dr, dg, db):
        return cube[b0 + db, g0 + dg, r0 + dr]

    c00 = c(0, 0, 0) * (1 - fr) + c(1, 0, 0) * fr
    c01 = c(0, 0, 1) * (1 - fr) + c(1, 0, 1) * fr
    c10 = c(0, 1, 0) * (1 - fr) + c(1, 1, 0) * fr
    c11 = c(0, 1, 1) * (1 - fr) + c(1, 1, 1) * fr
    c0 = c00 * (1 - fg) + c10 * fg
    c1 = c01 * (1 - fg) + c11 * fg
    return c0 * (1 - fb) + c1 * fb


def _apply_1d(img: np.ndarray, table: np.ndarray) -> np.ndarray:
    n = table.shape[0]
    xs = np.linspace(0, 1, n)
    out = np.empty_like(img)
    for ch in range(3):
        out[..., ch] = np.interp(np.clip(img[..., ch], 0, 1), xs, table[:, ch])
    return out


def apply_lut(img: np.ndarray, lut: Lut) -> np.ndarray:
    """Apply the recipe's LUT (if any) in display space. A missing/broken
    LUT never fails a render — it's skipped."""
    if not lut.name or lut.strength == 0:
        return img
    loaded = load_lut(lut.name)
    if loaded is None:
        return img
    kind, data = loaded
    x = np.clip(img, 0, 1).astype(np.float32)
    mapped = _apply_3d(x, data) if kind == "3D" else _apply_1d(x, data)
    t = lut.strength / 100
    return (x * (1 - t) + np.clip(mapped, 0, 1) * t).astype(np.float32)
