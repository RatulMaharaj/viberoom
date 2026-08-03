# Viberoom

> Agent-driven RAW photo manager and non-destructive editor — Lightroom-style library and develop tools, controlled by AI agents via MCP and REST.

A developer-focused, agent-driven photo manager and RAW editor. Think Lightroom's
library, minus the editing UI — **all edits are made by agents** (Claude Code,
Codex, …) through a REST API, MCP tools, or by writing JSON sidecar files directly.

- **Non-destructive by design**: originals are never modified. Every edit lives in a
  readable `<file>.vibe.json` sidecar next to the image. Delete the sidecar → back to
  the original.
- **Native RAW**: decoding via rawpy/LibRaw (CR2/CR3, NEF, ARW, RAF, DNG, …), plus
  JPEG/PNG/TIFF/HEIC via Pillow.
- **A full develop toolkit**: WB, tone, tone curves (luma + per-channel RGB),
  texture/clarity/dehaze, HSL, three-way color grading, LUTs (.cube),
  sharpening, noise reduction, lens corrections (distortion/vignetting/CA/
  defringe), perspective correction, vignette, grain, heal/clone retouching —
  and **local adjustments** via linear/radial gradients, luminance/color
  range masks, painted brush strokes, and AI subject/background/sky masks.
- **Organize like a DAM**: ratings, pick/reject flags, color labels, keywords,
  collections (static + smart), stacks, duplicate detection, edit history/
  snapshots, virtual copies, and filtering by rating/flag/label/keyword/
  camera/lens/ISO/date/filename/folder/GPS/faces. Catalogs can span
  multiple folders on any drive.
- **Import & capture**: card ingest with rename templates, dedupe, backup and
  apply-on-import; tethered capture via gphoto2; HDR exposure fusion and
  panorama merge; optional ML denoise/super-resolution and face detection
  (`viberoom[ml]`).
- **Interop**: reads Lightroom-family .xmp sidecars at scan time, writes XMP,
  IPTC metadata embedded in exports.
- **Presets & batch**: develop presets, export presets, batch recipe sync,
  batch metadata, batch export with filename templates.
- **Full web UI**: browse and organize a local folder, star-rate (0–5), flag
  pick/reject, and develop images with the complete toolset — tone, colour,
  HSL, grading, optics, effects, masks, LUTs, history and snapshots. Everything
  the API can do is reachable from the interface, and vice versa.
- **Claude Code in the sidebar**: if a local `claude` install is detected, the
  robot icon opens a real Claude Code session wired to this library, with a
  model / effort / permission picker and approve-deny prompts for tool use.
- **Export** to JPEG/TIFF or PNG (8/16-bit) in sRGB, Display P3, Adobe RGB or
  ProPhoto (generated ICC embedded), with watermarking, output sharpening
  and soft proofing.

## Quick start

```bash
uv sync
(cd frontend && npm install && npm run build)

uv run viberoom            # serves UI + API on http://127.0.0.1:8423
```

Open http://127.0.0.1:8423, point it at a photo folder. For frontend dev:
`cd frontend && npm run dev` (UI on :7666 "ROOM", proxies /api to :8423 "VIBE").

## Agent control

### MCP (recommended)

```bash
claude mcp add --transport http viberoom http://127.0.0.1:8423/mcp
```

The MCP server is mounted on the viberoom server itself, so it's just a URL —
no paths to keep in sync. The REST server must be running. ~45 tools; highlights: `set_library`,
`library_roots`, `import_photos`, `list_images` (filter by rating/flag/label/
keyword/camera/lens/ISO/date/filename/folder/collection/GPS/faces/stacks),
`get_image`, `set_rating`, `set_flag`, `set_label`, `edit_keywords`,
`set_iptc`, `write_xmp`, `collections`, `auto_stack`, `stack`,
`find_duplicates`, `get_recipe`, `update_recipe` (merge-patch — the
workhorse), `set_recipe`, `reset_recipe`, `auto_adjust`, `set_crop_aspect`,
`render_preview` (returns the rendered image so the agent can *see* its
edits), `soft_proof`, `get_history`, `restore_history`, `snapshot`, `variant`,
`luts`, `list_presets`, `save_preset`, `apply_preset`, `export_image`,
`batch_update_recipe`, `batch_set_meta`, `batch_export`, `export_presets`,
`merge_images` (HDR/pano), `enhance_image` (ML), `scan_faces`, `map_points`,
`tether`, `get_recipe_schema`.

Example session: *"open ~/Photos/shoot-42, reject anything blurry, rate the keepers,
warm up the sunset shots by 500K with +0.3 EV, then export all picks at quality 85."*

### REST

Everything lives under `/api/v1` (interactive docs at `/api/v1/docs`):

```bash
curl -X POST localhost:8423/api/v1/library -d '{"path": "~/Photos/shoot"}' -H 'Content-Type: application/json'
curl 'localhost:8423/api/v1/images?rating_gte=4&flag=pick'
curl -X PATCH localhost:8423/api/v1/images/<id>/recipe \
  -d '{"tone": {"exposure": 0.5}, "whiteBalance": {"temp": 6500}}' -H 'Content-Type: application/json'
curl 'localhost:8423/api/v1/images/<id>/preview?size=1600' -o preview.jpg
curl -X POST localhost:8423/api/v1/images/<id>/export -d '{"quality": 85}' -H 'Content-Type: application/json'
```

Batch endpoints take a list of ids: `POST /batch/recipe` (sync one merge-patch
onto many images), `POST /batch/meta` (rating/flag/label/keywords), and
`POST /batch/export`. Presets live under `/presets`:

```bash
curl -X PUT localhost:8423/api/v1/presets/warm-film \
  -d '{"patch": {"tone": {"contrast": 15}, "effects": {"grain": {"amount": 25}}}}' \
  -H 'Content-Type: application/json'
curl -X POST localhost:8423/api/v1/presets/warm-film/apply \
  -d '{"image_ids": ["<id>", "<id>"]}' -H 'Content-Type: application/json'
```

### Sidecar files

Agents may also edit `IMG_1234.CR3.vibe.json` directly, then `POST /library/scan`:

```json
{
  "version": 1,
  "rating": 4,
  "flag": "pick",
  "label": "green",
  "keywords": ["sunset", "shoot-42"],
  "recipe": {
    "whiteBalance": { "temp": 6500, "tint": 0 },
    "tone": { "exposure": 0.5, "contrast": 10, "clarity": 15 },
    "masks": [
      { "type": "radial", "center": [0.5, 0.4], "radiusX": 0.3, "radiusY": 0.25,
        "adjustments": { "exposure": 0.6 } }
    ]
  }
}
```

## Recipe parameters (Lightroom-style)

`GET /api/v1/recipe/schema` returns the full JSON Schema. Summary:

| Group | Params | Range |
|---|---|---|
| whiteBalance | temp (K), tint | 2000–50000 (null = as-shot), −150..150 |
| tone | exposure (EV) | −5..+5 |
| | contrast, highlights, shadows, whites, blacks | −100..100 |
| | texture, clarity, dehaze | −100..100 |
| | toneCurve.points / .red / .green / .blue | [in, out] pairs, 0–255 |
| color | saturation, vibrance | −100..100 |
| | hsl.{red…magenta}.{hue,saturation,luminance} | −100..100 |
| | grading.{shadows,midtones,highlights} {hue, saturation, luminance} | 0–360, 0–100, −100..100 |
| | grading.blending / grading.balance | 0–100 / −100..100 |
| detail | sharpening {amount, radius, detail} | 0–150, 0.5–3, 0–100 |
| | noiseReduction {luminance, color} | 0–100 |
| geometry | rotate, orientation, flipH/V | −45..45°, 0/90/180/270 |
| | crop {left, top, right, bottom} | 0–1 normalized |
| effects | vignette {amount, midpoint, feather, roundness} | −100..100, 0–100, 0–100, −100..100 |
| | grain {amount, size} | 0–100 |
| masks[] | linear {start, end} · radial {center, radiusX/Y, feather} | coords 0–1 in the rendered frame |
| | luminance {lumMin, lumMax, feather} · color {hue, range} | 0–100 · 0–360, 5–180 |
| | brush {strokes: [{points, radius, feather, flow, erase}]} | radius 0–0.5 of short side |
| | each mask: invert, opacity, adjustments {exposure, contrast, highlights, shadows, temp, tint, saturation, clarity, dehaze, sharpness} | EV −5..5, rest −100..100 |
| retouch[] | {mode: heal\|clone, source, dest, radius, feather, opacity} | coords 0–1, radius 0–0.25 of short side |

Pipeline order: WB → exposure → highlights/shadows/whites/blacks (linear light) →
contrast → tone curve (luma, then R/G/B) → HSL/saturation → color grading →
dehaze/clarity/texture → NR → sharpen → geometry → local masks → vignette/grain.
Masks and effects run post-crop, so mask coordinates are normalized to the
rendered frame an agent sees in a preview. Tone/WB math is Lightroom-*like*,
not a clone.

Develop presets are named recipe merge-patches stored in `~/.viberoom/presets/`,
shared across libraries.

## Benchmarks

`viberoom-bench` scores the render pipeline. Layers, cheapest first.

**Test pack & lab** — a 7-file, ~260 MB, all-CC0 RAW set from raw.pixls.us,
chosen by decoder shape rather than subject: X-Trans, Foveon, CRAW, 12-bit
NEF, ORF, and a phone DNG. Checksummed, so a truncated download is caught
instead of silently skewing results.

```bash
uv run viberoom-bench pack            # download (~260 MB)
uv run viberoom-bench pack --verify   # checksum + decode every file
uv run viberoom-bench lab             # build ~/Pictures/viberoom-lab to open in the UI
```

`lab` symlinks the pack into a folder alongside a pixel-exact ColorChecker
and a gradient, so sidecars land there and the pack stays pristine.

**Compare** — render the same RAW through viberoom and other software.

```bash
uv run viberoom-bench compare --against libraw darktable
```

The two comparisons mean different things and should not be conflated:

- **libraw** (`dcraw_emu`) is an *oracle*. viberoom decodes through LibRaw, so
  a no-op render must match LibRaw's neutral output. Bayer sensors land at
  53–55 dB PSNR / dE 0.3–0.4, which is the correctness check on the decode
  path. X-Trans (~32 dB) and ORF (~41 dB) diverge more; this was traced to
  rawpy's `use_camera_wb` and dcraw_emu's `-w` resolving camera white balance
  differently *inside LibRaw* — independent of demosaic, gamma, colour matrix
  and explicit multipliers. It is not a viberoom bug, and the tests pin it so
  a real regression still surfaces.
- **darktable** is a *reference*, not an oracle. It applies its own
  scene-referred workflow by default, so dE 5–14 against a no-op viberoom
  render is a difference in rendering philosophy, not an error. It answers
  "are we in the same neighbourhood as a mature processor", nothing more.

**Regression** — synthetic scenes through 26 fixed recipes, compared to a
checked-in baseline. No downloads, runs in well under a second, and catches
sub-visible drift (a 0.5% exposure change fails it). This is the CI gate.

```bash
uv run viberoom-bench regress            # check
uv run viberoom-bench regress --update   # re-baseline after an intended change
```

Re-baselining is a deliberate act: read the reported drift first, then commit
`tests/data/bench_baseline.json` in the same change as the code.

**Chart** — 24 ColorChecker patches scored as mean dE2000. The fastest way to
catch a white-balance or color-matrix bug; the gray ramp is reported
separately because it moves first.

```bash
uv run viberoom-bench chart --recipe my.json --max-delta-e 2.0
uv run viberoom-bench chart --image chart.cr2 --corners 120,80,980,92,975,690,115,678
```

**Reference** — renders against expert retouches (FiveK, PPR10K, ...), scored
with PSNR / SSIM / dE2000. Pair by filename stem; unmatched or undecodable
files are skipped, not fatal.

```bash
uv run viberoom-bench reference --inputs raw/ --references expertC/ \
    --strategy auto --limit 200 --json report.json
```

Strategies are `noop` (what does a bare decode score?), `auto`
(`compute_auto_recipe`), and `fixed:<recipe.json>`. Compare `auto` against
`noop` — if auto isn't beating a bare decode, it's making things worse.

`uv run viberoom-bench datasets` lists the known benchmarks, what each one
actually tests, and where to get it. None are downloaded automatically; they
are large and most require accepting terms on the host's site.

## Development

```bash
uv run pytest          # backend tests
cd frontend && npm run build
```

State: SQLite index at `<library>/.viberoom/catalog.db` (disposable — sidecars are
the source of truth), preview cache at `<library>/.viberoom/cache/`, exports default
to `<library>/exports/`.
