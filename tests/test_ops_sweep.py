"""Directional sweep over every editable control.

Each case renders a synthetic image through the full pipeline twice — once with
a base recipe, once with a single control changed — and asserts a measurement
moved in the expected direction. Synthetic inputs keep the assertions
unambiguous (a highlights slider must move the bright end of a ramp and leave
the dark end alone); directions rather than exact values keep the suite from
breaking every time an algorithm is retuned. Exact-value locking is what
`bench/regression.py` is for.

Adding a slider to the schema means adding a row to CASES — `test_every_control_is_covered`
fails until you do.
"""

from __future__ import annotations

import colorsys
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np
import pytest

from viberoom.engine.decode import _srgb_to_linear
from viberoom.engine.pipeline import render_float
from viberoom.recipe.schema import HSL_CHANNELS, Recipe

# The hue centers apply_color bands around, mirrored from engine.ops.color.
HUE_CENTERS = {
    "red": 0, "orange": 30, "yellow": 60, "green": 120,
    "aqua": 180, "blue": 240, "purple": 280, "magenta": 320,
}


# ---------- synthetic inputs (linear light, as the pipeline expects) ----------

def ramp(h: int = 64, w: int = 64) -> np.ndarray:
    """Neutral gray wedge, black to white. Column position == brightness, so a
    fixed column slice is a fixed luminance band."""
    g = np.linspace(0.0, 1.0, w, dtype=np.float32)
    return np.broadcast_to(g[None, :, None], (h, w, 3)).copy()


def flat(value: float = 0.25, h: int = 32, w: int = 32) -> np.ndarray:
    return np.full((h, w, 3), value, dtype=np.float32)


def patch(hue_deg: float, sat: float = 0.6, val: float = 0.5, h: int = 32, w: int = 32) -> np.ndarray:
    """Flat field of one hue. Built in display space then converted back to
    linear, so the pixel apply_color sees has exactly `hue_deg`."""
    rgb = colorsys.hsv_to_rgb(hue_deg / 360.0, sat, val)
    srgb = np.full((h, w, 3), rgb, dtype=np.float32)
    return _srgb_to_linear(srgb).astype(np.float32)


def noise_field(h: int = 64, w: int = 64) -> np.ndarray:
    """Mid-gray plus fine per-channel noise — the thing NR should smooth and
    sharpening should exaggerate."""
    rng = np.random.default_rng(20260803)
    base = np.full((h, w, 3), 0.25, dtype=np.float32)
    return np.clip(base + rng.normal(0, 0.03, (h, w, 3)).astype(np.float32), 0, 1)


IMAGES: dict[str, Callable[[], np.ndarray]] = {
    "ramp": ramp,
    "flat": flat,
    "mid": lambda: flat(0.25),
    # grain's blur radius scales with the frame, so size needs a real-ish frame
    "flat_large": lambda: flat(0.25, 320, 320),
    "noise": noise_field,
    "muted": lambda: patch(210, sat=0.25, val=0.5),
    "saturated": lambda: patch(210, sat=0.95, val=0.5),
    **{f"patch_{name}": (lambda d=deg: patch(d)) for name, deg in HUE_CENTERS.items()},
}


# ---------- measurements (all take float sRGB output in [0,1]) ----------

def _cols(img: np.ndarray, lo: float, hi: float) -> np.ndarray:
    w = img.shape[1]
    return img[:, int(w * lo):max(int(w * hi), int(w * lo) + 1)]


def _hsv(img: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mx = img.max(-1)
    mn = img.min(-1)
    d = mx - mn
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0.0)
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    h = np.zeros_like(mx)
    nz = d > 1e-6
    with np.errstate(invalid="ignore"):
        h = np.where(nz & (mx == r), ((g - b) / np.where(nz, d, 1)) % 6, h)
        h = np.where(nz & (mx == g), (b - r) / np.where(nz, d, 1) + 2, h)
        h = np.where(nz & (mx == b), (r - g) / np.where(nz, d, 1) + 4, h)
    return h * 60.0, s, mx


def hue_mean(img: np.ndarray) -> float:
    """Saturation-weighted circular mean hue, degrees."""
    h, s, _ = _hsv(img)
    rad = np.deg2rad(h)
    return float(np.rad2deg(np.arctan2((np.sin(rad) * s).sum(), (np.cos(rad) * s).sum())) % 360.0)


def hf_energy(img: np.ndarray) -> float:
    """Mean neighbour-to-neighbour difference: high-frequency detail."""
    return float(np.abs(np.diff(img, axis=0)).mean() + np.abs(np.diff(img, axis=1)).mean())


def corner_mean(img: np.ndarray) -> float:
    h, w = img.shape[:2]
    ch, cw = max(h // 5, 1), max(w // 5, 1)
    return float(np.mean([
        img[:ch, :cw].mean(), img[:ch, -cw:].mean(),
        img[-ch:, :cw].mean(), img[-ch:, -cw:].mean(),
    ]))


MEASURES: dict[str, Callable[[np.ndarray], float]] = {
    "mean": lambda i: float(i.mean()),
    "std": lambda i: float(i.std()),
    "darks": lambda i: float(_cols(i, 0.0, 0.15).mean()),
    "deep_darks": lambda i: float(_cols(i, 0.0, 0.06).mean()),
    "brights": lambda i: float(_cols(i, 0.85, 1.0).mean()),
    "extreme_brights": lambda i: float(_cols(i, 0.94, 1.0).mean()),
    "midtones": lambda i: float(_cols(i, 0.40, 0.60).mean()),
    "red": lambda i: float(i[..., 0].mean()),
    "green": lambda i: float(i[..., 1].mean()),
    "blue": lambda i: float(i[..., 2].mean()),
    "saturation": lambda i: float(_hsv(i)[1].mean()),
    "value": lambda i: float(_hsv(i)[2].mean()),
    "hue": hue_mean,
    "hf_energy": hf_energy,
    "chroma_std": lambda i: float((i - i.mean(-1, keepdims=True)).std()),
    "corner_mean": corner_mean,
}


# ---------- the case table ----------

@dataclass(frozen=True)
class Case:
    """One control, one direction. `over` is merged onto `base` to build the
    test recipe; `base` alone builds the reference."""

    control: str                       # dotted path, used for coverage checking
    image: str
    measure: str
    over: dict[str, Any]
    direction: int                     # +1 increases, -1 decreases, 0 just changes
    base: dict[str, Any] = field(default_factory=dict)
    min_delta: float = 1e-3
    label: str = ""

    @property
    def id(self) -> str:
        arrow = {1: "up", -1: "down", 0: "changes"}[self.direction]
        return f"{self.label or self.control}-{arrow}"


def _tone(**kw: Any) -> dict[str, Any]:
    return {"tone": kw}


def _hsl_cases() -> list[Case]:
    """Every HSL channel × every control. Saturation and luminance are
    directional; hue is checked for a positive shift in circular degrees."""
    cases: list[Case] = []
    for name in HSL_CHANNELS:
        img = f"patch_{name}"
        for ctl, meas, val, direction in (
            ("saturation", "saturation", 80, 1),
            ("saturation", "saturation", -80, -1),
            ("luminance", "value", 80, 1),
            ("luminance", "value", -80, -1),
            ("hue", "hue", 100, 1),
        ):
            cases.append(Case(
                control=f"color.hsl.{name}.{ctl}",
                image=img, measure=meas,
                over={"color": {"hsl": {name: {ctl: val}}}},
                direction=direction,
                label=f"hsl.{name}.{ctl}{'+' if val > 0 else '-'}",
                min_delta=0.5 if meas == "hue" else 1e-3,
            ))
    return cases


CASES: list[Case] = [
    # ---- tone: exposure / contrast ----
    Case("tone.exposure", "ramp", "mean", _tone(exposure=1.0), +1),
    Case("tone.exposure", "ramp", "mean", _tone(exposure=-1.0), -1),
    Case("tone.contrast", "ramp", "std", _tone(contrast=80), +1),
    Case("tone.contrast", "ramp", "std", _tone(contrast=-80), -1),

    # ---- tone: the four region sliders (previously untested) ----
    Case("tone.highlights", "ramp", "brights", _tone(highlights=100), +1),
    Case("tone.highlights", "ramp", "brights", _tone(highlights=-100), -1),
    Case("tone.shadows", "ramp", "darks", _tone(shadows=100), +1),
    Case("tone.shadows", "ramp", "darks", _tone(shadows=-100), -1),
    Case("tone.whites", "ramp", "extreme_brights", _tone(whites=100), +1),
    Case("tone.whites", "ramp", "extreme_brights", _tone(whites=-100), -1),
    Case("tone.blacks", "ramp", "deep_darks", _tone(blacks=100), +1),
    Case("tone.blacks", "ramp", "deep_darks", _tone(blacks=-100), -1),

    # ---- tone: presence ----
    # clarity is midtone-weighted local contrast, so it needs midtone detail to
    # act on — on a bare ramp the midtone weighting cancels most of the effect.
    Case("tone.clarity", "noise", "hf_energy", _tone(clarity=80), +1),
    Case("tone.clarity", "noise", "hf_energy", _tone(clarity=-80), -1),
    Case("tone.texture", "noise", "hf_energy", _tone(texture=100), +1),
    Case("tone.texture", "noise", "hf_energy", _tone(texture=-100), -1),
    Case("tone.dehaze", "flat", "mean", _tone(dehaze=60), -1),
    Case("tone.dehaze", "flat", "mean", _tone(dehaze=-60), +1),
    Case("tone.toneCurve", "ramp", "midtones",
         _tone(toneCurve={"points": [[0, 0], [128, 192], [255, 255]]}), +1,
         label="toneCurve.lift"),

    # ---- white balance ----
    Case("whiteBalance.temp", "flat", "red", {"whiteBalance": {"temp": 8000}}, +1),
    Case("whiteBalance.temp", "flat", "blue", {"whiteBalance": {"temp": 8000}}, -1,
         label="whiteBalance.temp.warm-blue"),
    Case("whiteBalance.tint", "flat", "green", {"whiteBalance": {"tint": 100}}, -1,
         label="whiteBalance.tint.magenta"),
    Case("whiteBalance.tint", "flat", "green", {"whiteBalance": {"tint": -100}}, +1,
         label="whiteBalance.tint.green"),

    # ---- color: saturation / vibrance ----
    Case("color.saturation", "muted", "saturation", {"color": {"saturation": 80}}, +1),
    Case("color.saturation", "muted", "saturation", {"color": {"saturation": -100}}, -1),
    Case("color.vibrance", "muted", "saturation", {"color": {"vibrance": 80}}, +1),
    Case("color.vibrance", "muted", "saturation", {"color": {"vibrance": -80}}, -1),

    # ---- color grading ----
    Case("color.grading.shadows", "mid", "blue",
         {"color": {"grading": {"shadows": {"hue": 240, "saturation": 80}}}}, +1,
         label="grading.shadows.blue-tint"),
    Case("color.grading.midtones", "mid", "blue",
         {"color": {"grading": {"midtones": {"hue": 240, "saturation": 80}}}}, +1,
         label="grading.midtones.blue-tint"),
    Case("color.grading.highlights", "ramp", "brights",
         {"color": {"grading": {"highlights": {"luminance": 100}}}}, +1,
         label="grading.highlights.luminance"),
    # blending widens each band's reach into the midtones, so a shadow tint
    # bleeds further up the ramp.
    Case("color.grading.blending", "mid", "blue",
         base={"color": {"grading": {"shadows": {"hue": 240, "saturation": 80}, "blending": 0}}},
         over={"color": {"grading": {"shadows": {"hue": 240, "saturation": 80}, "blending": 100}}},
         direction=+1, label="grading.blending"),
    # balance pushes the shadow/highlight split upward, so more of the frame
    # counts as shadow and takes the shadow tint.
    Case("color.grading.balance", "mid", "blue",
         base={"color": {"grading": {"shadows": {"hue": 240, "saturation": 80}, "balance": 0}}},
         over={"color": {"grading": {"shadows": {"hue": 240, "saturation": 80}, "balance": 100}}},
         direction=+1, label="grading.balance"),

    # ---- detail: sharpening and noise reduction ----
    Case("detail.sharpening.amount", "noise", "hf_energy",
         {"detail": {"sharpening": {"amount": 100}}}, +1),
    Case("detail.sharpening.detail", "noise", "hf_energy",
         base={"detail": {"sharpening": {"amount": 100, "detail": 0}}},
         over={"detail": {"sharpening": {"amount": 100, "detail": 100}}},
         direction=+1),
    Case("detail.sharpening.radius", "noise", "hf_energy",
         base={"detail": {"sharpening": {"amount": 100, "radius": 0.5}}},
         over={"detail": {"sharpening": {"amount": 100, "radius": 3.0}}},
         direction=0),
    Case("detail.noiseReduction.luminance", "noise", "hf_energy",
         {"detail": {"noiseReduction": {"luminance": 100}}}, -1),
    Case("detail.noiseReduction.color", "noise", "chroma_std",
         {"detail": {"noiseReduction": {"color": 100}}}, -1),

    # ---- geometry ----
    Case("geometry.rotate", "ramp", "mean", {"geometry": {"rotate": 10}}, 0),

    # ---- effects: vignette ----
    Case("effects.vignette.amount", "flat", "corner_mean",
         {"effects": {"vignette": {"amount": -80}}}, -1),
    Case("effects.vignette.amount", "flat", "corner_mean",
         {"effects": {"vignette": {"amount": 80}}}, +1),
    # a later-starting falloff leaves more of the frame untouched
    Case("effects.vignette.midpoint", "flat", "mean",
         base={"effects": {"vignette": {"amount": -80, "midpoint": 20}}},
         over={"effects": {"vignette": {"amount": -80, "midpoint": 80}}},
         direction=+1),
    # a wider (softer) falloff reaches full strength later, so less total darkening
    Case("effects.vignette.feather", "flat", "mean",
         base={"effects": {"vignette": {"amount": -80, "midpoint": 40, "feather": 0}}},
         over={"effects": {"vignette": {"amount": -80, "midpoint": 40, "feather": 100}}},
         direction=+1),
    # rounder corners sit closer to the center of the superellipse, so they darken less
    Case("effects.vignette.roundness", "flat", "corner_mean",
         base={"effects": {"vignette": {"amount": -80, "roundness": -100}}},
         over={"effects": {"vignette": {"amount": -80, "roundness": 100}}},
         direction=+1),

    # ---- effects: grain ----
    Case("effects.grain.amount", "flat", "std", {"effects": {"grain": {"amount": 100}}}, +1),
    # coarser grain is blurred noise: same energy, less of it at high frequency
    Case("effects.grain.size", "flat_large", "hf_energy",
         base={"effects": {"grain": {"amount": 100, "size": 0}}},
         over={"effects": {"grain": {"amount": 100, "size": 100}}},
         direction=-1),

    *_hsl_cases(),
]


# ---------- harness ----------

def _deep_merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _measure(case: Case, overrides: dict[str, Any]) -> float:
    img = IMAGES[case.image]()
    out = render_float(img, Recipe.model_validate(overrides))
    return MEASURES[case.measure](out)


def _signed_delta(case: Case, after: float, before: float) -> float:
    """Hue is circular, so wrap its delta into (-180, 180]."""
    d = after - before
    if case.measure == "hue":
        d = (d + 180.0) % 360.0 - 180.0
    return d


@pytest.mark.parametrize("case", CASES, ids=[c.id for c in CASES])
def test_control_moves_image_in_expected_direction(case: Case) -> None:
    before = _measure(case, case.base)
    after = _measure(case, _deep_merge(case.base, case.over))
    delta = _signed_delta(case, after, before)

    if case.direction == 0:
        assert abs(delta) > case.min_delta, (
            f"{case.control} had no effect on {case.measure} "
            f"({before:.5f} -> {after:.5f})"
        )
    else:
        expected = "increase" if case.direction > 0 else "decrease"
        assert delta * case.direction > case.min_delta, (
            f"{case.control} should {expected} {case.measure}, "
            f"got {before:.5f} -> {after:.5f} (delta {delta:+.5f})"
        )


# ---------- behaviours the direction table can't express ----------

def test_highlights_leaves_deep_shadows_alone() -> None:
    """A region slider must stay in its region — the whole point of masking it
    to a luminance band."""
    img = ramp()
    base = render_float(img, Recipe())
    for value in (100, -100):
        out = render_float(img, Recipe.model_validate(_tone(highlights=value)))
        drift = abs(MEASURES["deep_darks"](out) - MEASURES["deep_darks"](base))
        assert drift < 0.01, f"highlights={value} moved deep shadows by {drift:.4f}"


def test_shadows_leaves_extreme_highlights_alone() -> None:
    img = ramp()
    base = render_float(img, Recipe())
    for value in (100, -100):
        out = render_float(img, Recipe.model_validate(_tone(shadows=value)))
        drift = abs(MEASURES["extreme_brights"](out) - MEASURES["extreme_brights"](base))
        assert drift < 0.01, f"shadows={value} moved extreme highlights by {drift:.4f}"


def test_vibrance_favours_muted_colors_over_saturated_ones() -> None:
    """This is the entire difference between vibrance and saturation; if it
    stops holding, vibrance is just a second saturation slider."""
    recipe = Recipe.model_validate({"color": {"vibrance": 80}})
    gains = {}
    for key in ("muted", "saturated"):
        img = IMAGES[key]()
        before = MEASURES["saturation"](render_float(img, Recipe()))
        after = MEASURES["saturation"](render_float(img, recipe))
        gains[key] = after - before
    assert gains["muted"] > gains["saturated"], (
        f"vibrance lifted saturated ({gains['saturated']:+.4f}) at least as much "
        f"as muted ({gains['muted']:+.4f})"
    )


@pytest.mark.parametrize("name", HSL_CHANNELS)
def test_hsl_channel_does_not_touch_the_opposite_hue(name: str) -> None:
    """Bands are ~45 degrees wide, so a channel must leave the hue 180 degrees
    away untouched."""
    opposite = (HUE_CENTERS[name] + 180) % 360
    img = patch(opposite)
    recipe = Recipe.model_validate({"color": {"hsl": {name: {"saturation": 100, "luminance": 100}}}})
    np.testing.assert_allclose(
        render_float(img, recipe), render_float(img, Recipe()), atol=1e-4,
        err_msg=f"hsl.{name} bled onto the {opposite:.0f}-degree hue",
    )


def test_geometry_rotate_preserves_frame_size() -> None:
    img = ramp(48, 64)
    out = render_float(img, Recipe.model_validate({"geometry": {"rotate": 10}}))
    assert out.shape == img.shape


# ---------- coverage guard ----------

# Controls deliberately outside this sweep, with the reason. Anything else new
# in the schema must get a row in CASES.
EXEMPT: dict[str, str] = {
    "color.lut.name": "needs a .cube fixture on disk; covered in test_optics.py",
    "color.lut.strength": "needs a .cube fixture on disk; covered in test_optics.py",
    "color.lut.stage": "ordering flag, not a directional control",
    "geometry.orientation": "discrete; shape assertions in test_pipeline.py",
    "geometry.flipH": "exact-pixel assertion in test_pipeline.py",
    "geometry.flipV": "exact-pixel assertion in test_pipeline.py",
    "tone.toneCurve.red": "per-channel curves asserted in test_ops_extended.py",
    "tone.toneCurve.green": "per-channel curves asserted in test_ops_extended.py",
    "tone.toneCurve.blue": "per-channel curves asserted in test_ops_extended.py",
    "masks": "list of local adjustments; covered in test_ops_extended.py",
    "retouch": "list of heal/clone spots; covered in test_ops_extended.py",
}

# Subtrees with their own dedicated suites.
EXEMPT_PREFIXES = ("lens.", "geometry.crop.", "geometry.perspective.", "masks.", "retouch.")


def _leaf_paths(model: type, prefix: str = "") -> set[str]:
    """Every scalar control in a pydantic model, as dotted paths."""
    paths: set[str] = set()
    for name, info in model.model_fields.items():
        path = f"{prefix}{name}"
        annotation = info.annotation
        nested = getattr(annotation, "model_fields", None)
        if nested is not None:
            paths |= _leaf_paths(annotation, f"{path}.")
        else:
            paths.add(path)
    return paths


def test_every_control_is_covered() -> None:
    """Fails when a control is added to the schema without a sweep case, so
    coverage can't quietly rot as the editor grows."""
    covered = {c.control for c in CASES}
    # A case on a group (e.g. color.grading.shadows) covers its leaves.
    all_paths = _leaf_paths(Recipe)
    missing = {
        p for p in all_paths
        if p not in EXEMPT
        and not p.startswith(EXEMPT_PREFIXES)
        and not any(p == c or p.startswith(c + ".") for c in covered)
    }
    assert not missing, (
        "controls with no directional test — add a row to CASES or an entry to "
        f"EXEMPT with a reason: {sorted(missing)}"
    )
