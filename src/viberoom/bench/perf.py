"""Timing and memory regression: the same cases as `regression`, rendered at a
realistic resolution and scored on wall time and peak RSS.

`regression` answers "did the picture change?". This answers "did it get
slower, or hungrier?" — the two questions a pipeline optimization has to keep
separate, because the whole point of an optimization is to move one number
without moving the other.

Two things make the numbers trustworthy:

* **Realistic size.** The regression scenes are 96x128 so CI stays fast, but at
  that size everything is dominated by per-call overhead and a quadratic op
  looks free. Timing runs default to 3000x2000, near a half-size decode of a
  24 MP RAW.
* **A subprocess per case.** Peak RSS is a high-water mark, so measuring it in
  a shared process tells you only about the hungriest case that ran before.
  Each case gets a fresh interpreter and reports its own `ru_maxrss`.

Wall time is noisy where render statistics are not, so the baseline is
compared with a *relative* tolerance. Regenerate with
`viberoom-bench perf --update` on a quiet machine.
"""

from __future__ import annotations

import json
import multiprocessing as mp
import resource
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from viberoom.bench.regression import CASES, Case, Drift

BASELINE_PATH = Path(__file__).resolve().parents[3] / "tests" / "data" / "bench_perf_baseline.json"

#: Default render size: roughly a half-size decode of a 24 MP RAW, which is
#: what `render_preview` actually works on.
DEFAULT_SIZE = (2000, 3000)  # (h, w)

#: Wall time is noisy; 15% is wide enough to survive a busy laptop and narrow
#: enough to catch an op regressing by an order of magnitude.
TOLERANCE = 0.15

#: Peak RSS is far more stable than time, so it gets a tighter bound.
MEM_TOLERANCE = 0.10

#: Timed runs per case. The reported figure is the *minimum*, which is the
#: standard choice for benchmarking: noise only ever adds time, so the fastest
#: run is the closest to the true cost.
REPEATS = 3


def _maxrss_mb() -> float:
    """Peak resident set size of this process, in MB.

    `ru_maxrss` is bytes on macOS and kilobytes on Linux — a portability trap
    worth spelling out rather than rediscovering.
    """
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return raw / (1024 * 1024) if sys.platform == "darwin" else raw / 1024


def scene_at(name: str, h: int, w: int) -> np.ndarray:
    """Build a regression scene at an arbitrary size.

    The scene functions are already parameterized by (h, w) except the chart,
    which is built from fixed-size patches; that one is resampled up. Exact
    chart geometry does not matter here — only that the pixel count and the
    rough content are representative.
    """
    from viberoom.bench import regression as reg

    if name == "chart":
        from PIL import Image

        base = reg.scene_chart()
        im = Image.fromarray((np.clip(base, 0, 1) * 255).round().astype(np.uint8))
        im = im.resize((w, h), Image.BILINEAR)
        return (np.asarray(im).astype(np.float32) / 255.0).copy()

    builder = {
        "gradient": reg.scene_gradient,
        "noise": reg.scene_noise,
        "highlights": reg.scene_highlights,
        "hues": reg.scene_hues,
    }[name]
    return builder(h, w)


@dataclass(frozen=True)
class Sample:
    """What one case cost.

    `peak_mb` is the render's *incremental* peak over the process floor, not
    total RSS — see `_measure_in_child`.
    """

    seconds: float
    peak_mb: float

    def as_dict(self) -> dict[str, float]:
        return {"seconds": round(self.seconds, 4), "peak_mb": round(self.peak_mb, 1)}


def _measure_in_child(case_name: str, h: int, w: int, repeats: int, conn) -> None:
    """Render one case `repeats` times and report the best time and peak RSS.

    Runs in a fresh interpreter so `ru_maxrss` reflects this case alone.
    """
    try:
        from viberoom.engine.pipeline import render

        case = next(c for c in CASES if c.name == case_name)
        scene = scene_at(case.scene, h, w)

        # The high-water mark already includes the interpreter, numpy, and the
        # scene itself — around 100 MB before a single pixel is rendered. Take
        # the floor here, *before* the warm-up render, so what gets reported is
        # the pipeline's own incremental appetite rather than a constant.
        floor = _maxrss_mb()

        render(scene, case.recipe)  # warm caches (LUT tables, lazy imports)

        best = float("inf")
        for _ in range(repeats):
            start = time.perf_counter()
            render(scene, case.recipe)
            best = min(best, time.perf_counter() - start)

        peak = max(_maxrss_mb() - floor, 0.0)
        conn.send((None, Sample(seconds=best, peak_mb=peak).as_dict()))
    except Exception as exc:  # reported by the parent, never swallowed
        conn.send((f"{type(exc).__name__}: {exc}", None))
    finally:
        conn.close()


def measure_case(case: Case, h: int, w: int, repeats: int = REPEATS) -> Sample:
    """Time one case in its own process."""
    ctx = mp.get_context("spawn")
    parent, child = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_measure_in_child, args=(case.name, h, w, repeats, child))
    proc.start()
    child.close()
    try:
        error, payload = parent.recv()
    except EOFError:
        proc.join()
        raise RuntimeError(f"{case.name}: worker died (exit {proc.exitcode})") from None
    finally:
        proc.join()

    if error is not None:
        raise RuntimeError(f"{case.name}: {error}")
    return Sample(seconds=payload["seconds"], peak_mb=payload["peak_mb"])


def compute_all(
    size: tuple[int, int] = DEFAULT_SIZE,
    repeats: int = REPEATS,
    on_progress=None,
) -> dict[str, dict[str, float]]:
    """Measure every case. Slow by construction — a process and several
    full-resolution renders each."""
    h, w = size
    out: dict[str, dict[str, float]] = {}
    for i, case in enumerate(CASES, 1):
        sample = measure_case(case, h, w, repeats)
        out[case.name] = sample.as_dict()
        if on_progress:
            on_progress(i, len(CASES), case, sample)
    return out


def load_baseline(path: Path = BASELINE_PATH) -> dict:
    return json.loads(Path(path).read_text())


def write_baseline(
    path: Path = BASELINE_PATH,
    size: tuple[int, int] = DEFAULT_SIZE,
    repeats: int = REPEATS,
    on_progress=None,
) -> dict:
    """Measure everything and write it out, recording the size it was measured
    at so a later run cannot silently compare across resolutions."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "size": list(size),
        "cases": compute_all(size, repeats, on_progress),
    }
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    return data


def compare(
    current: dict[str, dict[str, float]],
    baseline: dict[str, dict[str, float]],
    tolerance: float = TOLERANCE,
    mem_tolerance: float = MEM_TOLERANCE,
) -> tuple[list[Drift], list[str], list[str]]:
    """Diff two measurement sets with a *relative* tolerance.

    Only regressions are reported. Getting faster is never a failure — that is
    the entire point of the exercise — but it does mean the baseline is stale,
    which the CLI says out loud.
    """
    drifts: list[Drift] = []
    new_cases = sorted(current.keys() - baseline.keys())
    stale_cases = sorted(baseline.keys() - current.keys())

    limits = {"seconds": tolerance, "peak_mb": mem_tolerance}
    for name in sorted(current.keys() & baseline.keys()):
        for metric, limit in limits.items():
            if metric not in baseline[name] or metric not in current[name]:
                continue
            expected, value = baseline[name][metric], current[name][metric]
            if expected <= 0:
                continue
            if (value - expected) / expected > limit:
                drifts.append(
                    Drift(case=name, metric=metric, baseline=expected, current=value)
                )

    return drifts, new_cases, stale_cases


def improvements(
    current: dict[str, dict[str, float]],
    baseline: dict[str, dict[str, float]],
    threshold: float = TOLERANCE,
) -> list[Drift]:
    """Cases that got materially *faster* — the flip side of `compare`, so a
    win shows up as a number instead of just an absence of failure."""
    out: list[Drift] = []
    for name in sorted(current.keys() & baseline.keys()):
        expected = baseline[name].get("seconds", 0)
        value = current[name].get("seconds", 0)
        if expected > 0 and (expected - value) / expected > threshold:
            out.append(Drift(case=name, metric="seconds", baseline=expected, current=value))
    return out


def parse_size(spec: str) -> tuple[int, int]:
    """Parse a `WIDTHxHEIGHT` spec into (h, w).

    Written width-first because that is how people say image sizes, and
    returned height-first because that is how numpy indexes them.
    """
    try:
        w, h = (int(part) for part in spec.lower().split("x", 1))
    except ValueError:
        raise ValueError(f"bad size {spec!r}; want WIDTHxHEIGHT, e.g. 3000x2000") from None
    if w <= 0 or h <= 0:
        raise ValueError(f"bad size {spec!r}; both dimensions must be positive")
    return h, w
