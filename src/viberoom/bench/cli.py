"""`viberoom-bench` — command line entry point for the benchmark suite.

    viberoom-bench datasets
    viberoom-bench regress [--update]
    viberoom-bench perf [--update] [--size 3000x2000]
    viberoom-bench chart [--recipe r.json] [--image shot.dng --corners x,y,...]
    viberoom-bench reference --inputs raw/ --references expertC/ --strategy auto
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from viberoom.bench import chart as chart_mod
from viberoom.bench import regression
from viberoom.bench.datasets import describe_datasets, discover_pairs
from viberoom.bench.runner import resolve_strategy, run_reference_bench
from viberoom.engine.decode import _srgb_to_linear, decode_linear
from viberoom.engine.pipeline import render
from viberoom.recipe.schema import Recipe


def _load_recipe(spec: str | None) -> Recipe:
    if not spec:
        return Recipe()
    return Recipe.model_validate_json(Path(spec).expanduser().read_text())


# ---------- subcommands ----------

def cmd_datasets(args: argparse.Namespace) -> int:
    print(describe_datasets(), end="")
    return 0


def cmd_regress(args: argparse.Namespace) -> int:
    if args.update:
        data = regression.write_baseline(args.baseline)
        print(f"wrote {len(data)} cases to {args.baseline}")
        return 0

    if not Path(args.baseline).exists():
        print(f"no baseline at {args.baseline}; run with --update to create it", file=sys.stderr)
        return 2

    current = regression.compute_all()
    drifts, new_cases, stale = regression.compare(
        current, regression.load_baseline(args.baseline), tolerance=args.tolerance
    )

    for name in new_cases:
        print(f"NEW    {name} (not in baseline)")
    for name in stale:
        print(f"STALE  {name} (in baseline, no longer a case)")
    for d in drifts:
        print(f"DRIFT  {d}")

    if drifts:
        print(f"\n{len(drifts)} metric(s) drifted beyond {args.tolerance}", file=sys.stderr)
        return 1
    print(f"{len(current)} cases match baseline")
    return 0


def cmd_perf(args: argparse.Namespace) -> int:
    from viberoom.bench import perf

    # Defaults live in `perf`, not in the parser, so that importing this module
    # never pulls in `resource` (which does not exist on Windows).
    args.baseline = args.baseline or perf.BASELINE_PATH
    args.repeats = args.repeats or perf.REPEATS
    args.tolerance = perf.TOLERANCE if args.tolerance is None else args.tolerance
    args.mem_tolerance = perf.MEM_TOLERANCE if args.mem_tolerance is None else args.mem_tolerance

    try:
        h, w = perf.DEFAULT_SIZE
        size = perf.parse_size(args.size) if args.size else (h, w)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2

    def progress(i: int, n: int, case, sample) -> None:
        if not args.quiet:
            print(
                f"[{i}/{n}] {case.name:<28} {sample.seconds * 1000:8.1f} ms"
                f"  {sample.peak_mb:7.1f} MB",
                file=sys.stderr,
            )

    if args.update:
        data = perf.write_baseline(
            args.baseline, size=size, repeats=args.repeats, on_progress=progress
        )
        h, w = size
        print(f"wrote {len(data['cases'])} cases at {w}x{h} to {args.baseline}")
        return 0

    if not Path(args.baseline).exists():
        print(f"no baseline at {args.baseline}; run with --update to create it", file=sys.stderr)
        return 2

    baseline = perf.load_baseline(args.baseline)
    base_size = tuple(baseline.get("size", list(perf.DEFAULT_SIZE)))
    if base_size != size:
        bh, bw = base_size
        h, w = size
        print(
            f"baseline was measured at {bw}x{bh}, not {w}x{h}; "
            f"pass --size {bw}x{bh} or re-record with --update",
            file=sys.stderr,
        )
        return 2

    current = perf.compute_all(size, repeats=args.repeats, on_progress=progress)
    drifts, new_cases, stale = perf.compare(
        current, baseline["cases"], tolerance=args.tolerance, mem_tolerance=args.mem_tolerance
    )
    wins = perf.improvements(current, baseline["cases"], threshold=args.tolerance)

    for name in new_cases:
        print(f"NEW    {name} (not in baseline)")
    for name in stale:
        print(f"STALE  {name} (in baseline, no longer a case)")
    for d in wins:
        pct = (d.baseline - d.current) / d.baseline * 100
        print(f"FASTER {d.case}: {d.baseline * 1000:.1f} -> {d.current * 1000:.1f} ms (-{pct:.0f}%)")
    for d in drifts:
        pct = (d.current - d.baseline) / d.baseline * 100
        print(f"SLOWER {d.case}.{d.metric}: {d.baseline:.4f} -> {d.current:.4f} (+{pct:.0f}%)")

    if drifts:
        print(f"\n{len(drifts)} measurement(s) regressed beyond tolerance", file=sys.stderr)
        return 1
    if wins:
        print(f"\n{len(current)} cases within tolerance; {len(wins)} improved "
              f"— re-record with --update to lock the win in")
    else:
        print(f"{len(current)} cases within tolerance")
    return 0


def cmd_chart(args: argparse.Namespace) -> int:
    recipe = _load_recipe(args.recipe)

    if args.image:
        if not args.corners:
            print("--image requires --corners x1,y1,x2,y2,x3,y3,x4,y4", file=sys.stderr)
            return 2
        nums = [float(v) for v in args.corners.replace(" ", "").split(",")]
        if len(nums) != 8:
            print("--corners needs exactly 8 numbers (TL, TR, BR, BL)", file=sys.stderr)
            return 2
        linear = decode_linear(Path(args.image).expanduser())
        rendered = render(linear, recipe)
        sampled = chart_mod.sample_quad(rendered, np.array(nums).reshape(4, 2))
    else:
        srgb = chart_mod.render_reference_chart(args.patch_px, args.gap_px)
        linear = _srgb_to_linear(srgb.astype(np.float32) / 255.0).astype(np.float32)
        rendered = render(linear, recipe)
        sampled = chart_mod.sample_grid(rendered, args.patch_px, args.gap_px)

    result = chart_mod.score_patches(sampled)
    print(f"mean dE2000     {result.mean_delta_e:.3f}")
    print(f"max  dE2000     {result.max_delta_e:.3f}")
    print(f"neutrals dE2000 {result.neutral_delta_e:.3f}")
    print("worst patches:")
    for name, de in result.worst():
        print(f"    {name:<14} {de:.3f}")

    if args.max_delta_e is not None and result.mean_delta_e > args.max_delta_e:
        print(
            f"\nmean dE {result.mean_delta_e:.3f} exceeds --max-delta-e {args.max_delta_e}",
            file=sys.stderr,
        )
        return 1
    return 0


def cmd_pack(args: argparse.Namespace) -> int:
    from viberoom.bench import pack as pack_mod

    args.dir = Path(args.dir).expanduser() if args.dir else pack_mod.DEFAULT_PACK_DIR

    if args.list:
        print(pack_mod.describe_pack())
        return 0

    if args.verify:
        problems = pack_mod.verify_pack(args.dir)
        for sample, why in problems:
            print(f"BAD    {sample.key:<15} {sample.filename}: {why}")
        if problems:
            print(f"\n{len(problems)} problem(s)", file=sys.stderr)
            return 1
        print(f"all {len(pack_mod.SAMPLES)} files present, checksummed and decodable")
        return 0

    def progress(i: int, n: int, sample) -> None:
        print(f"[{i}/{n}] {sample.key} (~{sample.size_mb} MB) {sample.camera}", file=sys.stderr)

    paths = pack_mod.download_pack(
        args.dir, only=args.only, force=args.force, on_progress=progress
    )
    print(f"pack ready: {len(paths)} files in {Path(args.dir).expanduser()}")
    return 0


def cmd_auto(args: argparse.Namespace) -> int:
    from viberoom.bench import autobench
    from viberoom.bench import pack as pack_mod

    if args.files:
        files = [Path(f).expanduser() for f in args.files]
    else:
        pack_dir = Path(args.dir).expanduser() if args.dir else pack_mod.DEFAULT_PACK_DIR
        files = [
            pack_mod.pack_path(s, pack_dir)
            for s in pack_mod.SAMPLES
            if pack_mod.pack_path(s, pack_dir).exists()
        ]
    if not files:
        print("no files; run `viberoom-bench pack` or pass files", file=sys.stderr)
        return 2

    if args.strategy not in autobench.STRATEGIES:
        print(f"unknown strategy {args.strategy!r}", file=sys.stderr)
        return 2

    degradations = (
        autobench.CAST_DEGRADATIONS if args.strategy == "wb" else autobench.DEGRADATIONS
    )

    def progress(i: int, n: int, path: Path) -> None:
        if not args.quiet:
            print(f"[{i}/{n}] {path.name}", file=sys.stderr)

    report = autobench.run_auto_bench(
        files,
        degradations=degradations,
        recipe_for=autobench.STRATEGIES[args.strategy],
        strategy_name=args.strategy,
        on_progress=progress,
    )
    print(report.summary())
    if args.json:
        Path(args.json).write_text(report.to_json())
        print(f"\nwrote {args.json}")

    if args.require_improvement and report.helped_fraction < args.require_improvement:
        print(
            f"\nonly {report.helped_fraction:.0%} of cases improved, "
            f"below --require-improvement {args.require_improvement:.0%}",
            file=sys.stderr,
        )
        return 1
    return 0


def cmd_lab(args: argparse.Namespace) -> int:
    from viberoom.bench import pack as pack_mod

    dest, linked = pack_mod.create_lab(
        args.dest,
        pack_dir=Path(args.dir).expanduser() if args.dir else pack_mod.DEFAULT_PACK_DIR,
        copy=args.copy,
    )
    how = "copied" if args.copy else "linked"
    print(f"test lab ready: {dest}")
    print(f"  {linked} RAW files {how} from the pack, plus colorchecker.png and gradient.png")
    if not linked:
        print("  (no RAW files found — run `viberoom-bench pack` to download them)")
    print(f"\nOpen it with: uv run viberoom   then point the UI at {dest}")
    return 0


def cmd_compare(args: argparse.Namespace) -> int:
    from viberoom.bench import compare as cmp_mod
    from viberoom.bench import pack as pack_mod

    if args.files:
        files = [Path(f).expanduser() for f in args.files]
    else:
        pack_dir = Path(args.dir).expanduser() if args.dir else pack_mod.DEFAULT_PACK_DIR
        files = [
            pack_mod.pack_path(s, pack_dir)
            for s in pack_mod.SAMPLES
            if pack_mod.pack_path(s, pack_dir).exists()
        ]
    if not files:
        print(
            "no files to compare; run `viberoom-bench pack` first or pass files",
            file=sys.stderr,
        )
        return 2

    names = args.against or ["libraw"]
    for name in names:
        if name not in cmp_mod.ALL_RENDERERS:
            print(f"unknown renderer {name!r}", file=sys.stderr)
            return 2

    def progress(i: int, n: int, path: Path) -> None:
        if not args.quiet:
            print(f"[{i}/{n}] {path.name}", file=sys.stderr)

    report = cmp_mod.run_comparison(
        files, names, long_edge=args.long_edge, on_progress=progress
    )
    print(report.summary())

    if args.min_psnr is not None:
        bad = [r for r in report.results if r.psnr < args.min_psnr]
        if bad:
            print(
                f"\n{len(bad)} comparison(s) below --min-psnr {args.min_psnr}",
                file=sys.stderr,
            )
            return 1
    return 0


def cmd_reference(args: argparse.Namespace) -> int:
    pairs = discover_pairs(Path(args.inputs), Path(args.references), limit=args.limit)
    if not pairs:
        print("no input/reference pairs matched by filename stem", file=sys.stderr)
        return 2

    name, strategy = resolve_strategy(args.strategy)

    def progress(i: int, total: int, score) -> None:
        if not args.quiet:
            detail = f"{score.psnr:6.2f} dB  dE {score.delta_e:5.2f}" if score else "  skipped"
            print(f"[{i}/{total}] {pairs[i - 1].stem:<32} {detail}", file=sys.stderr)

    report = run_reference_bench(
        pairs, strategy, strategy_name=name, half_size=not args.full_size, on_progress=progress
    )

    print(report.summary())
    for line in report.skipped:
        print(f"skipped: {line}", file=sys.stderr)
    if args.json:
        Path(args.json).write_text(report.to_json())
        print(f"\nwrote {args.json}")
    return 0


# ---------- parser ----------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="viberoom-bench", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("datasets", help="list known image benchmarks").set_defaults(func=cmd_datasets)

    r = sub.add_parser("regress", help="run the synthetic golden regression suite")
    r.add_argument("--update", action="store_true", help="rewrite the baseline instead of checking")
    r.add_argument("--baseline", type=Path, default=regression.BASELINE_PATH)
    r.add_argument("--tolerance", type=float, default=regression.TOLERANCE)
    r.set_defaults(func=cmd_regress)

    pf = sub.add_parser("perf", help="time the regression cases at a realistic resolution")
    pf.add_argument("--update", action="store_true", help="rewrite the baseline instead of checking")
    pf.add_argument("--baseline", type=Path, default=None)
    pf.add_argument("--size", default=None, help="WIDTHxHEIGHT to render at (default 3000x2000)")
    pf.add_argument("--repeats", type=int, default=None, help="timed runs per case; best wins")
    pf.add_argument("--tolerance", type=float, default=None, help="relative slowdown allowed")
    pf.add_argument("--mem-tolerance", type=float, default=None, help="relative RSS growth allowed")
    pf.add_argument("--quiet", action="store_true")
    pf.set_defaults(func=cmd_perf)

    c = sub.add_parser("chart", help="score a ColorChecker through the pipeline")
    c.add_argument("--recipe", help="JSON recipe file to apply before scoring")
    c.add_argument("--image", help="photographed chart to score instead of the synthetic one")
    c.add_argument("--corners", help="with --image: x1,y1,x2,y2,x3,y3,x4,y4 (TL,TR,BR,BL)")
    c.add_argument("--patch-px", type=int, default=64)
    c.add_argument("--gap-px", type=int, default=8)
    c.add_argument("--max-delta-e", type=float, help="exit nonzero if mean dE exceeds this")
    c.set_defaults(func=cmd_chart)

    k = sub.add_parser("pack", help="download the CC0 RAW test pack")
    k.add_argument("--dir", default=None, help="where to keep the pack")
    k.add_argument("--only", nargs="*", help="sample keys to fetch (default: all)")
    k.add_argument("--list", action="store_true", help="show pack contents and exit")
    k.add_argument("--verify", action="store_true", help="checksum and decode every file")
    k.add_argument("--force", action="store_true", help="re-download even if present")
    k.set_defaults(func=cmd_pack)

    a = sub.add_parser("auto", help="measure auto-adjust by degrade-and-recover")
    a.add_argument("files", nargs="*", help="images (default: the whole test pack)")
    a.add_argument("--dir", default=None, help="pack directory")
    a.add_argument(
        "--strategy", default="wb",
        help="wb (fair pass/fail on colour casts) | auto (diagnostic only)",
    )
    a.add_argument("--json", help="write the full report here")
    a.add_argument(
        "--require-improvement", type=float,
        help="exit nonzero unless at least this fraction of cases improve (0-1)",
    )
    a.add_argument("--quiet", action="store_true")
    a.set_defaults(func=cmd_auto)

    lab = sub.add_parser("lab", help="build a folder of test images to open in viberoom")
    lab.add_argument(
        "dest", nargs="?", default=str(Path.home() / "Pictures" / "viberoom-lab"),
        help="where to create the lab folder",
    )
    lab.add_argument("--dir", default=None, help="pack directory to link from")
    lab.add_argument("--copy", action="store_true", help="copy files instead of symlinking")
    lab.set_defaults(func=cmd_lab)

    m = sub.add_parser("compare", help="compare viberoom's render against other software")
    m.add_argument("files", nargs="*", help="RAW files (default: the whole test pack)")
    m.add_argument("--dir", default=None, help="pack directory")
    m.add_argument(
        "--against", nargs="*", default=None,
        help="libraw (oracle for the no-op path) and/or darktable. Default: libraw",
    )
    m.add_argument("--long-edge", type=int, default=1024, help="analysis resolution")
    m.add_argument("--min-psnr", type=float, help="exit nonzero if any pair falls below this")
    m.add_argument("--quiet", action="store_true")
    m.set_defaults(func=cmd_compare)

    f = sub.add_parser("reference", help="score renders against expert-retouched references")
    f.add_argument("--inputs", required=True, help="folder of source images (RAW or otherwise)")
    f.add_argument("--references", required=True, help="folder of reference renditions")
    f.add_argument("--strategy", default="auto", help="noop | auto | fixed:<recipe.json>")
    f.add_argument("--limit", type=int, help="score at most this many pairs")
    f.add_argument("--full-size", action="store_true", help="decode RAW at full resolution")
    f.add_argument("--json", help="write the full report here")
    f.add_argument("--quiet", action="store_true")
    f.set_defaults(func=cmd_reference)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
