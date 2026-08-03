"""Run a benchmark: decode -> recipe -> render -> score against a reference.

The unit of work is a `Pair` (input image + expert-retouched reference). A
*strategy* decides what recipe to apply to each input — the interesting ones
are `noop` (what does the bare decode score?) and `auto` (how good is
`compute_auto_recipe`?), with `fixed:<file.json>` for a hand-tuned recipe and
room to plug an agent-produced recipe in the same shape.
"""

from __future__ import annotations

import json
import statistics
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

from viberoom.bench.datasets import Pair
from viberoom.bench.metrics import mean_delta_e, psnr, ssim
from viberoom.engine.auto import compute_auto_recipe
from viberoom.engine.decode import decode_linear
from viberoom.engine.pipeline import render
from viberoom.recipe.schema import Recipe

#: A strategy sees the source path and its decoded linear image, and returns
#: the recipe to render with.
Strategy = Callable[[Path, np.ndarray], Recipe]


@dataclass
class ImageScore:
    """Scores for one input/reference pair."""

    stem: str
    psnr: float
    ssim: float
    delta_e: float
    width: int
    height: int


@dataclass
class BenchReport:
    """Aggregate result of a benchmark run."""

    strategy: str
    count: int
    psnr_mean: float
    psnr_median: float
    ssim_mean: float
    ssim_median: float
    delta_e_mean: float
    delta_e_median: float
    scores: list[ImageScore] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(asdict(self), indent=indent)

    def summary(self) -> str:
        if not self.count:
            return f"{self.strategy}: no images scored"
        worst = sorted(self.scores, key=lambda s: s.psnr)[:3]
        lines = [
            f"strategy   {self.strategy}",
            f"images     {self.count}" + (f" ({len(self.skipped)} skipped)" if self.skipped else ""),
            f"PSNR       {self.psnr_mean:.2f} dB mean / {self.psnr_median:.2f} median",
            f"SSIM       {self.ssim_mean:.4f} mean / {self.ssim_median:.4f} median",
            f"dE2000     {self.delta_e_mean:.2f} mean / {self.delta_e_median:.2f} median",
            "worst by PSNR:",
        ]
        lines += [f"    {s.stem}  {s.psnr:.2f} dB  dE {s.delta_e:.2f}" for s in worst]
        return "\n".join(lines)


# ---------- strategies ----------

def noop_strategy(path: Path, linear: np.ndarray) -> Recipe:
    """Baseline: straight decode with no edits."""
    return Recipe()


def auto_strategy(path: Path, linear: np.ndarray) -> Recipe:
    """Whatever `compute_auto_recipe` proposes."""
    return compute_auto_recipe(linear)


def fixed_strategy(recipe: Recipe) -> Strategy:
    """Apply one hand-authored recipe to every image."""

    def _apply(path: Path, linear: np.ndarray) -> Recipe:
        return recipe

    return _apply


def resolve_strategy(spec: str) -> tuple[str, Strategy]:
    """Turn a CLI spec into a named strategy.

    Accepts `noop`, `auto`, or `fixed:<path-to-recipe.json>`.
    """
    if spec == "noop":
        return spec, noop_strategy
    if spec == "auto":
        return spec, auto_strategy
    if spec.startswith("fixed:"):
        path = Path(spec.removeprefix("fixed:")).expanduser()
        recipe = Recipe.model_validate_json(path.read_text())
        return f"fixed:{path.name}", fixed_strategy(recipe)
    raise ValueError(f"unknown strategy {spec!r} (expected noop, auto, or fixed:<file.json>)")


# ---------- scoring ----------

def _load_reference(path: Path, size: tuple[int, int]) -> np.ndarray:
    """Load a reference image as uint8 sRGB, resized to (w, h) if needed."""
    from PIL import ImageOps

    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        if im.size != size:
            im = im.resize(size, Image.LANCZOS)
        return np.asarray(im, dtype=np.uint8)


def score_pair(pair: Pair, strategy: Strategy, half_size: bool = True) -> ImageScore:
    """Render one input through a strategy and score it against its reference.

    `half_size` halves RAW decode resolution, which is ~4x faster and does
    not meaningfully change PSNR/SSIM/dE rankings — the reference is scaled
    to match either way.
    """
    linear = decode_linear(pair.input_path, half_size=half_size)
    rendered = render(linear, strategy(pair.input_path, linear))
    h, w = rendered.shape[:2]
    reference = _load_reference(pair.reference_path, (w, h))

    return ImageScore(
        stem=pair.stem,
        psnr=psnr(rendered, reference),
        ssim=ssim(rendered, reference),
        delta_e=mean_delta_e(rendered, reference),
        width=w,
        height=h,
    )


def run_reference_bench(
    pairs: list[Pair],
    strategy: Strategy,
    strategy_name: str = "custom",
    half_size: bool = True,
    on_progress: Callable[[int, int, ImageScore | None], None] | None = None,
) -> BenchReport:
    """Score every pair, tolerating individual failures.

    A file that fails to decode is recorded in `skipped` rather than aborting
    the run — partial dataset downloads and the odd corrupt RAW are normal.
    """
    scores: list[ImageScore] = []
    skipped: list[str] = []

    for i, pair in enumerate(pairs, start=1):
        try:
            score = score_pair(pair, strategy, half_size=half_size)
            scores.append(score)
        except Exception as exc:  # noqa: BLE001 - one bad file must not kill the run
            skipped.append(f"{pair.stem}: {type(exc).__name__}: {exc}")
            score = None
        if on_progress:
            on_progress(i, len(pairs), score)

    # PSNR is inf for a pixel-exact match; drop those from the mean so one
    # trivially-identical pair cannot make the aggregate meaningless.
    finite_psnr = [s.psnr for s in scores if np.isfinite(s.psnr)] or [float("inf")]

    def _mean(vals: list[float]) -> float:
        return float(statistics.fmean(vals)) if vals else 0.0

    def _median(vals: list[float]) -> float:
        return float(statistics.median(vals)) if vals else 0.0

    return BenchReport(
        strategy=strategy_name,
        count=len(scores),
        psnr_mean=_mean(finite_psnr),
        psnr_median=_median(finite_psnr),
        ssim_mean=_mean([s.ssim for s in scores]),
        ssim_median=_median([s.ssim for s in scores]),
        delta_e_mean=_mean([s.delta_e for s in scores]),
        delta_e_median=_median([s.delta_e for s in scores]),
        scores=scores,
        skipped=skipped,
    )
