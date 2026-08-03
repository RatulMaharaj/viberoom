"""Cross-software comparison: render the same RAW through viberoom and
through external processors, then measure the divergence.

Two very different kinds of comparison live here, and conflating them would
be a mistake:

  LibRaw (dcraw_emu)  — an *oracle*. viberoom decodes via rawpy, which is
      LibRaw. With matched flags, a no-op viberoom render and a neutral
      dcraw_emu render should be near-identical. A meaningful difference is
      a bug in viberoom's pipeline, not a matter of taste.

  darktable-cli       — a *reference*, not an oracle. darktable applies its
      own scene-referred workflow, base curve and color science. Divergence
      is expected and is not by itself an error; it is useful for asking
      "does our rendering sit in the same neighbourhood as a mature
      processor, or is it wildly off?"

External tools are optional. Anything not installed is reported as
unavailable and skipped rather than failing the run.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

from viberoom.bench.metrics import mean_delta_e, psnr, ssim
from viberoom.engine.decode import decode_linear
from viberoom.engine.pipeline import render
from viberoom.recipe.schema import Recipe

#: Long-edge size that metrics are computed at. Full 60MP comparisons are
#: slow and dominated by demosaic noise; 1024 keeps the signal and is fast.
ANALYSIS_LONG_EDGE = 1024

DARKTABLE_CLI_CANDIDATES = (
    "darktable-cli",
    "/Applications/darktable.app/Contents/MacOS/darktable-cli",
)


# ---------- renderers ----------

class Renderer:
    """Renders a RAW file to uint8 sRGB. Subclasses wrap external tools."""

    name = "base"

    def available(self) -> bool:
        raise NotImplementedError

    def version(self) -> str:
        return "unknown"

    def render(self, path: Path) -> np.ndarray:
        raise NotImplementedError


class ViberoomRenderer(Renderer):
    """viberoom's own pipeline. Defaults to a no-op recipe."""

    name = "viberoom"

    def __init__(self, recipe: Recipe | None = None, half_size: bool = False):
        self.recipe = recipe or Recipe()
        self.half_size = half_size

    def available(self) -> bool:
        return True

    def version(self) -> str:
        return "local"

    def render(self, path: Path) -> np.ndarray:
        return render(decode_linear(path, half_size=self.half_size), self.recipe)


class LibRawRenderer(Renderer):
    """dcraw_emu (LibRaw's reference tool), configured to match viberoom's
    decode contract: camera white balance, no auto-brighten, sRGB primaries
    and sRGB transfer function.

    These are deliberately the same choices `decode_linear` makes, so the
    only thing left to differ is viberoom's own code.
    """

    name = "libraw"

    def __init__(self, binary: str = "dcraw_emu"):
        self.binary = binary

    def available(self) -> bool:
        return shutil.which(self.binary) is not None

    def version(self) -> str:
        out = subprocess.run(
            [self.binary], capture_output=True, text=True, timeout=30
        ).stdout
        for line in out.splitlines():
            if "LibRaw" in line:
                return line.strip()
        return "dcraw_emu"

    def render(self, path: Path) -> np.ndarray:
        with tempfile.TemporaryDirectory() as tmp:
            staged = Path(tmp) / path.name
            shutil.copy2(path, staged)
            cmd = [
                self.binary,
                "-w",  # camera white balance
                "-W",  # no auto-brighten
                "-6",  # 16-bit output
                "-o", "1",  # sRGB output primaries
                "-g", "2.4", "12.92",  # sRGB transfer function
                "-T",  # TIFF
                str(staged),
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            produced = list(Path(tmp).glob("*.tiff")) + list(Path(tmp).glob("*.tif"))
            if not produced:
                raise RuntimeError(
                    f"dcraw_emu produced no output for {path.name}: "
                    f"{proc.stderr.strip() or proc.stdout.strip()}"
                )
            with Image.open(produced[0]) as im:
                arr = np.asarray(im.convert("RGB"))
        if arr.dtype == np.uint16:
            arr = (arr.astype(np.float32) / 257.0).round().astype(np.uint8)
        return arr


class DarktableRenderer(Renderer):
    """darktable-cli with its default processing.

    We do not try to force darktable into a "neutral" mode: its defaults are
    the thing worth comparing against, and half-disabling its workflow
    produces a rendering nobody would ever ship.
    """

    name = "darktable"

    def __init__(self, binary: str | None = None):
        self.binary = binary or self._find()

    @staticmethod
    def _find() -> str | None:
        for cand in DARKTABLE_CLI_CANDIDATES:
            if shutil.which(cand) or Path(cand).exists():
                return cand
        return None

    def available(self) -> bool:
        return bool(self.binary) and Path(self.binary).exists()

    def version(self) -> str:
        out = subprocess.run(
            [self.binary, "--version"], capture_output=True, text=True, timeout=60
        ).stdout
        return out.splitlines()[0].strip() if out else "darktable"

    def render(self, path: Path) -> np.ndarray:
        with tempfile.TemporaryDirectory() as tmp:
            out_path = Path(tmp) / "out.tif"
            cmd = [
                self.binary,
                str(path),
                str(out_path),
                # No --width/--height: a downscaled export would have to be
                # resized back for comparison, costing detail the metrics care
                # about. Export native and let `align` handle the rest.
                "--hq", "true",
                "--core",
                "--configdir", str(Path(tmp) / "config"),
                "--library", ":memory:",
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
            if not out_path.exists():
                raise RuntimeError(
                    f"darktable-cli produced no output for {path.name}: "
                    f"{proc.stderr.strip()[-400:] or proc.stdout.strip()[-400:]}"
                )
            with Image.open(out_path) as im:
                arr = np.asarray(im.convert("RGB"))
        if arr.dtype == np.uint16:
            arr = (arr.astype(np.float32) / 257.0).round().astype(np.uint8)
        return arr


ALL_RENDERERS: dict[str, type[Renderer]] = {
    "viberoom": ViberoomRenderer,
    "libraw": LibRawRenderer,
    "darktable": DarktableRenderer,
}


# ---------- alignment ----------

#: Two renders whose dimensions differ by less than this fraction are treated
#: as the same framing at the same scale, i.e. an active-area disagreement.
_ACTIVE_AREA_TOLERANCE = 0.02


def align(a: np.ndarray, b: np.ndarray, long_edge: int = ANALYSIS_LONG_EDGE) -> tuple[np.ndarray, np.ndarray]:
    """Bring two renders of the same RAW into a comparable form.

    Two different situations have to be told apart, and confusing them
    silently produces nonsense metrics:

    * **Active-area disagreement** — processors include slightly different
      numbers of border pixels, so the images differ by a few pixels at the
      same scale. Resizing here would introduce a sub-pixel shift, so we
      centre-crop to the common size.

    * **Different export resolution** — one tool wrote a downscaled image.
      The framing matches but the scale does not, so centre-cropping would
      compare a zoomed crop against a full frame. Here we must *resize*.

    The two are distinguished by aspect ratio and relative size.
    """
    ha, wa = a.shape[:2]
    hb, wb = b.shape[:2]

    if (ha, wa) != (hb, wb):
        size_delta = max(abs(ha - hb) / max(ha, hb), abs(wa - wb) / max(wa, wb))
        aspect_a, aspect_b = wa / ha, wb / hb
        aspect_delta = abs(aspect_a - aspect_b) / max(aspect_a, aspect_b)

        if size_delta > _ACTIVE_AREA_TOLERANCE and aspect_delta <= _ACTIVE_AREA_TOLERANCE:
            # Same framing, different resolution: resize to the smaller.
            target = (min(wa, wb), min(ha, hb))
            a = _resize(a, target)
            b = _resize(b, target)
        else:
            # Same scale (or genuinely different framing): crop to common size.
            h, w = min(ha, hb), min(wa, wb)
            a = _center_crop(a, h, w)
            b = _center_crop(b, h, w)

    h, w = a.shape[:2]
    scale = long_edge / max(h, w)
    if scale < 1.0:
        size = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
        a = _resize(a, size)
        b = _resize(b, size)
    return a, b


def _resize(img: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    return np.asarray(Image.fromarray(img).resize(size, Image.LANCZOS))


def _center_crop(img: np.ndarray, h: int, w: int) -> np.ndarray:
    y = (img.shape[0] - h) // 2
    x = (img.shape[1] - w) // 2
    return img[y : y + h, x : x + w]


# ---------- comparison ----------

@dataclass
class Comparison:
    """viberoom vs one other renderer on one file."""

    sample: str
    other: str
    psnr: float
    ssim: float
    delta_e: float
    viberoom_shape: tuple[int, int]
    other_shape: tuple[int, int]
    mean_rgb_viberoom: tuple[float, float, float]
    mean_rgb_other: tuple[float, float, float]

    @property
    def shape_mismatch(self) -> bool:
        return self.viberoom_shape != self.other_shape


@dataclass
class CompareReport:
    results: list[Comparison] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    unavailable: list[str] = field(default_factory=list)

    def by_renderer(self, name: str) -> list[Comparison]:
        return [r for r in self.results if r.other == name]

    def summary(self) -> str:
        lines = []
        for name in sorted({r.other for r in self.results}):
            rs = self.by_renderer(name)
            lines.append(f"viberoom vs {name}  ({len(rs)} files)")
            lines.append(
                f"    PSNR {np.mean([r.psnr for r in rs]):6.2f} dB    "
                f"SSIM {np.mean([r.ssim for r in rs]):.4f}    "
                f"dE2000 {np.mean([r.delta_e for r in rs]):5.2f}"
            )
            for r in sorted(rs, key=lambda r: r.psnr):
                flag = "  [size mismatch]" if r.shape_mismatch else ""
                lines.append(
                    f"      {r.sample:<38} {r.psnr:6.2f} dB  dE {r.delta_e:5.2f}{flag}"
                )
            lines.append("")
        for name in self.unavailable:
            lines.append(f"unavailable: {name}")
        for err in self.errors:
            lines.append(f"error: {err}")
        return "\n".join(lines)


def compare_file(
    path: Path,
    others: list[Renderer],
    baseline: Renderer | None = None,
    long_edge: int = ANALYSIS_LONG_EDGE,
) -> tuple[list[Comparison], list[str]]:
    """Render one file with viberoom and each other renderer, and score."""
    baseline = baseline or ViberoomRenderer()
    results: list[Comparison] = []
    errors: list[str] = []

    try:
        ours = baseline.render(path)
    except Exception as exc:  # noqa: BLE001
        return [], [f"{path.name}: viberoom render failed: {type(exc).__name__}: {exc}"]

    for renderer in others:
        try:
            theirs = renderer.render(path)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{path.name}: {renderer.name} failed: {type(exc).__name__}: {exc}")
            continue

        a, b = align(ours, theirs, long_edge=long_edge)
        results.append(
            Comparison(
                sample=path.name,
                other=renderer.name,
                psnr=psnr(a, b),
                ssim=ssim(a, b),
                delta_e=mean_delta_e(a, b),
                viberoom_shape=tuple(ours.shape[:2]),
                other_shape=tuple(theirs.shape[:2]),
                mean_rgb_viberoom=tuple(float(a[..., i].mean()) for i in range(3)),
                mean_rgb_other=tuple(float(b[..., i].mean()) for i in range(3)),
            )
        )
    return results, errors


def run_comparison(
    files: list[Path],
    renderer_names: list[str],
    long_edge: int = ANALYSIS_LONG_EDGE,
    on_progress=None,
) -> CompareReport:
    """Compare viberoom against each named renderer over a list of files."""
    report = CompareReport()

    others: list[Renderer] = []
    for name in renderer_names:
        renderer = ALL_RENDERERS[name]()
        if renderer.available():
            others.append(renderer)
        else:
            report.unavailable.append(name)

    if not others:
        return report

    for i, path in enumerate(files, start=1):
        if on_progress:
            on_progress(i, len(files), path)
        results, errors = compare_file(path, others, long_edge=long_edge)
        report.results.extend(results)
        report.errors.extend(errors)
    return report
