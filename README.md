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
- **Web UI for library management only**: browse a local folder, star-rate (0–5),
  flag pick/reject, view rendered previews and recipes. No sliders.
- **Export** to sRGB JPEG with quality and resize control.

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
claude mcp add viberoom -- uv --directory /path/to/viberoom run viberoom-mcp
```

The REST server must be running. Tools: `set_library`, `list_images`, `get_image`,
`set_rating`, `set_flag`, `get_recipe`, `update_recipe` (merge-patch — the workhorse),
`set_recipe`, `reset_recipe`, `render_preview` (returns the rendered image so the
agent can *see* its edits), `export_image`, `get_recipe_schema`.

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

### Sidecar files

Agents may also edit `IMG_1234.CR3.vibe.json` directly, then `POST /library/scan`:

```json
{
  "version": 1,
  "rating": 4,
  "flag": "pick",
  "recipe": {
    "whiteBalance": { "temp": 6500, "tint": 0 },
    "tone": { "exposure": 0.5, "contrast": 10 }
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
| | toneCurve.points | [in, out] pairs, 0–255 |
| color | saturation, vibrance | −100..100 |
| | hsl.{red…magenta}.{hue,saturation,luminance} | −100..100 |
| detail | sharpening {amount, radius, detail} | 0–150, 0.5–3, 0–100 |
| | noiseReduction {luminance, color} | 0–100 |
| geometry | rotate, orientation, flipH/V | −45..45°, 0/90/180/270 |
| | crop {left, top, right, bottom} | 0–1 normalized |

Pipeline order: WB → exposure → highlights/shadows/whites/blacks (linear light) →
contrast → tone curve → HSL/saturation (display space) → NR → sharpen → geometry.
Tone/WB math is Lightroom-*like*, not a clone.

## Development

```bash
uv run pytest          # backend tests
cd frontend && npm run build
```

State: SQLite index at `<library>/.viberoom/catalog.db` (disposable — sidecars are
the source of truth), preview cache at `<library>/.viberoom/cache/`, exports default
to `<library>/exports/`.
