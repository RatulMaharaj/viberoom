"""The viberoom RAW test pack: a small, CC0, decoder-diverse sample set.

Every file comes from raw.pixls.us, which exists precisely so RAW software can
be tested against real files, and is CC0 — so unlike FiveK or PPR10K this pack
can be fetched without accepting terms, and results can be published.

Selection is by *decoder shape*, not by subject matter. Each entry covers a
mosaic layout, bit depth or compression scheme that has historically broken
naive RAW pipelines:

    X-Trans     6x6 non-Bayer mosaic (Fujifilm)
    Foveon      stacked full-color sensor, no demosaic at all (Sigma)
    CRAW        Canon's lossy compressed raw
    NEF 12-bit  compressed, non-14-bit path (Nikon)
    RW2/ORF     vendor formats with unusual black-level handling
    DNG         the Adobe interchange path, as written by a phone

Checksums are recorded so a partial or corrupted download is caught rather
than silently producing bogus benchmark numbers.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from viberoom.bench.datasets import fetch, sha256_file

BASE_URL = "https://raw.pixls.us/data"

DEFAULT_PACK_DIR = Path.home() / ".viberoom" / "benchpack"


@dataclass(frozen=True)
class Sample:
    """One RAW file in the pack."""

    key: str
    path: str  # path under BASE_URL, URL-encoded
    filename: str
    camera: str
    covers: str
    size_mb: int
    sha256: str | None = None

    @property
    def url(self) -> str:
        return f"{BASE_URL}/{self.path}"


SAMPLES: tuple[Sample, ...] = (
    Sample(
        key="fuji-xtrans",
        path="Fujifilm/X-T3/AFXT2720.RAF",
        filename="AFXT2720.RAF",
        camera="Fujifilm X-T3",
        covers="X-Trans 6x6 mosaic",
        size_mb=54,
    ),
    Sample(
        key="canon-craw",
        path="Canon/EOS%20R5/Canon_EOS_R5_CRAW_ISO_100_crop_nodual.CR3",
        filename="Canon_EOS_R5_CRAW_ISO_100_crop_nodual.CR3",
        camera="Canon EOS R5",
        covers="CR3 / CRAW lossy compression",
        size_mb=7,
    ),
    Sample(
        key="nikon-nef12",
        path="Nikon/Z%207/5-Nikon-Z7-RAW-12bit-compressed-L.NEF",
        filename="5-Nikon-Z7-RAW-12bit-compressed-L.NEF",
        camera="Nikon Z 7",
        covers="NEF 12-bit compressed",
        size_mb=40,
    ),
    Sample(
        key="sony-arw",
        path="Sony/ILCE-7RM4/DSC00396.ARW",
        filename="DSC00396.ARW",
        camera="Sony A7R IV",
        covers="ARW compressed Bayer",
        size_mb=59,
    ),
    Sample(
        key="olympus-orf",
        path="Olympus/E-M1MarkIII/_3160531.ORF",
        filename="_3160531.ORF",
        camera="Olympus E-M1 III",
        covers="ORF, 4/3 sensor black levels",
        size_mb=17,
    ),
    Sample(
        key="apple-dng",
        path="Apple/iPhone%2012%20Pro/IMG_1361.DNG",
        filename="IMG_1361.DNG",
        camera="Apple iPhone 12 Pro",
        covers="DNG as written by a phone",
        size_mb=28,
    ),
    Sample(
        key="sigma-foveon",
        path="Sigma/sd%20Quattro/sample3.X3F",
        filename="sample3.X3F",
        camera="Sigma sd Quattro",
        covers="Foveon X3, no demosaic",
        size_mb=56,
    ),
)

SAMPLES_BY_KEY = {s.key: s for s in SAMPLES}


def total_size_mb(samples: tuple[Sample, ...] = SAMPLES) -> int:
    return sum(s.size_mb for s in samples)


def pack_path(sample: Sample, dest: Path = DEFAULT_PACK_DIR) -> Path:
    return Path(dest) / sample.filename


def download_pack(
    dest: Path = DEFAULT_PACK_DIR,
    only: list[str] | None = None,
    force: bool = False,
    on_progress=None,
) -> list[Path]:
    """Fetch the pack (or a subset by key). Returns the local paths.

    Files already present with a matching checksum are skipped, so this is
    safe to re-run after an interrupted download.
    """
    dest = Path(dest).expanduser()
    dest.mkdir(parents=True, exist_ok=True)

    chosen = [s for s in SAMPLES if not only or s.key in only]
    if only:
        unknown = set(only) - SAMPLES_BY_KEY.keys()
        if unknown:
            raise KeyError(f"unknown sample key(s): {sorted(unknown)}")

    paths = []
    for i, sample in enumerate(chosen, start=1):
        target = pack_path(sample, dest)
        if on_progress:
            on_progress(i, len(chosen), sample)
        fetch(sample.url, target, sha256=sample.sha256, force=force)
        paths.append(target)
    return paths


def verify_pack(dest: Path = DEFAULT_PACK_DIR) -> list[tuple[Sample, str]]:
    """Check every present file decodes and matches its recorded checksum.

    Returns a list of (sample, problem) for anything wrong; empty means good.
    """
    import rawpy

    problems: list[tuple[Sample, str]] = []
    for sample in SAMPLES:
        target = pack_path(sample, dest)
        if not target.exists():
            problems.append((sample, "missing"))
            continue
        if sample.sha256 and sha256_file(target) != sample.sha256:
            problems.append((sample, "checksum mismatch"))
            continue
        try:
            with rawpy.imread(str(target)) as raw:
                raw.raw_image  # forces unpack, which is where truncation shows
        except Exception as exc:  # noqa: BLE001
            problems.append((sample, f"decode failed: {type(exc).__name__}: {exc}"))
    return problems


LAB_README = """# viberoom test lab

Point viberoom at this folder (`uv run viberoom`, then open this directory).

Everything here is CC0, so edits, screenshots and comparisons can be shared
freely. The RAW files are symlinks into the benchmark pack — your `.vibe.json`
sidecars are written *here*, next to the links, so the pack itself stays
pristine and you can wipe this folder without losing the downloads.

## What to try on each file

| File | Camera | Worth exercising |
|---|---|---|
{table}

## colorchecker.png

A synthetic 24-patch ColorChecker rendered from the reference sRGB values.
It is pixel-exact, so it is the one image here with an objectively correct
answer: with no edits it scores 0.00 dE2000. Edit it, then run

    uv run viberoom-bench chart --recipe <your-recipe>.json

to see precisely what your edit did to each patch. Useful for calibrating
what a given white-balance or saturation move actually costs in color terms.

## gradient.png

A smooth luminance ramp with a slight warm cast. Banding, posterization or
hue shifts introduced by tone curves and contrast show up here first — a
gradient is unforgiving in a way photographs are not.
"""


def create_lab(
    dest: Path,
    pack_dir: Path = DEFAULT_PACK_DIR,
    copy: bool = False,
) -> tuple[Path, int]:
    """Build a browsable folder to open in viberoom for hands-on editing.

    RAW files are symlinked from the pack by default so the ~260 MB is not
    duplicated; pass `copy=True` for a self-contained folder. Sidecars land
    in this folder either way.
    """
    import shutil

    import numpy as np
    from PIL import Image

    from viberoom.bench.chart import render_reference_chart

    dest = Path(dest).expanduser()
    dest.mkdir(parents=True, exist_ok=True)
    pack_dir = Path(pack_dir).expanduser()

    linked = 0
    rows = []
    for sample in SAMPLES:
        src = pack_path(sample, pack_dir)
        if not src.exists():
            continue
        target = dest / sample.filename
        if target.exists() or target.is_symlink():
            target.unlink()
        if copy:
            shutil.copy2(src, target)
        else:
            target.symlink_to(src)
        linked += 1
        rows.append(f"| `{sample.filename}` | {sample.camera} | {sample.covers} |")

    # A pixel-exact chart: the one image with an objectively correct answer.
    Image.fromarray(render_reference_chart(patch_px=96, gap_px=12)).save(
        dest / "colorchecker.png"
    )

    # A gradient, where tone-curve banding shows up before it does on photos.
    w, h = 1200, 400
    g = np.linspace(0.02, 0.98, w, dtype=np.float32)
    grad = np.broadcast_to(g[None, :, None], (h, w, 3)).copy()
    grad[..., 0] *= 1.06
    grad[..., 2] *= 0.94
    Image.fromarray((np.clip(grad, 0, 1) * 255).astype(np.uint8)).save(
        dest / "gradient.png"
    )

    (dest / "README.md").write_text(
        LAB_README.format(table="\n".join(rows) if rows else "| _(pack not downloaded)_ | | |")
    )
    return dest, linked


def describe_pack() -> str:
    lines = [f"viberoom RAW test pack — {len(SAMPLES)} files, ~{total_size_mb()} MB, all CC0", ""]
    for s in SAMPLES:
        lines.append(f"  {s.key:<15} {s.size_mb:>4} MB  {s.camera:<22} {s.covers}")
    lines += ["", f"source: {BASE_URL} (raw.pixls.us)"]
    return "\n".join(lines)
