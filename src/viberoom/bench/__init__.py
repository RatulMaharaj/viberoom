"""Benchmarking: score the render pipeline against reference images.

Three layers, cheapest first:

  regression  synthetic scenes + fixed recipes, scored against a checked-in
              baseline. No downloads, runs in CI, fails on pipeline drift.
  chart       ColorChecker patches -> dE2000 against known sRGB values.
              Catches white-balance and color-matrix errors precisely.
  reference   a folder of inputs + a folder of expert-retouched references
              (FiveK, PPR10K, ...) scored with PSNR/SSIM/dE2000.

The metrics live in `metrics`, dataset plumbing in `datasets`, and the
`viberoom-bench` CLI ties them together.
"""

from viberoom.bench.metrics import delta_e_2000, psnr, srgb_to_lab, ssim
from viberoom.bench.runner import BenchReport, ImageScore, score_pair, run_reference_bench

__all__ = [
    "BenchReport",
    "ImageScore",
    "delta_e_2000",
    "psnr",
    "run_reference_bench",
    "score_pair",
    "srgb_to_lab",
    "ssim",
]
