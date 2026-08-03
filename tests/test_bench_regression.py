"""Golden regression over the render pipeline.

If these fail after an intentional change, review the reported drift, then
regenerate with `viberoom-bench regress --update` and commit the new
baseline alongside the code change.
"""

import numpy as np
import pytest

from viberoom.bench import regression
from viberoom.bench.regression import CASES, TOLERANCE, compute_all, get_scene, signature


@pytest.fixture(scope="module")
def baseline():
    if not regression.BASELINE_PATH.exists():
        pytest.fail(
            f"missing baseline at {regression.BASELINE_PATH}; "
            "create it with `viberoom-bench regress --update`"
        )
    return regression.load_baseline()


@pytest.fixture(scope="module")
def current():
    return compute_all()


def test_no_pipeline_drift(current, baseline):
    drifts, new_cases, stale = regression.compare(current, baseline, tolerance=TOLERANCE)
    assert not drifts, "pipeline output drifted:\n" + "\n".join(str(d) for d in drifts)


def test_baseline_covers_every_case(current, baseline):
    _, new_cases, stale = regression.compare(current, baseline)
    assert not new_cases, f"cases missing from the baseline: {new_cases}"
    assert not stale, f"baseline has cases that no longer exist: {stale}"


def test_case_names_are_unique():
    names = [c.name for c in CASES]
    assert len(names) == len(set(names))


def test_scenes_are_deterministic():
    for name in ("gradient", "chart", "noise", "highlights", "hues"):
        regression.SCENES.clear()
        first = get_scene(name).copy()
        regression.SCENES.clear()
        np.testing.assert_array_equal(first, get_scene(name))


def test_scenes_are_valid_linear_images():
    for name in ("gradient", "chart", "noise", "highlights", "hues"):
        scene = get_scene(name)
        assert scene.ndim == 3 and scene.shape[2] == 3
        assert scene.dtype == np.float32
        assert 0.0 <= scene.min() and scene.max() <= 1.0


def test_every_case_actually_changes_something(current):
    """A case whose recipe is a no-op tells us nothing — catch dead cases."""
    noop_by_scene = {
        c.scene: current[c.name] for c in CASES if c.name.startswith("noop/")
    }
    for case in CASES:
        if case.name.startswith("noop/") or case.scene not in noop_by_scene:
            continue
        base = noop_by_scene[case.scene]
        moved = any(
            abs(current[case.name][k] - base[k]) > TOLERANCE for k in base
        )
        assert moved, f"{case.name} renders identically to a no-op recipe"


def test_signature_is_stable_across_repeated_renders():
    case = next(c for c in CASES if c.name == "effects/vignette-grain")
    assert regression.run_case(case) == regression.run_case(case)


def test_signature_detects_a_one_level_shift():
    img = np.full((16, 16, 3), 100, dtype=np.uint8)
    shifted = np.full((16, 16, 3), 101, dtype=np.uint8)
    a, b = signature(img), signature(shifted)
    assert abs(a["mean"] - b["mean"]) > TOLERANCE
