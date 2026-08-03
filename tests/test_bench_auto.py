"""Tests for the auto-adjust recovery benchmark.

The provable cases live here: a neutral input must receive no colour
correction, and a colour cast must be reduced by gray-world white balance.
Those hold regardless of how auto is tuned, so they are real assertions
rather than pinned numbers.
"""

import numpy as np
import pytest

from viberoom.bench import autobench
from viberoom.bench.autobench import (
    CAST_DEGRADATIONS,
    DEGRADATIONS,
    DEGRADATIONS_BY_KEY,
    STRATEGIES,
    AutoReport,
    RecoveryScore,
    score_recovery,
    wb_only_recipe,
)
from viberoom.engine.auto import compute_auto_recipe


def neutral(value=0.18, h=48, w=48):
    return np.full((h, w, 3), value, dtype=np.float32)


def scene(h=48, w=64, seed=0):
    """A mildly colourful synthetic scene with a realistic tonal spread."""
    rng = np.random.default_rng(seed)
    ramp = np.linspace(0.03, 0.6, w, dtype=np.float32)
    img = np.repeat(ramp[None, :, None], h, 0).repeat(3, 2).copy()
    img *= np.array([1.05, 1.0, 0.95], dtype=np.float32)
    img += rng.normal(0, 0.01, img.shape).astype(np.float32)
    return np.clip(img, 0, 1)


# ---------- degradations ----------

def test_degradation_keys_are_unique():
    keys = [d.key for d in DEGRADATIONS]
    assert len(keys) == len(set(keys))


@pytest.mark.parametrize("deg", DEGRADATIONS, ids=lambda d: d.key)
def test_degradations_stay_in_range_and_are_deterministic(deg):
    img = scene()
    a, b = deg.apply(img), deg.apply(img)
    np.testing.assert_array_equal(a, b)
    assert a.dtype == np.float32
    assert 0.0 <= a.min() and a.max() <= 1.0
    assert a.shape == img.shape


@pytest.mark.parametrize("deg", DEGRADATIONS, ids=lambda d: d.key)
def test_degradations_actually_change_the_image(deg):
    img = scene()
    assert not np.allclose(deg.apply(img), img)


def test_exposure_degradations_move_brightness_the_expected_way():
    img = scene()
    assert DEGRADATIONS_BY_KEY["under2ev"].apply(img).mean() < img.mean()
    assert DEGRADATIONS_BY_KEY["over1ev"].apply(img).mean() > img.mean()


def test_casts_move_the_expected_channels():
    img = neutral()
    warm = DEGRADATIONS_BY_KEY["warm"].apply(img)
    cool = DEGRADATIONS_BY_KEY["cool"].apply(img)
    assert warm[..., 0].mean() > warm[..., 2].mean()
    assert cool[..., 2].mean() > cool[..., 0].mean()


def test_cast_degradations_are_the_wb_subset():
    assert {d.key for d in CAST_DEGRADATIONS} == {"warm", "cool"}
    assert all(d in DEGRADATIONS for d in CAST_DEGRADATIONS)


# ---------- provable auto behaviour ----------

@pytest.mark.parametrize("value", [0.08, 0.18, 0.4])
def test_neutral_input_gets_no_colour_correction(value):
    """Gray-world on a neutral image must propose no correction. This holds
    however auto is tuned, so it is a real invariant."""
    recipe = compute_auto_recipe(neutral(value))
    assert recipe.whiteBalance.temp == pytest.approx(5500, abs=60)
    assert recipe.whiteBalance.tint == pytest.approx(0, abs=1)


def test_neutral_gray_at_mid_needs_no_exposure():
    recipe = compute_auto_recipe(neutral(0.18))
    assert recipe.tone.exposure == pytest.approx(0.0, abs=0.05)


def test_warm_cast_pulls_temperature_down_and_cool_pushes_it_up():
    warm = compute_auto_recipe(neutral() * np.array([1.3, 1.0, 0.7], np.float32))
    cool = compute_auto_recipe(neutral() * np.array([0.7, 1.0, 1.3], np.float32))
    assert warm.whiteBalance.temp < 5000 < cool.whiteBalance.temp


def test_wb_only_recipe_touches_nothing_but_white_balance():
    recipe = wb_only_recipe(scene())
    assert recipe.tone == type(recipe.tone)()
    assert recipe.color == type(recipe.color)()
    assert recipe.detail == type(recipe.detail)()
    assert not recipe.masks


# ---------- recovery scoring ----------

@pytest.mark.parametrize("key", ["warm", "cool"])
def test_wb_recovers_colour_casts(key):
    """The fair pass/fail: gray-world is genuinely responsible for undoing a
    cast, so recovery must improve on the degraded image."""
    s = score_recovery(scene(), "synthetic", DEGRADATIONS_BY_KEY[key], recipe_for=wb_only_recipe)
    assert s.helped, f"{key}: PSNR {s.psnr_before:.2f} -> {s.psnr_after:.2f}"
    assert s.delta_e_after < s.delta_e_before


def test_recovery_score_gain_properties():
    s = RecoveryScore(
        sample="x", degradation="warm", psnr_before=20.0, psnr_after=25.0,
        delta_e_before=8.0, delta_e_after=3.0, ssim_before=0.8, ssim_after=0.9,
        proposed_exposure=1.8, expected_exposure=2.0,
    )
    assert s.psnr_gain == pytest.approx(5.0)
    assert s.delta_e_gain == pytest.approx(5.0)
    assert s.helped
    assert s.exposure_error == pytest.approx(-0.2)


def test_exposure_error_is_none_without_an_expectation():
    s = RecoveryScore(
        sample="x", degradation="warm", psnr_before=1, psnr_after=1,
        delta_e_before=1, delta_e_after=1, ssim_before=1, ssim_after=1,
        proposed_exposure=0.5, expected_exposure=None,
    )
    assert s.exposure_error is None


def test_strategies_registry_is_callable():
    for name, fn in STRATEGIES.items():
        recipe = fn(scene())
        assert recipe is not None, name


# ---------- reporting honesty ----------

def test_auto_summary_carries_the_diagnostic_caveat():
    """The auto strategy's numbers are easy to misquote as a quality verdict.
    The caveat must travel with them."""
    report = AutoReport(strategy="auto", scores=[
        RecoveryScore("x", "warm", 20.0, 15.0, 5.0, 9.0, 0.9, 0.7, 2.5, None)
    ])
    text = report.summary()
    assert "DIAGNOSTIC" in text
    assert "not a verdict" in text


def test_wb_summary_has_no_caveat():
    report = AutoReport(strategy="wb", scores=[
        RecoveryScore("x", "warm", 20.0, 25.0, 5.0, 3.0, 0.9, 0.95, 0.0, None)
    ])
    assert "DIAGNOSTIC" not in report.summary()


def test_helped_fraction():
    mk = lambda before, after: RecoveryScore(  # noqa: E731
        "x", "warm", before, after, 1.0, 1.0, 1.0, 1.0, 0.0, None
    )
    report = AutoReport(scores=[mk(10, 20), mk(10, 5), mk(10, 12), mk(10, 9)])
    assert report.helped_fraction == pytest.approx(0.5)


def test_empty_report_summary_does_not_crash():
    assert "nothing scored" in AutoReport(strategy="wb").summary()


def test_report_json_round_trips():
    import json

    report = AutoReport(strategy="wb", scores=[
        RecoveryScore("x", "warm", 20.0, 25.0, 5.0, 3.0, 0.9, 0.95, 0.0, None)
    ])
    payload = json.loads(report.to_json())
    assert payload["strategy"] == "wb"
    assert payload["scores"][0]["psnr_gain"] == pytest.approx(5.0)


def test_run_auto_bench_records_decode_failures(tmp_path):
    bad = tmp_path / "broken.CR2"
    bad.write_bytes(b"not a raw")
    report = autobench.run_auto_bench([bad])
    assert not report.scores
    assert len(report.errors) == 1 and "decode failed" in report.errors[0]
