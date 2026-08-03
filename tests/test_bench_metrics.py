import numpy as np
import pytest

from viberoom.bench.chart import (
    REFERENCE_SRGB,
    render_reference_chart,
    sample_grid,
    sample_quad,
    score_patches,
)
from viberoom.bench.metrics import delta_e_2000, mean_delta_e, mse, psnr, srgb_to_lab, ssim


def noise_image(seed=0, h=64, w=64):
    rng = np.random.default_rng(seed)
    return rng.random((h, w, 3), dtype=np.float32)


# ---------- PSNR / SSIM ----------

def test_psnr_identical_is_inf():
    img = noise_image()
    assert psnr(img, img) == float("inf")


def test_psnr_matches_definition():
    a = np.zeros((8, 8, 3), dtype=np.float32)
    b = np.full((8, 8, 3), 0.1, dtype=np.float32)
    assert mse(a, b) == pytest.approx(0.01, rel=1e-6)
    assert psnr(a, b) == pytest.approx(20.0, abs=1e-6)


def test_psnr_decreases_with_noise():
    base = noise_image()
    rng = np.random.default_rng(1)
    small = np.clip(base + rng.normal(0, 0.01, base.shape), 0, 1)
    large = np.clip(base + rng.normal(0, 0.10, base.shape), 0, 1)
    assert psnr(base, small) > psnr(base, large)


def test_psnr_accepts_uint8_and_float_equivalently():
    a = (noise_image() * 255).astype(np.uint8)
    b = (noise_image(seed=2) * 255).astype(np.uint8)
    assert psnr(a, b) == pytest.approx(psnr(a / 255.0, b / 255.0), abs=1e-9)


def test_ssim_identical_is_one():
    img = noise_image()
    assert ssim(img, img) == pytest.approx(1.0, abs=1e-5)


def test_ssim_penalizes_structural_change_more_than_brightness():
    base = noise_image(h=96, w=96)
    brighter = np.clip(base + 0.05, 0, 1)
    scrambled = base[::-1, ::-1]
    assert ssim(base, brighter) > ssim(base, scrambled)


def test_ssim_is_symmetric():
    a, b = noise_image(3), noise_image(4)
    assert ssim(a, b) == pytest.approx(ssim(b, a), abs=1e-6)


def test_shape_mismatch_raises():
    with pytest.raises(ValueError, match="shape mismatch"):
        psnr(np.zeros((4, 4, 3)), np.zeros((5, 5, 3)))


# ---------- color ----------

def test_lab_of_white_and_black():
    lab = srgb_to_lab(np.array([[[1.0, 1.0, 1.0], [0.0, 0.0, 0.0]]], dtype=np.float64))
    np.testing.assert_allclose(lab[0, 0], [100.0, 0.0, 0.0], atol=1e-3)
    np.testing.assert_allclose(lab[0, 1], [0.0, 0.0, 0.0], atol=1e-6)


def test_lab_midgray_is_neutral():
    lab = srgb_to_lab(np.array([[[0.5, 0.5, 0.5]]], dtype=np.float64))
    assert lab[0, 0, 0] == pytest.approx(53.389, abs=0.01)  # sRGB 0.5 -> L* ~53.4
    np.testing.assert_allclose(lab[0, 0, 1:], [0.0, 0.0], atol=1e-6)


def test_delta_e_zero_for_identical():
    lab = srgb_to_lab(noise_image())
    np.testing.assert_allclose(delta_e_2000(lab, lab), 0.0, atol=1e-9)


@pytest.mark.parametrize(
    "lab1,lab2,expected",
    [
        # Sharma et al. CIEDE2000 test data — the pairs that exercise the
        # hue-rotation and chroma-weighting terms most sharply.
        ((50.0, 2.6772, -79.7751), (50.0, 0.0, -82.7485), 2.0425),
        ((50.0, 3.1571, -77.2803), (50.0, 0.0, -82.7485), 2.8615),
        ((50.0, 2.8361, -74.0200), (50.0, 0.0, -82.7485), 3.4412),
        ((50.0, -1.3802, -84.2814), (50.0, 0.0, -82.7485), 1.0000),
        ((50.0, 2.5, 0.0), (50.0, 0.0, -2.5), 4.3065),
        ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
        ((22.7233, 20.0904, -46.6940), (23.0331, 14.9730, -42.5619), 2.0373),
    ],
)
def test_delta_e_2000_reference_pairs(lab1, lab2, expected):
    got = delta_e_2000(np.array([lab1]), np.array([lab2]))
    assert float(got[0]) == pytest.approx(expected, abs=1e-4)


def test_delta_e_is_symmetric():
    a, b = srgb_to_lab(noise_image(5)), srgb_to_lab(noise_image(6))
    np.testing.assert_allclose(delta_e_2000(a, b), delta_e_2000(b, a), atol=1e-9)


def test_mean_delta_e_grows_with_color_shift():
    base = np.full((8, 8, 3), 0.5, dtype=np.float32)
    near = base.copy()
    near[..., 0] += 0.02
    far = base.copy()
    far[..., 0] += 0.2
    assert mean_delta_e(base, near) < mean_delta_e(base, far)


# ---------- chart ----------

def test_synthetic_chart_samples_back_to_reference_exactly():
    img = render_reference_chart(patch_px=32, gap_px=6)
    sampled = sample_grid(img, patch_px=32, gap_px=6)
    np.testing.assert_allclose(sampled, REFERENCE_SRGB.astype(float), atol=1e-9)


def test_perfect_chart_scores_zero_delta_e():
    result = score_patches(sample_grid(render_reference_chart(32, 6), 32, 6))
    assert result.mean_delta_e == pytest.approx(0.0, abs=1e-6)
    assert result.max_delta_e == pytest.approx(0.0, abs=1e-6)


def test_chart_detects_a_color_cast():
    img = render_reference_chart(32, 6).astype(np.int16)
    img[..., 2] = np.clip(img[..., 2] + 25, 0, 255)  # blue cast
    result = score_patches(sample_grid(img.astype(np.uint8), 32, 6))
    assert result.mean_delta_e > 2.0
    assert result.neutral_delta_e > 2.0  # grays are the most sensitive


def test_sample_grid_rejects_wrong_size():
    with pytest.raises(ValueError, match="expected"):
        sample_grid(np.zeros((10, 10, 3), dtype=np.uint8), patch_px=32, gap_px=6)


def test_sample_quad_matches_grid_on_an_axis_aligned_chart():
    patch, gap = 32, 6
    img = render_reference_chart(patch, gap)
    h, w = img.shape[:2]
    # the active chart area, excluding the surrounding gap
    x0, y0 = gap, gap
    x1, y1 = w - gap, h - gap
    corners = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=float)
    sampled = sample_quad(img, corners)
    np.testing.assert_allclose(sampled, REFERENCE_SRGB.astype(float), atol=1e-9)


def test_sample_quad_rejects_bad_corner_shape():
    with pytest.raises(ValueError, match="4, 2"):
        sample_quad(render_reference_chart(16, 4), np.zeros((3, 2)))


def test_score_patches_rejects_wrong_count():
    with pytest.raises(ValueError, match="24, 3"):
        score_patches(np.zeros((12, 3)))


def test_worst_lists_highest_delta_e_first():
    img = render_reference_chart(32, 6).astype(np.int16)
    img[6 : 6 + 32, 6 : 6 + 32] = 0  # ruin patch 0 ("dark skin")
    result = score_patches(sample_grid(img.astype(np.uint8), 32, 6))
    assert result.worst(1)[0][0] == "dark skin"
