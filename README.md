<p align="center">
  <img src="frontend/public/icon-source.png" width="96" alt="Viberoom" />
</p>

<h1 align="center">Viberoom</h1>

<p align="center"><em>All the sliders — and an agent that can drive them.</em></p>

Viberoom is a RAW photo manager and non-destructive editor you can drive
**by hand or by agent**. Edit with the full develop UI in the browser — or tell
Claude Code *"reject the blurry ones, warm up the sunsets, export the picks"*
and it happens through MCP, REST, or plain JSON sidecar files.

- 🧾 **Non-destructive, always.** Every edit is a readable `photo.CR3.vibe.json`
  next to the original. Delete the sidecar, get your pixels back.
- 📷 **Real RAW.** LibRaw decoding (CR2/CR3, NEF, ARW, RAF, DNG, …) plus
  JPEG/PNG/TIFF/HEIC.
- 🎛️ **The whole develop kit — in the UI and the API.** WB, tone, curves, HSL,
  color grading, LUTs, sharpening/NR, lens & perspective corrections,
  heal/clone, grain — and local masks: gradients, luminance/color ranges,
  brushes, AI subject/sky masks. Everything the API can do is reachable from
  the interface, and vice versa.
- 🤖 **Bring your own agent.** The app is a PWA that exposes its tools to
  whatever agent your browser provides, via WebMCP — it no longer launches an
  agent of its own. Outside the browser, `viberoom-mcp` drives it from Claude
  Code.
- 🗂️ **DAM things.** Ratings, flags, labels, keywords, collections (smart too),
  stacks, dupes, history, snapshots, virtual copies, multi-folder catalogs.
- 📥 **In and out.** Card ingest, tethered capture, HDR & pano merge, ML
  enhance (`viberoom[ml]`), XMP interop, batch everything, color-managed
  export (sRGB → ProPhoto) with watermarks and soft proofing.

## Setup from source

| | Version | Why |
|---|---|---|
| **Python** | 3.12+ | `pyproject.toml` floor; 3.13 is fine |
| **Node** | 20.19+ or 22.12+ | what Vite 8 requires |
| **[uv](https://docs.astral.sh/uv/)** | any recent | resolves and runs the backend |

Nothing else. LibRaw and the image codecs arrive inside the `rawpy` and Pillow
wheels, so there's no Homebrew/apt step and no compiler needed for the web app.

```bash
git clone https://github.com/RatulMaharaj/viberoom.git
cd viberoom

uv sync                                  # backend deps into .venv (uv installs Python if missing)
npm --prefix frontend install
npm --prefix frontend run build          # typechecks, then writes frontend/dist

uv run viberoom                          # UI + API → http://127.0.0.1:8423
```

Open it, point it at a folder of photos. That's it — no database to provision,
no config file.

Optional extras:

```bash
uv sync --extra ml     # AI subject/sky masks, face detection, ML enhance
                       #   (onnxruntime + rembg; weights download on first use)
```

Other ways to run:

```bash
uv run dev             # hacking: backend --reload + Vite (:7666 "ROOM" → :8423 "VIBE")
```

If something's off: `npm run build` failing on syntax that looks fine usually
means Node is below the Vite floor (`node -v`), and a `uv sync` that resolves
oddly usually means an old uv (`uv self update`). The frontend must be built at
least once — without `frontend/dist` the backend serves the API but no UI.

## Run it as a PWA (no backend)

The frontend is also a standalone progressive web app: it reads your photo
folder straight off disk with the File System Access API, decodes RAW with
LibRaw compiled to WebAssembly, and develops on the GPU. **Nothing is uploaded
— there is no server to upload to.** Sidecars and thumbnails are written back
into your own folder and its browser-local cache.

- **Chrome or Edge, on desktop.** Safari, Firefox and every browser on iOS lack
  the File System Access API; the app says so up front rather than failing
  halfway in.
- **Install it** from the address-bar install icon to get a standalone window.
- **Offline.** A service worker precaches the app shell, and the LibRaw wasm is
  cached the first time a RAW is decoded, so a second visit works with no
  network at all.
- **Updates** ship by pushing to `main`: GitHub Actions rebuilds and deploys the
  static site, and open tabs get a *"a new version of Viberoom is ready"*
  prompt instead of silently running last month's build.

The Python package stays an optional companion. Install it when you want the
things a browser cannot do on its own: the Claude Code sidebar, the MCP server,
the REST API, and the benchmark suite.

To host it yourself, build with `VITE_BASE` set to the path it will be served
from (`/` for the FastAPI mount, `/viberoom/` for GitHub Pages):

```bash
VITE_BASE=/viberoom/ npm --prefix frontend run build
```

## Let an agent drive

```bash
claude mcp add --transport http viberoom http://127.0.0.1:8423/mcp
```

The MCP server is mounted on the viberoom server itself — just a URL, no paths
to keep in sync. ~45 tools, from `list_images` to `update_recipe` (the
workhorse merge-patch) to `render_preview` — which returns the rendered image,
so the agent can *look at its own edits* and iterate. Then just talk:

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
uv run viberoom-bench auto       # degrade → recover → score, no dataset needed
uv run viberoom-bench reference --inputs raw/ --references expertC/
```

`compare` treats **libraw as an oracle** (a no-op render must match its neutral
decode: 53–55 dB PSNR on Bayer) and **darktable as a reference** (different
rendering philosophy, so dE 5–14 means "same neighbourhood", not "bug").
`auto` degrades an image by a known amount and scores the recovery — exact
ground truth, no dataset (`wb` mode is the real pass/fail; `--strategy auto`
is diagnostic only). `reference` scores auto-adjust against expert retouches —
if `auto` isn't beating `noop`, it's making things worse. `viberoom-bench
datasets` lists where the big datasets live and what each one proves.

## Development

```bash
uv run pytest                     # backend
npm --prefix frontend run build   # frontend typecheck + build
```

State lives in `<library>/.viberoom/` — a disposable SQLite index (sidecars are
the source of truth) and the preview cache. Exports land in
`<library>/exports/` unless you pick another folder.
