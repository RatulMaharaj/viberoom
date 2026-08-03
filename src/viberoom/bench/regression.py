"""Golden regression: synthetic scenes x fixed recipes, scored against a
checked-in baseline.

This is the layer that runs in CI. It needs no dataset, takes well under a
second, and fails the moment any op changes what it renders. Scenes are
generated from seeded numpy so the numbers are identical on every machine;
grain is already seeded per-size in `ops/effects`, so effect recipes are
reproducible too.

The signature per case is a small set of robust statistics rather than a
pixel hash: a hash tells you *that* something changed, these tell you *what*
— a shifted mean is a tone change, a shifted channel spread is a color
change, a shifted stddev is a contrast or detail change.

Regenerate the baseline with `viberoom-bench regress --update` after an
intentional pipeline change, and eyeball the diff before committing it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from viberoom.bench.chart import render_reference_chart
from viberoom.engine.decode import _srgb_to_linear
from viberoom.engine.pipeline import render
from viberoom.recipe.schema import (
    BrushMask,
    BrushStroke,
    Color,
    ColorGrading,
    Crop,
    Defringe,
    Detail,
    Effects,
    GradeBand,
    Geometry,
    Grain,
    HSL,
    HSLChannel,
    Lens,
    LinearGradientMask,
    LocalAdjustments,
    LuminanceRangeMask,
    NoiseReduction,
    RadialGradientMask,
    Recipe,
    RetouchSpot,
    Sharpening,
    Tone,
    ToneCurve,
    Vignette,
    WhiteBalance,
)

BASELINE_PATH = Path(__file__).resolve().parents[3] / "tests" / "data" / "bench_baseline.json"

#: Metrics are compared with this absolute tolerance. Values are 0-255 means
#: and stddevs, so 0.05 is far below a visible change but well above the
#: float noise from a numpy or platform update.
TOLERANCE = 0.05


# ---------- scenes ----------

def scene_gradient(h: int = 96, w: int = 128) -> np.ndarray:
    """Smooth horizontal luminance ramp with a slight color cast."""
    g = np.linspace(0.01, 0.95, w, dtype=np.float32)
    img = np.broadcast_to(g[None, :, None], (h, w, 3)).copy()
    img[..., 0] *= 1.08  # warm cast, so white balance has something to correct
    img[..., 2] *= 0.92
    return np.clip(img, 0, 1)


def scene_chart() -> np.ndarray:
    """The synthetic ColorChecker, decoded to linear like a real input."""
    srgb = render_reference_chart(patch_px=24, gap_px=4).astype(np.float32) / 255.0
    return _srgb_to_linear(srgb).astype(np.float32)


def scene_noise(h: int = 96, w: int = 128) -> np.ndarray:
    """Mid-gray with seeded gaussian noise — exercises NR and sharpening."""
    rng = np.random.default_rng(20240803)
    base = np.full((h, w, 3), 0.18, dtype=np.float32)
    return np.clip(base + rng.normal(0, 0.03, base.shape).astype(np.float32), 0, 1)


def scene_highlights(h: int = 96, w: int = 128) -> np.ndarray:
    """Blown sky over crushed foreground — the tone-recovery stress case."""
    img = np.zeros((h, w, 3), dtype=np.float32)
    sky = np.linspace(1.0, 0.75, h // 2, dtype=np.float32)[:, None, None]
    img[: h // 2] = np.clip(sky * np.array([0.9, 0.95, 1.0], dtype=np.float32), 0, 1)
    img[h // 2 :] = 0.012
    return img


def scene_hues(h: int = 96, w: int = 128) -> np.ndarray:
    """Saturated hue sweep — exercises HSL, vibrance, and color masks."""
    hue = np.linspace(0, 1, w, dtype=np.float32)
    # cheap HSV->RGB at full saturation/value
    i = np.floor(hue * 6).astype(int) % 6
    f = hue * 6 - np.floor(hue * 6)
    p, q, t = np.zeros_like(f), 1 - f, f
    o = np.ones_like(f)
    table = np.stack(
        [
            np.stack([o, t, p], -1), np.stack([q, o, p], -1), np.stack([p, o, t], -1),
            np.stack([p, q, o], -1), np.stack([t, p, o], -1), np.stack([o, p, q], -1),
        ]
    )
    row = table[i, np.arange(w)]
    return _srgb_to_linear(np.broadcast_to(row[None], (h, w, 3)).copy()).astype(np.float32)


SCENES: dict[str, np.ndarray] = {}


def get_scene(name: str) -> np.ndarray:
    """Build scenes lazily and cache them; they are pure functions of a seed."""
    if name not in SCENES:
        SCENES[name] = {
            "gradient": scene_gradient,
            "chart": scene_chart,
            "noise": scene_noise,
            "highlights": scene_highlights,
            "hues": scene_hues,
        }[name]()
    return SCENES[name]


# ---------- cases ----------

@dataclass(frozen=True)
class Case:
    """One named (scene, recipe) pair to hold steady."""

    name: str
    scene: str
    recipe: Recipe


CASES: list[Case] = [
    Case("noop/gradient", "gradient", Recipe()),
    Case("noop/chart", "chart", Recipe()),
    Case("exposure/+1ev", "gradient", Recipe(tone=Tone(exposure=1.0))),
    Case("exposure/-1.5ev", "gradient", Recipe(tone=Tone(exposure=-1.5))),
    Case(
        "tone/recovery",
        "highlights",
        Recipe(tone=Tone(highlights=-70, shadows=60, whites=-20, blacks=15)),
    ),
    Case("tone/contrast", "gradient", Recipe(tone=Tone(contrast=45))),
    Case(
        "tone/curve",
        "gradient",
        Recipe(tone=Tone(toneCurve=ToneCurve(points=[(0, 12), (128, 150), (255, 245)]))),
    ),
    Case("wb/tungsten", "chart", Recipe(whiteBalance=WhiteBalance(temp=2900, tint=8))),
    Case("wb/shade", "chart", Recipe(whiteBalance=WhiteBalance(temp=7800, tint=-6))),
    Case("color/saturation", "hues", Recipe(color=Color(saturation=-45))),
    Case("color/vibrance", "hues", Recipe(color=Color(vibrance=60))),
    Case(
        "color/hsl",
        "hues",
        Recipe(
            color=Color(
                hsl=HSL(
                    red=HSLChannel(hue=15, saturation=-30),
                    blue=HSLChannel(luminance=25, saturation=20),
                )
            )
        ),
    ),
    Case(
        "color/grading",
        "gradient",
        Recipe(
            color=Color(
                grading=ColorGrading(
                    shadows=GradeBand(hue=220, saturation=30, luminance=-5),
                    highlights=GradeBand(hue=45, saturation=25, luminance=5),
                    balance=-15,
                )
            )
        ),
    ),
    Case("presence/clarity", "chart", Recipe(tone=Tone(clarity=55, texture=30))),
    Case("presence/dehaze", "gradient", Recipe(tone=Tone(dehaze=40))),
    Case(
        "detail/sharpen",
        "noise",
        Recipe(detail=Detail(sharpening=Sharpening(amount=90, radius=1.2, detail=50))),
    ),
    Case(
        "detail/denoise",
        "noise",
        Recipe(detail=Detail(noiseReduction=NoiseReduction(luminance=70, color=50))),
    ),
    Case(
        "geometry/crop-rotate",
        "chart",
        Recipe(
            geometry=Geometry(
                rotate=6, orientation=90, crop=Crop(left=0.1, top=0.05, right=0.85, bottom=0.9)
            )
        ),
    ),
    Case(
        "effects/vignette-grain",
        "gradient",
        Recipe(
            effects=Effects(
                vignette=Vignette(amount=-45, midpoint=40, feather=60, roundness=20),
                grain=Grain(amount=35, size=40),
            )
        ),
    ),
    Case(
        "masks/linear",
        "gradient",
        Recipe(
            masks=[
                LinearGradientMask(
                    start=(0.0, 0.0),
                    end=(1.0, 0.0),
                    adjustments=LocalAdjustments(exposure=-1.0, temp=40, saturation=25),
                )
            ]
        ),
    ),
    Case(
        "masks/radial+luminance",
        "highlights",
        Recipe(
            masks=[
                RadialGradientMask(
                    center=(0.5, 0.5),
                    radiusX=0.4,
                    radiusY=0.3,
                    feather=60,
                    adjustments=LocalAdjustments(exposure=0.8, clarity=30),
                ),
                LuminanceRangeMask(
                    lumMin=70,
                    lumMax=100,
                    feather=40,
                    adjustments=LocalAdjustments(highlights=-60, temp=-25),
                ),
            ]
        ),
    ),
    Case(
        "lens/distortion-vignette",
        "chart",
        Recipe(lens=Lens(distortion=35, vignette=40)),
    ),
    Case(
        "lens/ca-defringe",
        "hues",
        Recipe(lens=Lens(caRed=60, caBlue=-45, defringe=Defringe(amount=70))),
    ),
    Case(
        "retouch/heal-clone",
        "chart",
        Recipe(
            retouch=[
                RetouchSpot(
                    mode="heal", source=(0.2, 0.2), dest=(0.6, 0.6), radius=0.1, feather=60
                ),
                RetouchSpot(
                    mode="clone", source=(0.8, 0.3), dest=(0.3, 0.7), radius=0.08, opacity=80
                ),
            ]
        ),
    ),
    Case(
        "masks/brush",
        "gradient",
        Recipe(
            masks=[
                BrushMask(
                    strokes=[
                        BrushStroke(points=[(0.2, 0.3), (0.5, 0.5), (0.8, 0.4)], radius=0.15),
                        BrushStroke(points=[(0.5, 0.5)], radius=0.06, erase=True),
                    ],
                    adjustments=LocalAdjustments(exposure=-0.9, saturation=35),
                )
            ]
        ),
    ),
    Case(
        "stack/full",
        "chart",
        Recipe(
            whiteBalance=WhiteBalance(temp=6200, tint=4),
            tone=Tone(exposure=0.4, contrast=20, highlights=-30, shadows=25, clarity=15),
            color=Color(vibrance=25, saturation=-5),
            detail=Detail(sharpening=Sharpening(amount=40)),
            effects=Effects(vignette=Vignette(amount=-25)),
        ),
    ),
]


# ---------- signatures ----------

def signature(img: np.ndarray) -> dict[str, float]:
    """Robust statistics of a rendered uint8 image.

    Chosen so a failing test points at a cause: `mean`/`p05`/`p95` move with
    tone, `r`/`g`/`b` with color, `std` with contrast and detail.
    """
    x = img.astype(np.float64)
    return {
        "mean": round(float(x.mean()), 4),
        "std": round(float(x.std()), 4),
        "p05": round(float(np.percentile(x, 5)), 4),
        "p50": round(float(np.percentile(x, 50)), 4),
        "p95": round(float(np.percentile(x, 95)), 4),
        "r": round(float(x[..., 0].mean()), 4),
        "g": round(float(x[..., 1].mean()), 4),
        "b": round(float(x[..., 2].mean()), 4),
        "h": float(img.shape[0]),
        "w": float(img.shape[1]),
    }


def run_case(case: Case) -> dict[str, float]:
    return signature(render(get_scene(case.scene), case.recipe))


def compute_all() -> dict[str, dict[str, float]]:
    """Render every case and return its signature."""
    return {case.name: run_case(case) for case in CASES}


def load_baseline(path: Path = BASELINE_PATH) -> dict[str, dict[str, float]]:
    return json.loads(Path(path).read_text())


def write_baseline(path: Path = BASELINE_PATH) -> dict[str, dict[str, float]]:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = compute_all()
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    return data


@dataclass(frozen=True)
class Drift:
    """One metric that moved beyond tolerance."""

    case: str
    metric: str
    baseline: float
    current: float

    @property
    def delta(self) -> float:
        return self.current - self.baseline

    def __str__(self) -> str:
        return (
            f"{self.case}.{self.metric}: {self.baseline:.4f} -> "
            f"{self.current:.4f} ({self.delta:+.4f})"
        )


def compare(
    current: dict[str, dict[str, float]],
    baseline: dict[str, dict[str, float]],
    tolerance: float = TOLERANCE,
) -> tuple[list[Drift], list[str], list[str]]:
    """Diff two signature sets.

    Returns (drifted metrics, cases missing from the baseline, cases in the
    baseline that no longer exist).
    """
    drifts: list[Drift] = []
    new_cases = sorted(current.keys() - baseline.keys())
    stale_cases = sorted(baseline.keys() - current.keys())

    for name in sorted(current.keys() & baseline.keys()):
        for metric, value in current[name].items():
            if metric not in baseline[name]:
                continue
            expected = baseline[name][metric]
            if abs(value - expected) > tolerance:
                drifts.append(Drift(case=name, metric=metric, baseline=expected, current=value))

    return drifts, new_cases, stale_cases
