"""Known image benchmarks, and plumbing to pair inputs with references.

Most of these datasets are tens to hundreds of gigabytes and are distributed
under licenses that require you to accept terms on the host's site, so this
module deliberately does not scrape them. It records what each one is good
for and how to get it, provides a checksummed downloader for the pieces that
are directly fetchable, and turns any local `inputs/` + `references/` folder
pair into something the runner can score.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from viberoom.config import IMAGE_EXTENSIONS


@dataclass(frozen=True)
class DatasetInfo:
    """A benchmark we know about, and what it exercises."""

    key: str
    name: str
    tests: str
    size: str
    license: str
    homepage: str
    notes: str


KNOWN_DATASETS: dict[str, DatasetInfo] = {
    d.key: d
    for d in [
        DatasetInfo(
            key="fivek",
            name="MIT-Adobe FiveK",
            tests="global tone & color grading; auto-enhance quality",
            size="~50 GB (RAW) / ~7 GB (tiff16 expert renditions)",
            license="research use; see site terms",
            homepage="https://data.csail.mit.edu/graphics/fivek/",
            notes=(
                "5,000 RAWs with 5 expert retouches each (a-e). Expert C is the "
                "conventional target. Download the tiff16_c set as references and "
                "the raw set as inputs, then pass both folders to `bench reference`."
            ),
        ),
        DatasetInfo(
            key="ppr10k",
            name="PPR10K",
            tests="portrait retouching; local masks on people",
            size="~40 GB",
            license="research use",
            homepage="https://github.com/csjliang/PPR10K",
            notes="11,161 portrait RAWs, 3 expert retouches each, plus human-region masks.",
        ),
        DatasetInfo(
            key="sid",
            name="See-in-the-Dark (SID)",
            tests="shadow recovery, extreme underexposure, color cast at high EV",
            size="~25 GB",
            license="research use",
            homepage="https://cchen156.github.io/SID.html",
            notes="Short/long exposure RAW pairs, Sony ARW and Fuji RAF.",
        ),
        DatasetInfo(
            key="sidd",
            name="SIDD (Smartphone Image Denoising)",
            tests="noise reduction quality",
            size="~30 GB (full) / ~1 GB (medium sRGB subset)",
            license="research use",
            homepage="https://abdokamel.github.io/sidd/",
            notes="Noisy/clean pairs. The 'SIDD-Medium sRGB' subset is the practical one.",
        ),
        DatasetInfo(
            key="dnd",
            name="Darmstadt Noise Dataset",
            tests="noise reduction on real sensor noise",
            size="~5 GB",
            license="research use; scoring via their server",
            homepage="https://noise.visinf.tu-darmstadt.de/",
            notes="No public ground truth — results are scored by submission.",
        ),
        DatasetInfo(
            key="raise",
            name="RAISE",
            tests="RAW decode across a real camera body",
            size="~8 TB (full) / subsets available",
            license="research use",
            homepage="http://loki.disi.unitn.it/RAISE/",
            notes="8,156 unprocessed NEF files. Use a subset; the full set is enormous.",
        ),
        DatasetInfo(
            key="pixls",
            name="raw.pixls.us",
            tests="decoder coverage across camera models and mosaics",
            size="a few MB per camera",
            license="CC0",
            homepage="https://raw.pixls.us/",
            notes=(
                "The best decoder smoke test: one sample per camera model, "
                "including X-Trans and Foveon files that break naive demosaic paths."
            ),
        ),
        DatasetInfo(
            key="hdrplus",
            name="HDR+ Burst Photography Dataset",
            tests="highlight recovery and shadow lifting",
            size="~150 GB (full) / ~35 GB (subset)",
            license="CC-BY-SA",
            homepage="https://hdrplusdata.org/",
            notes="3,640 bursts of RAW with merged references.",
        ),
    ]
}


def describe_datasets() -> str:
    """Human-readable catalog, used by `viberoom-bench datasets`."""
    lines = []
    for d in KNOWN_DATASETS.values():
        lines += [
            f"{d.key}  —  {d.name}",
            f"    tests    {d.tests}",
            f"    size     {d.size}",
            f"    license  {d.license}",
            f"    url      {d.homepage}",
            f"    notes    {d.notes}",
            "",
        ]
    return "\n".join(lines)


# ---------- pairing ----------

@dataclass(frozen=True)
class Pair:
    """One benchmark item: an input image and its reference rendition."""

    stem: str
    input_path: Path
    reference_path: Path


def _index_by_stem(folder: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for p in sorted(folder.rglob("*")):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS:
            out.setdefault(p.stem.lower(), p)
    return out


def discover_pairs(
    input_dir: Path, reference_dir: Path, limit: int | None = None
) -> list[Pair]:
    """Match inputs to references by filename stem, case-insensitively.

    FiveK-style layouts (`a0001-jmac_DSC1459.dng` next to
    `a0001-jmac_DSC1459.tif`) pair up directly. Unmatched files on either
    side are skipped rather than raising, so partial downloads still run.
    """
    input_dir, reference_dir = Path(input_dir), Path(reference_dir)
    for d in (input_dir, reference_dir):
        if not d.is_dir():
            raise NotADirectoryError(f"Not a directory: {d}")

    inputs = _index_by_stem(input_dir)
    references = _index_by_stem(reference_dir)
    pairs = [
        Pair(stem=stem, input_path=inputs[stem], reference_path=references[stem])
        for stem in sorted(inputs.keys() & references.keys())
    ]
    return pairs[:limit] if limit else pairs


# ---------- fetching ----------

def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while block := fh.read(chunk):
            h.update(block)
    return h.hexdigest()


def fetch(url: str, dest: Path, sha256: str | None = None, force: bool = False) -> Path:
    """Download `url` to `dest`, verifying an optional checksum.

    Skips the download when the file already exists and matches. Kept
    deliberately simple — it exists for the small, directly-linkable pieces
    (a chart shot, a handful of pixls.us samples), not for pulling FiveK.
    """
    import httpx

    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.exists() and not force:
        if sha256 is None or sha256_file(dest) == sha256:
            return dest

    tmp = dest.with_suffix(dest.suffix + ".part")
    with httpx.stream("GET", url, follow_redirects=True, timeout=60.0) as r:
        r.raise_for_status()
        with open(tmp, "wb") as fh:
            for block in r.iter_bytes(1 << 20):
                fh.write(block)

    if sha256 is not None:
        got = sha256_file(tmp)
        if got != sha256:
            tmp.unlink(missing_ok=True)
            raise ValueError(f"checksum mismatch for {url}: expected {sha256}, got {got}")

    tmp.replace(dest)
    return dest
