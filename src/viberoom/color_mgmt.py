"""Color management for export: convert the pipeline's sRGB output to
Display P3, Adobe RGB (1998)-compatible, or ProPhoto-compatible spaces, and
generate a minimal-but-valid ICC v2 matrix/TRC profile to embed.

Note: the working space is sRGB-primaries end to end, so conversion is
colorimetric re-encoding — it will not invent colors outside sRGB, but the
exported files are correct in their stated space (and ready for the day the
decode path goes wide-gamut)."""

from __future__ import annotations

import struct
from datetime import datetime, timezone

import numpy as np

# (red xy, green xy, blue xy, white xy, gamma) — gamma None = sRGB curve
_SPACES = {
    "srgb": ((0.64, 0.33), (0.30, 0.60), (0.15, 0.06), (0.3127, 0.3290), None),
    "display-p3": ((0.680, 0.320), (0.265, 0.690), (0.150, 0.060), (0.3127, 0.3290), None),
    "adobe-rgb": ((0.64, 0.33), (0.21, 0.71), (0.15, 0.06), (0.3127, 0.3290), 563 / 256),
    "prophoto": ((0.7347, 0.2653), (0.1596, 0.8404), (0.0366, 0.0001), (0.3457, 0.3585), 1.8),
}

_NAMES = {
    "srgb": "sRGB (viberoom)",
    "display-p3": "Display P3 (viberoom)",
    "adobe-rgb": "Adobe RGB compatible (viberoom)",
    "prophoto": "ProPhoto compatible (viberoom)",
}

# Bradford chromatic adaptation
_BRADFORD = np.array([
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
])
_D50 = np.array([0.96422, 1.0, 0.82521])


def _xy_to_xyz(xy) -> np.ndarray:
    x, y = xy
    return np.array([x / y, 1.0, (1 - x - y) / y])


def rgb_to_xyz_matrix(space: str) -> np.ndarray:
    """Linear RGB -> XYZ (space's own white point)."""
    r, g, b, w, _ = _SPACES[space]
    prims = np.stack([_xy_to_xyz(r), _xy_to_xyz(g), _xy_to_xyz(b)], axis=1)
    white = _xy_to_xyz(w)
    scale = np.linalg.solve(prims, white)
    return prims * scale


def _adapt_to_d50(m: np.ndarray, white_xyz: np.ndarray) -> np.ndarray:
    src = _BRADFORD @ white_xyz
    dst = _BRADFORD @ _D50
    adapt = np.linalg.inv(_BRADFORD) @ np.diag(dst / src) @ _BRADFORD
    return adapt @ m


def conversion_matrix(src: str, dst: str) -> np.ndarray:
    """Linear src RGB -> linear dst RGB (through XYZ, Bradford-adapted)."""
    ms = rgb_to_xyz_matrix(src)
    md = rgb_to_xyz_matrix(dst)
    ws = _xy_to_xyz(_SPACES[src][3])
    wd = _xy_to_xyz(_SPACES[dst][3])
    ms_d50 = _adapt_to_d50(ms, ws)
    md_d50 = _adapt_to_d50(md, wd)
    return np.linalg.inv(md_d50) @ ms_d50


def srgb_decode(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def srgb_encode(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0, None)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def encode_trc(linear: np.ndarray, space: str) -> np.ndarray:
    gamma = _SPACES[space][4]
    if gamma is None:
        return srgb_encode(linear)
    return np.clip(linear, 0, 1) ** (1 / gamma)


def convert_from_srgb(img_srgb_encoded: np.ndarray, space: str) -> tuple[np.ndarray, np.ndarray]:
    """sRGB-encoded float [0,1] -> (dst-encoded float [0,1], out_of_gamut HxW bool)."""
    linear = srgb_decode(img_srgb_encoded)
    m = conversion_matrix("srgb", space)
    dst_linear = linear @ m.T
    oog = ((dst_linear < -1e-4) | (dst_linear > 1 + 1e-4)).any(axis=-1)
    return np.clip(encode_trc(np.clip(dst_linear, 0, 1), space), 0, 1), oog


# ---------- minimal ICC v2 profile writer ----------

def _s15f16(v: float) -> bytes:
    return struct.pack(">i", int(round(v * 65536)))


def _tag_xyz(xyz: np.ndarray) -> bytes:
    return b"XYZ " + b"\x00" * 4 + b"".join(_s15f16(float(v)) for v in xyz)


def _tag_curv(space: str) -> bytes:
    gamma = _SPACES[space][4]
    if gamma is not None:
        return b"curv" + b"\x00" * 4 + struct.pack(">I", 1) + struct.pack(">H", int(round(gamma * 256)))
    # sRGB curve as a 1024-point table
    xs = np.linspace(0, 1, 1024)
    ys = np.clip(srgb_decode(xs) * 65535, 0, 65535).round().astype(">u2")
    return b"curv" + b"\x00" * 4 + struct.pack(">I", 1024) + ys.tobytes()


def _tag_desc(text: str) -> bytes:
    ascii_text = text.encode("ascii", "replace") + b"\x00"
    # after the ASCII block: unicode lang code (4) + unicode count (4) +
    # scriptcode (2) + mac count (1) + mac desc (67), all zero
    return (
        b"desc" + b"\x00" * 4 + struct.pack(">I", len(ascii_text)) + ascii_text
        + b"\x00" * 78
    )


def build_icc(space: str) -> bytes:
    """A minimal ICC v2 RGB matrix/TRC display profile for the space."""
    m = _adapt_to_d50(rgb_to_xyz_matrix(space), _xy_to_xyz(_SPACES[space][3]))
    curv = _tag_curv(space)
    tags: list[tuple[bytes, bytes]] = [
        (b"desc", _tag_desc(_NAMES[space])),
        (b"wtpt", _tag_xyz(_D50)),
        (b"rXYZ", _tag_xyz(m[:, 0])),
        (b"gXYZ", _tag_xyz(m[:, 1])),
        (b"bXYZ", _tag_xyz(m[:, 2])),
        (b"rTRC", curv),
        (b"gTRC", curv),
        (b"bTRC", curv),
        (b"cprt", b"text" + b"\x00" * 4 + b"CC0 viberoom\x00"),
    ]

    header_size = 128
    table_size = 4 + 12 * len(tags)
    offset = header_size + table_size
    table = struct.pack(">I", len(tags))
    body = b""
    for sig, data in tags:
        padded = data + b"\x00" * ((4 - len(data) % 4) % 4)
        table += sig + struct.pack(">II", offset, len(data))
        body += padded
        offset += len(padded)

    now = datetime.now(timezone.utc)
    header = struct.pack(
        ">I4sI4s4s4s12s4s4sIII",
        header_size + table_size + len(body) - 0,  # total size placeholder (fixed below)
        b"none",                # CMM
        0x02400000,             # version 2.4
        b"mntr", b"RGB ", b"XYZ ",
        struct.pack(">HHHHHH", now.year, now.month, now.day, now.hour, now.minute, now.second),
        b"acsp", b"APPL",
        0, 0, 0,                # flags, manufacturer, model
    )
    header += b"\x00" * 8       # attributes
    header += struct.pack(">I", 0)  # rendering intent: perceptual
    header += b"".join(_s15f16(float(v)) for v in _D50)  # PCS illuminant
    header += b"\x00" * 4       # creator
    header += b"\x00" * (header_size - len(header))

    profile = header + table + body
    return struct.pack(">I", len(profile)) + profile[4:]


def profile_bytes(space: str) -> bytes:
    return build_icc(space)
