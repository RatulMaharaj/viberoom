"""Tests for the test pack and the cross-software comparison harness.

The unit tests here never touch the network or the external binaries. The
integration tests skip themselves unless the pack has been downloaded and
the relevant tool is installed, so a clean checkout still runs green.
"""

import numpy as np
import pytest
from PIL import Image

from viberoom.bench import compare as cmp_mod
from viberoom.bench.metrics import psnr
from viberoom.bench import pack as pack_mod
from viberoom.bench.compare import (
    ALL_RENDERERS,
    Comparison,
    CompareReport,
    DarktableRenderer,
    LibRawRenderer,
    ViberoomRenderer,
    _center_crop,
    align,
)


# ---------- pack manifest ----------

def test_pack_keys_are_unique():
    keys = [s.key for s in pack_mod.SAMPLES]
    assert len(keys) == len(set(keys))


def test_pack_filenames_are_unique():
    """Files land in one flat directory, so a collision would silently
    overwrite one sample with another."""
    names = [s.filename for s in pack_mod.SAMPLES]
    assert len(names) == len(set(names))


def test_pack_urls_are_well_formed():
    for s in pack_mod.SAMPLES:
        assert s.url.startswith("https://raw.pixls.us/data/")
        assert " " not in s.url, f"{s.key}: URL must be percent-encoded"
        assert s.url.endswith(s.filename.replace(" ", "%20"))


def test_pack_covers_the_hard_mosaics():
    covers = " ".join(s.covers.lower() for s in pack_mod.SAMPLES)
    for needle in ("x-trans", "foveon", "dng"):
        assert needle in covers


def test_pack_sizes_are_plausible():
    for s in pack_mod.SAMPLES:
        assert 1 <= s.size_mb <= 200
    assert pack_mod.total_size_mb() < 400  # keep the pack downloadable


def test_download_pack_rejects_unknown_key(tmp_path):
    with pytest.raises(KeyError, match="unknown sample key"):
        pack_mod.download_pack(tmp_path, only=["not-a-camera"])


def test_describe_pack_mentions_every_sample():
    text = pack_mod.describe_pack()
    for s in pack_mod.SAMPLES:
        assert s.key in text


def test_verify_pack_reports_missing_files(tmp_path):
    problems = pack_mod.verify_pack(tmp_path)
    assert len(problems) == len(pack_mod.SAMPLES)
    assert all(why == "missing" for _, why in problems)


# ---------- alignment ----------

def test_align_center_crops_mismatched_shapes():
    a = np.zeros((100, 200, 3), dtype=np.uint8)
    b = np.zeros((96, 190, 3), dtype=np.uint8)
    ra, rb = align(a, b, long_edge=10_000)  # no downscale
    assert ra.shape == rb.shape == (96, 190, 3)


def test_align_resizes_when_scale_differs_but_framing_matches():
    """A downscaled export must be resized, not centre-cropped — cropping
    would compare a zoomed crop against a full frame."""
    full = np.zeros((3000, 4000, 3), dtype=np.uint8)
    small = np.zeros((1500, 2000, 3), dtype=np.uint8)
    ra, rb = align(full, small, long_edge=10_000)
    assert ra.shape == rb.shape == (1500, 2000, 3)


def test_align_resize_path_preserves_content():
    """The real regression: a downscale of an image must still score as
    near-identical to the original, not as a different picture."""
    rng = np.random.default_rng(3)
    base = rng.integers(0, 255, (600, 800, 3), dtype=np.uint8)
    base = np.asarray(Image.fromarray(base).resize((800, 600), Image.LANCZOS))
    half = np.asarray(Image.fromarray(base).resize((400, 300), Image.LANCZOS))
    ra, rb = align(base, half, long_edge=10_000)
    assert ra.shape == rb.shape
    assert psnr(ra, rb) > 20.0, "downscale-vs-original should align, not misregister"


def test_align_crops_when_only_active_area_differs():
    """A few pixels of border disagreement must be cropped, not resized."""
    a = np.zeros((4000, 6000, 3), dtype=np.uint8)
    b = np.zeros((3998, 5994, 3), dtype=np.uint8)
    ra, rb = align(a, b, long_edge=10_000)
    assert ra.shape == rb.shape == (3998, 5994, 3)


def test_align_downscales_to_long_edge():
    a = np.zeros((1000, 2000, 3), dtype=np.uint8)
    ra, rb = align(a, a.copy(), long_edge=100)
    assert max(ra.shape[:2]) == 100
    assert ra.shape == rb.shape


def test_align_leaves_small_images_alone():
    a = np.zeros((50, 60, 3), dtype=np.uint8)
    ra, _ = align(a, a.copy(), long_edge=1024)
    assert ra.shape == (50, 60, 3)


def test_center_crop_takes_the_middle():
    img = np.arange(100, dtype=np.uint8).reshape(10, 10, 1).repeat(3, axis=2)
    out = _center_crop(img, 4, 4)
    assert out.shape == (4, 4, 3)
    assert out[0, 0, 0] == img[3, 3, 0]


def test_align_preserves_identical_content():
    rng = np.random.default_rng(0)
    a = rng.integers(0, 255, (200, 300, 3), dtype=np.uint8)
    ra, rb = align(a, a.copy(), long_edge=128)
    np.testing.assert_array_equal(ra, rb)


# ---------- renderer plumbing ----------

def test_renderer_registry_names_match_classes():
    for name, cls in ALL_RENDERERS.items():
        assert cls().name == name


def test_availability_checks_never_raise():
    for cls in ALL_RENDERERS.values():
        assert isinstance(cls().available(), bool)


def test_viberoom_renderer_is_always_available():
    assert ViberoomRenderer().available()


def test_compare_file_reports_error_for_undecodable_input(tmp_path):
    bad = tmp_path / "not_a_raw.CR2"
    bad.write_bytes(b"definitely not a raw file")
    results, errors, unsupported = cmp_mod.compare_file(bad, [LibRawRenderer()])
    assert not results
    assert not unsupported
    assert len(errors) == 1 and "viberoom render failed" in errors[0]


@pytest.mark.parametrize(
    "message,expected",
    [
        ("No decoder found. Sorry.", "no decoder found"),
        ("Unsupported predictor mode: 7", "unsupported predictor"),
        ("`x.X3F': Unsupported file format or not RAW file", "unsupported file format"),
        ("could not export to file", None),
        ("Segmentation fault", None),
        ("", None),
    ],
)
def test_classify_failure_separates_unsupported_from_broken(message, expected):
    assert cmp_mod._classify_failure(message) == expected


def test_unsupported_format_is_not_counted_as_an_error(tmp_path, monkeypatch):
    """A format the other tool cannot decode must not read as a failure on
    every run — there is nothing on our side to fix."""
    img = tmp_path / "x.DNG"
    img.write_bytes(b"stub")

    monkeypatch.setattr(ViberoomRenderer, "render", lambda self, p: np.zeros((8, 8, 3), np.uint8))

    def unsupported(self, p):
        raise cmp_mod.UnsupportedFormat("darktable cannot decode DNG (unsupported predictor)")

    monkeypatch.setattr(DarktableRenderer, "render", unsupported)
    monkeypatch.setattr(DarktableRenderer, "available", lambda self: True)

    report = cmp_mod.run_comparison([img], ["darktable"])
    assert not report.errors
    assert not report.results
    assert len(report.unsupported) == 1
    sample, renderer, reason = report.unsupported[0]
    assert sample == "x.DNG" and renderer == "darktable" and "predictor" in reason
    assert "viberoom renders these fine" in report.summary()


def test_run_comparison_records_unavailable_renderers(tmp_path, monkeypatch):
    monkeypatch.setattr(LibRawRenderer, "available", lambda self: False)
    report = cmp_mod.run_comparison([tmp_path / "nope.CR2"], ["libraw"])
    assert report.unavailable == ["libraw"]
    assert not report.results


def test_report_summary_flags_size_mismatch():
    report = CompareReport(
        results=[
            Comparison(
                sample="a.CR3", other="libraw", psnr=40.0, ssim=0.99, delta_e=0.5,
                viberoom_shape=(100, 100), other_shape=(98, 100),
                mean_rgb_viberoom=(1, 2, 3), mean_rgb_other=(1, 2, 3),
            )
        ]
    )
    assert "size mismatch" in report.summary()


def test_comparison_shape_mismatch_property():
    kw = dict(
        sample="a", other="libraw", psnr=1.0, ssim=1.0, delta_e=0.0,
        mean_rgb_viberoom=(0, 0, 0), mean_rgb_other=(0, 0, 0),
    )
    assert not Comparison(viberoom_shape=(10, 10), other_shape=(10, 10), **kw).shape_mismatch
    assert Comparison(viberoom_shape=(10, 10), other_shape=(10, 9), **kw).shape_mismatch


# ---------- integration (skipped unless the pack and tools are present) ----------

def _pack_files():
    return [
        pack_mod.pack_path(s)
        for s in pack_mod.SAMPLES
        if pack_mod.pack_path(s).exists()
    ]


needs_pack = pytest.mark.skipif(not _pack_files(), reason="test pack not downloaded")
needs_libraw = pytest.mark.skipif(
    not LibRawRenderer().available(), reason="dcraw_emu not installed"
)


@needs_pack
def test_every_downloaded_sample_decodes():
    problems = [
        (s, why) for s, why in pack_mod.verify_pack() if why != "missing"
    ]
    assert not problems, f"pack files are broken: {problems}"


#: Bayer-sensor samples, where rawpy and dcraw_emu agree to ~53 dB. These
#: are the strict correctness check on viberoom's decode path.
BAYER_SAMPLES = ("canon-craw", "nikon-nef12", "sony-arw", "apple-dng")

#: Measured 2026-08-03: X-Trans lands at ~32 dB and Olympus ORF at ~41 dB
#: against dcraw_emu. This is NOT a viberoom bug — it was traced to rawpy's
#: `use_camera_wb` and dcraw_emu's `-w` resolving camera white balance
#: differently inside LibRaw itself. It is verified independent of demosaic
#: algorithm, gamma path, embedded colour matrix and explicit WB multipliers.
#: The bound exists to catch a *regression*, not to bless the gap.
KNOWN_TOOL_GAP = {"fuji-xtrans": 28.0, "olympus-orf": 37.0}


@needs_pack
@needs_libraw
@pytest.mark.parametrize("key", BAYER_SAMPLES)
def test_noop_render_matches_libraw_oracle_on_bayer(key):
    """viberoom decodes through LibRaw, so a no-op render must agree closely
    with LibRaw's own neutral output. This is the tightest correctness check
    we have on the decode path."""
    sample = pack_mod.SAMPLES_BY_KEY[key]
    path = pack_mod.pack_path(sample)
    if not path.exists():
        pytest.skip(f"{key} not downloaded")

    report = cmp_mod.run_comparison([path], ["libraw"], long_edge=512)
    assert report.results, f"no comparisons ran: {report.errors}"
    r = report.results[0]
    assert r.psnr > 45.0, f"{key}: only {r.psnr:.1f} dB vs LibRaw"
    assert r.delta_e < 1.0, f"{key}: dE {r.delta_e:.2f} vs LibRaw"


@needs_pack
@needs_libraw
@pytest.mark.parametrize("key", sorted(KNOWN_TOOL_GAP))
def test_non_bayer_divergence_does_not_get_worse(key):
    """X-Trans and ORF diverge from dcraw_emu for reasons inside LibRaw, not
    inside viberoom. Pin the current level so a real regression still shows."""
    sample = pack_mod.SAMPLES_BY_KEY[key]
    path = pack_mod.pack_path(sample)
    if not path.exists():
        pytest.skip(f"{key} not downloaded")

    report = cmp_mod.run_comparison([path], ["libraw"], long_edge=512)
    assert report.results, f"no comparisons ran: {report.errors}"
    r = report.results[0]
    assert r.psnr > KNOWN_TOOL_GAP[key], f"{key}: regressed to {r.psnr:.1f} dB"
