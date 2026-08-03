<p align="center">
  <img src="desktop/icons-src/icon.png" width="96" alt="Viberoom" />
</p>

<h1 align="center">Viberoom</h1>

<p align="center"><em>Lightroom, minus the sliders. Your photos, developed by agents.</em></p>

Viberoom is a RAW photo manager and non-destructive editor where **the editing UI
is an AI agent**. You browse, rate, and flag in a web (or desktop) library —
then tell Claude Code *"reject the blurry ones, warm up the sunsets, export the
picks"* and it happens through MCP, REST, or plain JSON sidecar files.

- 🧾 **Non-destructive, always.** Every edit is a readable `photo.CR3.vibe.json`
  next to the original. Delete the sidecar, get your pixels back.
- 📷 **Real RAW.** LibRaw decoding (CR2/CR3, NEF, ARW, RAF, DNG, …) plus
  JPEG/PNG/TIFF/HEIC.
- 🎛️ **The whole develop kit.** WB, tone, curves, HSL, color grading, LUTs,
  sharpening/NR, lens & perspective corrections, heal/clone, grain — and local
  masks: gradients, luminance/color ranges, brushes, AI subject/sky masks.
- 🗂️ **DAM things.** Ratings, flags, labels, keywords, collections (smart too),
  stacks, dupes, history, snapshots, virtual copies, multi-folder catalogs.
- 📥 **In and out.** Card ingest, tethered capture, HDR & pano merge, ML
  enhance (`viberoom[ml]`), XMP interop, batch everything, color-managed
  export (sRGB → ProPhoto) with watermarks and soft proofing.

## Quick start

```bash
uv sync
npm --prefix frontend install && npm --prefix frontend run build

uv run viberoom        # UI + API → http://127.0.0.1:8423
```

Open it, point it at a folder of photos. That's it.

Other ways to run:

```bash
uv run dev             # hacking: backend --reload + Vite (:7666 "ROOM" → :8423 "VIBE")
uv run dev-desktop     # the desktop app, dev mode
uv run build-desktop   # installers: .dmg / .msi / .AppImage — see desktop/README.md
```

## Let an agent drive

```bash
claude mcp add viberoom -- uv --directory /path/to/viberoom run viberoom-mcp
```

~45 tools, from `list_images` to `update_recipe` (the workhorse merge-patch) to
`render_preview` — which returns the rendered image, so the agent can *look at
its own edits* and iterate. Then just talk:

> "Open ~/Photos/shoot-42, reject anything blurry, rate the keepers, warm the
> sunset shots by 500K with +0.3 EV, and export all picks at quality 85."

Prefer HTTP? Everything is REST under `/api/v1` (docs at `/api/v1/docs`):

```bash
curl 'localhost:8423/api/v1/images?rating_gte=4&flag=pick'
curl -X PATCH localhost:8423/api/v1/images/<id>/recipe \
  -d '{"tone": {"exposure": 0.5}}' -H 'Content-Type: application/json'
```

Prefer files? Edit the `.vibe.json` sidecar directly and `POST /library/scan`:

```json
{
  "rating": 4,
  "flag": "pick",
  "recipe": {
    "whiteBalance": { "temp": 6500 },
    "tone": { "exposure": 0.5, "clarity": 15 },
    "masks": [{ "type": "radial", "center": [0.5, 0.4], "radiusX": 0.3,
                "radiusY": 0.25, "adjustments": { "exposure": 0.6 } }]
  }
}
```

The full recipe grammar (every param, range, and the pipeline order) is one
call away: `GET /api/v1/recipe/schema` — or the `get_recipe_schema` MCP tool.
The math is Lightroom-*like*, not a clone.

## Is it actually correct? (benchmarks)

`viberoom-bench` keeps the pipeline honest, cheapest check first:

```bash
uv run viberoom-bench regress    # 26 recipes vs a pinned baseline; the CI gate.
                                 #   catches a 0.5% exposure drift in <1s
uv run viberoom-bench chart      # 24 ColorChecker patches, mean dE2000
uv run viberoom-bench pack       # ~260 MB CC0 RAW pack (X-Trans, Foveon, CRAW…)
uv run viberoom-bench compare --against libraw darktable
uv run viberoom-bench reference --inputs raw/ --references expertC/
```

`compare` treats **libraw as an oracle** (a no-op render must match its neutral
decode: 53–55 dB PSNR on Bayer) and **darktable as a reference** (different
rendering philosophy, so dE 5–14 means "same neighbourhood", not "bug").
`reference` scores auto-adjust against expert retouches — if `auto` isn't
beating `noop`, it's making things worse. `viberoom-bench datasets` lists
where the big datasets live and what each one proves.

## Development

```bash
uv run pytest                     # backend
npm --prefix frontend run build   # frontend typecheck + build
```

State lives in `<library>/.viberoom/` — a disposable SQLite index (sidecars are
the source of truth) and the preview cache. Exports land in `<library>/exports/`.
