"""ColorChecker Classic: reference values, synthetic rendering, sampling.

A 24-patch chart is the fastest way to catch white-balance, tone-curve and
saturation bugs — a single number (mean dE2000) moves the moment the color
path drifts, and it needs no dataset download.

The reference values here are the standard sRGB renderings of the X-Rite
ColorChecker Classic. We score rendered sRGB against those directly rather
than against measured D50 spectral Lab, because the question a benchmark can
actually answer is "does our pipeline produce the expected sRGB rendering",
not "is the physical chart colorimetrically reproduced".
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from viberoom.bench.metrics import delta_e_2000, srgb_to_lab

PATCH_NAMES = (
    "dark skin", "light skin", "blue sky", "foliage", "blue flower", "bluish green",
    "orange", "purplish blue", "moderate red", "purple", "yellow green", "orange yellow",
    "blue", "green", "red", "yellow", "magenta", "cyan",
    "white", "neutral 8", "neutral 6.5", "neutral 5", "neutral 3.5", "black",
)

#: 8-bit sRGB reference values, row-major (4 rows x 6 columns).
REFERENCE_SRGB = np.array(
    [
        [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67],
        [133, 128, 177], [103, 189, 170],
        [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108],
        [157, 188, 64], [224, 163, 46],
        [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31],
        [187, 86, 149], [8, 133, 161],
        [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121],
        [85, 85, 85], [52, 52, 52],
    ],
    dtype=np.uint8,
)

ROWS, COLS = 4, 6
NEUTRAL_PATCHES = tuple(range(18, 24))  # bottom row: white -> black


@dataclass(frozen=True)
class ChartResult:
    """Per-patch and aggregate chart scores."""

    delta_e: np.ndarray  # (24,) dE2000 per patch
    sampled_srgb: np.ndarray  # (24, 3) uint8 as measured

    @property
    def mean_delta_e(self) -> float:
        return float(self.delta_e.mean())

    @property
    def max_delta_e(self) -> float:
        return float(self.delta_e.max())

    @property
    def neutral_delta_e(self) -> float:
        """Mean dE over the gray ramp — the white-balance-sensitive subset."""
        return float(self.delta_e[list(NEUTRAL_PATCHES)].mean())

    def worst(self, n: int = 3) -> list[tuple[str, float]]:
        order = np.argsort(self.delta_e)[::-1][:n]
        return [(PATCH_NAMES[i], float(self.delta_e[i])) for i in order]


def render_reference_chart(patch_px: int = 64, gap_px: int = 8) -> np.ndarray:
    """Synthesize a clean chart image (uint8 sRGB) from the reference values.

    Useful as a pipeline input: decode it, apply a recipe, and see exactly
    what the color path did to each known patch.
    """
    h = ROWS * patch_px + (ROWS + 1) * gap_px
    w = COLS * patch_px + (COLS + 1) * gap_px
    img = np.full((h, w, 3), 30, dtype=np.uint8)  # dark surround, like the real card
    for idx in range(ROWS * COLS):
        r, c = divmod(idx, COLS)
        y = gap_px + r * (patch_px + gap_px)
        x = gap_px + c * (patch_px + gap_px)
        img[y : y + patch_px, x : x + patch_px] = REFERENCE_SRGB[idx]
    return img


def sample_grid(
    img: np.ndarray, patch_px: int = 64, gap_px: int = 8, inset: float = 0.25
) -> np.ndarray:
    """Sample 24 patches from an image laid out by `render_reference_chart`.

    Averages the central `1 - 2*inset` fraction of each patch so edge
    softening from sharpening or blur does not contaminate the reading.
    """
    expected = (
        ROWS * patch_px + (ROWS + 1) * gap_px,
        COLS * patch_px + (COLS + 1) * gap_px,
    )
    if img.shape[:2] != expected:
        raise ValueError(
            f"image is {img.shape[:2]}, expected {expected} for this patch/gap size"
        )
    m = int(round(patch_px * inset))
    out = np.zeros((ROWS * COLS, 3), dtype=np.float64)
    for idx in range(ROWS * COLS):
        r, c = divmod(idx, COLS)
        y = gap_px + r * (patch_px + gap_px)
        x = gap_px + c * (patch_px + gap_px)
        block = img[y + m : y + patch_px - m, x + m : x + patch_px - m]
        out[idx] = block.reshape(-1, block.shape[-1]).mean(axis=0)
    return out


def sample_quad(img: np.ndarray, corners: np.ndarray, inset: float = 0.25) -> np.ndarray:
    """Sample 24 patches from a photographed chart given its four corners.

    `corners` is a (4, 2) array of [x, y] pixel coordinates in the order
    top-left, top-right, bottom-right, bottom-left. Patch centers are found
    by bilinear interpolation across the quad, which handles the mild
    perspective of a chart shot roughly face-on. For heavy perspective,
    crop/straighten first with the geometry ops.
    """
    corners = np.asarray(corners, dtype=np.float64)
    if corners.shape != (4, 2):
        raise ValueError("corners must be a (4, 2) array of [x, y] points")
    tl, tr, br, bl = corners

    h, w = img.shape[:2]
    out = np.zeros((ROWS * COLS, 3), dtype=np.float64)
    for idx in range(ROWS * COLS):
        r, c = divmod(idx, COLS)
        # normalized patch center within the chart's active area
        u = (c + 0.5) / COLS
        v = (r + 0.5) / ROWS
        top = tl + (tr - tl) * u
        bottom = bl + (br - bl) * u
        center = top + (bottom - top) * v

        # square sampling window scaled to the local patch size
        patch_w = np.linalg.norm(tr - tl) / COLS
        patch_h = np.linalg.norm(bl - tl) / ROWS
        half_x = max(1.0, patch_w * (0.5 - inset))
        half_y = max(1.0, patch_h * (0.5 - inset))

        x0 = int(np.clip(center[0] - half_x, 0, w - 1))
        x1 = int(np.clip(center[0] + half_x, x0 + 1, w))
        y0 = int(np.clip(center[1] - half_y, 0, h - 1))
        y1 = int(np.clip(center[1] + half_y, y0 + 1, h))
        block = img[y0:y1, x0:x1]
        out[idx] = block.reshape(-1, block.shape[-1]).mean(axis=0)
    return out


def score_patches(sampled_srgb: np.ndarray) -> ChartResult:
    """Score 24 sampled sRGB patches against the reference chart."""
    sampled = np.asarray(sampled_srgb, dtype=np.float64)
    if sampled.shape != (ROWS * COLS, 3):
        raise ValueError(f"expected a (24, 3) patch array, got {sampled.shape}")
    if sampled.max() > 1.5:  # 8-bit values
        sampled = sampled / 255.0

    lab_measured = srgb_to_lab(sampled)
    lab_reference = srgb_to_lab(REFERENCE_SRGB.astype(np.float64) / 255.0)
    de = delta_e_2000(lab_measured, lab_reference)
    return ChartResult(delta_e=de, sampled_srgb=np.clip(sampled * 255, 0, 255).astype(np.uint8))
