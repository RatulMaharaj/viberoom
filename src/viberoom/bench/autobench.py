"""Measure auto-adjust by degrading a known-good image and asking it to recover.

There is no ground truth for "what should this photo look like" — that is a
matter of taste, and benchmarking taste needs expert retouches. But there
*is* an exact ground truth for "undo this specific damage": take a decoded
image, apply a known degradation, and the correct output is the original.

That reframing gives a real target with no dataset download, and it is the
question auto-adjust is actually answering — it is a recovery heuristic
(gray-world WB, mid-gray exposure targeting, percentile tone recovery), not
a taste engine.

## What this can and cannot measure

Read this before quoting a number from here.

`compute_auto_recipe` targets an *absolute* rendering — it pushes any image
toward mid-gray with gray-world white balance — rather than trying to undo
whatever was done to its input. So for the tone half of auto, "did it
recover the original?" is the wrong question, and a low score is not
evidence of a bug. Measured on this pack: full auto "improves" only 13/42
degradation cases, yet inspection of its proposals on the *undegraded*
originals shows sensible values (tint 3-14 on 5 of 7 files, exposure +0.6 to
+2.5 on frames that really are dark). The recovery score was penalising auto
for having a target, not catching an error.

Where the framing *is* fair:

  strategy "wb"     Gray-world white balance genuinely is a recovery
      algorithm. Given a colour cast it should remove it, and the original
      is the correct answer. Cast recovery is a real pass/fail.

  strategy "auto"   Reported as a **diagnostic only**. Useful for spotting
      clamp saturation and sign errors in the proposals, not for judging
      whether auto is good. Judging that needs expert retouches (FiveK,
      PPR10K) via `bench reference`.

The parameter diagnostic (after -2 EV, did it propose +2 EV?) is subject to
the same caveat: it is only meaningful where auto's target happens to
coincide with the original exposure.
"""

from __future__ import annotations

import statistics
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from viberoom.bench.metrics import mean_delta_e, psnr, ssim
from viberoom.engine.auto import compute_auto_recipe
from viberoom.engine.decode import decode_linear
from viberoom.engine.pipeline import render
from viberoom.recipe.schema import Recipe


@dataclass(frozen=True)
class Degradation:
    """A known, invertible-in-principle insult to a linear image."""

    key: str
    describe: str
    apply: Callable[[np.ndarray], np.ndarray]
    #: What a perfect recovery would propose, where that is well defined.
    expect_exposure_ev: float | None = None


def _scale_ev(ev: float) -> Callable[[np.ndarray], np.ndarray]:
    def _apply(x: np.ndarray) -> np.ndarray:
        return np.clip(x * (2.0**ev), 0, 1).astype(np.float32)

    return _apply


def _channel_gain(r: float, g: float, b: float) -> Callable[[np.ndarray], np.ndarray]:
    gains = np.array([r, g, b], dtype=np.float32)

    def _apply(x: np.ndarray) -> np.ndarray:
        return np.clip(x * gains, 0, 1).astype(np.float32)

    return _apply


def _flatten(strength: float) -> Callable[[np.ndarray], np.ndarray]:
    """Compress contrast toward mid-gray in linear light."""

    def _apply(x: np.ndarray) -> np.ndarray:
        return np.clip(0.18 + (x - 0.18) * (1.0 - strength), 0, 1).astype(np.float32)

    return _apply


DEGRADATIONS: tuple[Degradation, ...] = (
    Degradation("under2ev", "underexposed 2 stops", _scale_ev(-2.0), expect_exposure_ev=2.0),
    Degradation("under1ev", "underexposed 1 stop", _scale_ev(-1.0), expect_exposure_ev=1.0),
    Degradation("over1ev", "overexposed 1 stop", _scale_ev(1.0), expect_exposure_ev=-1.0),
    Degradation("warm", "warm cast (tungsten-like)", _channel_gain(1.25, 1.0, 0.75)),
    Degradation("cool", "cool cast (shade-like)", _channel_gain(0.80, 1.0, 1.30)),
    Degradation("flat", "flat, low contrast", _flatten(0.45)),
)

DEGRADATIONS_BY_KEY = {d.key: d for d in DEGRADATIONS}

#: Degradations that gray-world white balance is genuinely responsible for
#: undoing, so a recovery score against them is a fair pass/fail.
CAST_DEGRADATIONS = tuple(d for d in DEGRADATIONS if d.key in ("warm", "cool"))


def wb_only_recipe(linear: np.ndarray) -> Recipe:
    """Just the white-balance half of auto — the part that is a true
    recovery algorithm and can be scored against a known-correct answer."""
    recipe = Recipe()
    recipe.whiteBalance = compute_auto_recipe(linear).whiteBalance
    return recipe


STRATEGIES: dict[str, Callable[[np.ndarray], Recipe]] = {
    "auto": compute_auto_recipe,
    "wb": wb_only_recipe,
}


@dataclass
class RecoveryScore:
    """How well auto recovered one image from one degradation."""

    sample: str
    degradation: str
    psnr_before: float
    psnr_after: float
    delta_e_before: float
    delta_e_after: float
    ssim_before: float
    ssim_after: float
    proposed_exposure: float
    expected_exposure: float | None

    @property
    def psnr_gain(self) -> float:
        """Positive means auto moved the image closer to the original."""
        return self.psnr_after - self.psnr_before

    @property
    def delta_e_gain(self) -> float:
        """Positive means auto reduced colour error."""
        return self.delta_e_before - self.delta_e_after

    @property
    def helped(self) -> bool:
        return self.psnr_gain > 0

    @property
    def exposure_error(self) -> float | None:
        if self.expected_exposure is None:
            return None
        return self.proposed_exposure - self.expected_exposure


@dataclass
class AutoReport:
    strategy: str = "auto"
    scores: list[RecoveryScore] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def by_degradation(self, key: str) -> list[RecoveryScore]:
        return [s for s in self.scores if s.degradation == key]

    @property
    def helped_fraction(self) -> float:
        if not self.scores:
            return 0.0
        return sum(1 for s in self.scores if s.helped) / len(self.scores)

    def to_json(self, indent: int = 2) -> str:
        import json

        payload = {
            "strategy": self.strategy,
            "helped_fraction": round(self.helped_fraction, 4),
            "scores": [
                {**asdict(s), "psnr_gain": round(s.psnr_gain, 4),
                 "delta_e_gain": round(s.delta_e_gain, 4)}
                for s in self.scores
            ],
            "errors": self.errors,
        }
        return json.dumps(payload, indent=indent)

    def summary(self) -> str:
        if not self.scores:
            return f"{self.strategy}: nothing scored" + (
                "\n" + "\n".join(self.errors) if self.errors else ""
            )

        lines = [
            f"strategy: {self.strategy}",
            f"improved {sum(1 for s in self.scores if s.helped)}/{len(self.scores)} cases",
        ]
        if self.strategy == "auto":
            lines += [
                "",
                "NOTE: auto targets an absolute rendering, not recovery of its input,",
                "so these numbers are a DIAGNOSTIC (clamp saturation, sign errors) and",
                "not a verdict on quality. Use `--strategy wb` for a fair pass/fail, or",
                "`bench reference` against expert retouches to judge auto properly.",
            ]
        lines += [
            "",
            f"{'degradation':<28}{'PSNR before':>12}{'after':>9}{'gain':>9}"
            f"{'dE before':>11}{'after':>8}{'gain':>8}",
        ]
        for deg in DEGRADATIONS:
            rows = self.by_degradation(deg.key)
            if not rows:
                continue
            lines.append(
                f"{deg.describe:<28}"
                f"{statistics.fmean(r.psnr_before for r in rows):>12.2f}"
                f"{statistics.fmean(r.psnr_after for r in rows):>9.2f}"
                f"{statistics.fmean(r.psnr_gain for r in rows):>+9.2f}"
                f"{statistics.fmean(r.delta_e_before for r in rows):>11.2f}"
                f"{statistics.fmean(r.delta_e_after for r in rows):>8.2f}"
                f"{statistics.fmean(r.delta_e_gain for r in rows):>+8.2f}"
            )

        exposure_rows = [s for s in self.scores if s.exposure_error is not None]
        if exposure_rows:
            lines += ["", "exposure proposals (diagnostic):"]
            for deg in DEGRADATIONS:
                rows = [s for s in exposure_rows if s.degradation == deg.key]
                if not rows:
                    continue
                lines.append(
                    f"    {deg.describe:<26} expected {rows[0].expected_exposure:+.2f} EV, "
                    f"proposed {statistics.fmean(r.proposed_exposure for r in rows):+.2f} EV "
                    f"(err {statistics.fmean(abs(r.exposure_error) for r in rows):.2f})"
                )

        for err in self.errors:
            lines.append(f"error: {err}")
        return "\n".join(lines)


def score_recovery(
    truth_linear: np.ndarray,
    sample: str,
    degradation: Degradation,
    recipe_for: Callable[[np.ndarray], Recipe] = compute_auto_recipe,
) -> RecoveryScore:
    """Degrade, recover, and score against the original render."""
    truth = render(truth_linear, Recipe())
    degraded_linear = degradation.apply(truth_linear)
    degraded = render(degraded_linear, Recipe())

    recipe = recipe_for(degraded_linear)
    recovered = render(degraded_linear, recipe)

    return RecoveryScore(
        sample=sample,
        degradation=degradation.key,
        psnr_before=psnr(degraded, truth),
        psnr_after=psnr(recovered, truth),
        delta_e_before=mean_delta_e(degraded, truth),
        delta_e_after=mean_delta_e(recovered, truth),
        ssim_before=ssim(degraded, truth),
        ssim_after=ssim(recovered, truth),
        proposed_exposure=float(recipe.tone.exposure),
        expected_exposure=degradation.expect_exposure_ev,
    )


def run_auto_bench(
    files: list[Path],
    degradations: tuple[Degradation, ...] = DEGRADATIONS,
    recipe_for: Callable[[np.ndarray], Recipe] = compute_auto_recipe,
    strategy_name: str = "auto",
    half_size: bool = True,
    max_long_edge: int = 900,
    on_progress: Callable[[int, int, Path], None] | None = None,
) -> AutoReport:
    """Run every degradation against every file."""
    from PIL import Image

    report = AutoReport(strategy=strategy_name)

    for i, path in enumerate(files, start=1):
        if on_progress:
            on_progress(i, len(files), path)
        try:
            linear = decode_linear(path, half_size=half_size)
        except Exception as exc:  # noqa: BLE001
            report.errors.append(f"{path.name}: decode failed: {type(exc).__name__}: {exc}")
            continue

        # Work small: recovery quality is a global-statistics question, and
        # full-resolution renders would dominate the runtime for no gain.
        h, w = linear.shape[:2]
        scale = max_long_edge / max(h, w)
        if scale < 1.0:
            size = (max(1, int(w * scale)), max(1, int(h * scale)))
            # Pillow has no 16-bit RGB mode, and quantizing to 8-bit here
            # would throw away the linear precision auto-adjust reads its
            # percentiles from. Resize each channel as float32 instead.
            linear = np.stack(
                [
                    np.asarray(
                        Image.fromarray(linear[..., c], mode="F").resize(size, Image.LANCZOS),
                        dtype=np.float32,
                    )
                    for c in range(linear.shape[2])
                ],
                axis=-1,
            )

        for degradation in degradations:
            try:
                report.scores.append(
                    score_recovery(linear, path.name, degradation, recipe_for=recipe_for)
                )
            except Exception as exc:  # noqa: BLE001
                report.errors.append(
                    f"{path.name}/{degradation.key}: {type(exc).__name__}: {exc}"
                )
    return report
