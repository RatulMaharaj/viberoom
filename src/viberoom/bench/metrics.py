"""Image quality metrics: PSNR, SSIM, and CIEDE2000.

Everything is numpy-only and deterministic — no scipy/skimage — so benchmark
numbers are reproducible across machines and safe to check into a baseline.
SSIM reuses the pipeline's own `fast_blur` for its local statistics, which is
a 3-pass box approximation of a gaussian window rather than a true 11x11
gaussian; values track reference implementations to ~1e-3 and are stable,
which is what a regression suite needs.

Inputs are float arrays in [0,1] (HxW or HxWxC) unless noted. uint8 is
accepted and normalized.
"""

from __future__ import annotations

import numpy as np

from viberoom.engine.ops.blur import fast_blur

# sRGB D65 -> XYZ (IEC 61966-2-1), and the D65 white point we normalize by.
_SRGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
    dtype=np.float64,
)
_D65 = np.array([0.95047, 1.00000, 1.08883], dtype=np.float64)

# The published matrix is rounded to 7 digits, so its rows miss the white
# point by ~1e-7 and neutral sRGB would land a hair off a*=b*=0. Rescaling
# each row to sum exactly to its white-point component makes grays exactly
# neutral, which is what the ColorChecker gray ramp is read against.
_SRGB_TO_XYZ *= (_D65 / _SRGB_TO_XYZ.sum(axis=1))[:, None]

_SSIM_SIGMA = 1.5


def _as_float(img: np.ndarray) -> np.ndarray:
    """Normalize uint8 to [0,1] float64; pass floats through."""
    arr = np.asarray(img)
    if arr.dtype == np.uint8:
        return arr.astype(np.float64) / 255.0
    if arr.dtype == np.uint16:
        return arr.astype(np.float64) / 65535.0
    return arr.astype(np.float64)


def _check_same_shape(a: np.ndarray, b: np.ndarray) -> None:
    if a.shape != b.shape:
        raise ValueError(f"shape mismatch: {a.shape} vs {b.shape}")


def _luma(img: np.ndarray) -> np.ndarray:
    """Rec.709 luma of an HxWx3 array; HxW passes through unchanged."""
    if img.ndim == 2:
        return img
    return img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722


# ---------- PSNR ----------

def mse(a: np.ndarray, b: np.ndarray) -> float:
    """Mean squared error between two images in [0,1]."""
    x, y = _as_float(a), _as_float(b)
    _check_same_shape(x, y)
    return float(np.mean((x - y) ** 2))


def psnr(a: np.ndarray, b: np.ndarray, data_range: float = 1.0) -> float:
    """Peak signal-to-noise ratio in dB. Identical images return inf."""
    err = mse(a, b)
    if err == 0:
        return float("inf")
    return float(10.0 * np.log10((data_range**2) / err))


# ---------- SSIM ----------

def ssim(
    a: np.ndarray,
    b: np.ndarray,
    data_range: float = 1.0,
    sigma: float = _SSIM_SIGMA,
) -> float:
    """Mean structural similarity in [-1,1]; 1.0 means identical.

    Color images are compared on luma, which is the usual convention and
    keeps the number comparable to published SSIM figures.
    """
    x, y = _as_float(a), _as_float(b)
    _check_same_shape(x, y)
    x, y = _luma(x).astype(np.float32), _luma(y).astype(np.float32)

    c1 = (0.01 * data_range) ** 2
    c2 = (0.03 * data_range) ** 2

    mu_x = fast_blur(x, sigma)
    mu_y = fast_blur(y, sigma)
    mu_xx, mu_yy, mu_xy = mu_x * mu_x, mu_y * mu_y, mu_x * mu_y

    # Local (co)variances, clamped: the box approximation can undershoot to
    # a small negative value on flat regions.
    var_x = np.maximum(fast_blur(x * x, sigma) - mu_xx, 0)
    var_y = np.maximum(fast_blur(y * y, sigma) - mu_yy, 0)
    cov_xy = fast_blur(x * y, sigma) - mu_xy

    num = (2 * mu_xy + c1) * (2 * cov_xy + c2)
    den = (mu_xx + mu_yy + c1) * (var_x + var_y + c2)
    return float(np.mean(num / den))


# ---------- color ----------

def srgb_to_linear(img: np.ndarray) -> np.ndarray:
    """Undo the sRGB transfer function. Input/output in [0,1]."""
    x = np.clip(_as_float(img), 0, 1)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def srgb_to_lab(img: np.ndarray) -> np.ndarray:
    """sRGB (D65, [0,1] or uint8) -> CIE L*a*b*. Shape HxWx3 or Nx3."""
    lin = srgb_to_linear(img)
    if lin.shape[-1] != 3:
        raise ValueError("srgb_to_lab expects a 3-channel image")
    xyz = lin @ _SRGB_TO_XYZ.T / _D65

    eps = 216 / 24389
    kappa = 24389 / 27
    f = np.where(xyz > eps, np.cbrt(xyz), (kappa * xyz + 16) / 116)
    fx, fy, fz = f[..., 0], f[..., 1], f[..., 2]

    return np.stack(
        [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)], axis=-1
    )


def delta_e_2000(
    lab1: np.ndarray, lab2: np.ndarray, k_l: float = 1.0, k_c: float = 1.0, k_h: float = 1.0
) -> np.ndarray:
    """CIEDE2000 color difference, elementwise over the leading axes.

    Both inputs are L*a*b* arrays with a trailing axis of 3. Returns dE per
    pixel/patch; ~1.0 is the nominal just-noticeable difference, and under
    ~2.0 is generally considered a good chart match.
    """
    l1, a1, b1 = (np.asarray(lab1, dtype=np.float64)[..., i] for i in range(3))
    l2, a2, b2 = (np.asarray(lab2, dtype=np.float64)[..., i] for i in range(3))

    c1 = np.hypot(a1, b1)
    c2 = np.hypot(a2, b2)
    c_bar = (c1 + c2) / 2
    c_bar7 = c_bar**7
    g = 0.5 * (1 - np.sqrt(c_bar7 / (c_bar7 + 25.0**7)))

    a1p, a2p = (1 + g) * a1, (1 + g) * a2
    c1p, c2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360

    chroma_zero = (c1p * c2p) == 0

    dlp = l2 - l1
    dcp = c2p - c1p
    dhp = h2p - h1p
    dhp = np.where(dhp > 180, dhp - 360, np.where(dhp < -180, dhp + 360, dhp))
    dhp = np.where(chroma_zero, 0.0, dhp)
    dhp_big = 2 * np.sqrt(c1p * c2p) * np.sin(np.radians(dhp / 2))

    lbp = (l1 + l2) / 2
    cbp = (c1p + c2p) / 2
    h_sum, h_diff = h1p + h2p, np.abs(h1p - h2p)
    hbp = np.where(
        chroma_zero,
        h_sum,
        np.where(
            h_diff <= 180,
            h_sum / 2,
            np.where(h_sum < 360, (h_sum + 360) / 2, (h_sum - 360) / 2),
        ),
    )

    t = (
        1
        - 0.17 * np.cos(np.radians(hbp - 30))
        + 0.24 * np.cos(np.radians(2 * hbp))
        + 0.32 * np.cos(np.radians(3 * hbp + 6))
        - 0.20 * np.cos(np.radians(4 * hbp - 63))
    )

    s_l = 1 + (0.015 * (lbp - 50) ** 2) / np.sqrt(20 + (lbp - 50) ** 2)
    s_c = 1 + 0.045 * cbp
    s_h = 1 + 0.015 * cbp * t

    d_theta = 30 * np.exp(-(((hbp - 275) / 25) ** 2))
    cbp7 = cbp**7
    r_c = 2 * np.sqrt(cbp7 / (cbp7 + 25.0**7))
    r_t = -np.sin(np.radians(2 * d_theta)) * r_c

    term_l = dlp / (k_l * s_l)
    term_c = dcp / (k_c * s_c)
    term_h = dhp_big / (k_h * s_h)
    return np.sqrt(term_l**2 + term_c**2 + term_h**2 + r_t * term_c * term_h)


def mean_delta_e(a: np.ndarray, b: np.ndarray) -> float:
    """Mean CIEDE2000 between two sRGB images (or Nx3 patch sets)."""
    x, y = _as_float(a), _as_float(b)
    _check_same_shape(x, y)
    return float(np.mean(delta_e_2000(srgb_to_lab(x), srgb_to_lab(y))))
