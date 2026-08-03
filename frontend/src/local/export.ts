/** Exporting finished files with no server: full-res GPU render, encode, and
 *  write straight into a folder the user picked.
 *
 *  `export.py` is the behaviour being matched, and this deliberately matches
 *  only part of it. JPEG and 8-bit PNG, `max_dimension`, and the filename
 *  template are here. 16-bit PNG, TIFF, ICC profiles and wide-gamut colour
 *  spaces, watermarks, output sharpening, EXIF carry-over and export presets
 *  are not: each needs an encoder or a colour transform the browser does not
 *  give us, and a file that silently lacks them is worse than a disabled
 *  button. The UI disables them; this module never pretends to do them.
 *
 *  The one hard rule: a recipe `gpu/support.ts` will not draw is *refused*,
 *  never exported half-applied. A preview that falls back to the original is
 *  recoverable — the badge says so and the pixels are gone next reload. An
 *  export is a file the photographer keeps, and a JPEG missing its retouch or
 *  its subject mask looks exactly like one that has them.
 */

import { GpuRenderer, gpuEnabled, gpuSupportGaps, gpuSupportsRecipe } from '../gpu'
import { decodeCached, encodeSource, resizeLinear, type LinearImage } from './decode'

export type ExportFormat = 'jpeg' | 'png'

export interface LocalExportOptions {
  format: ExportFormat
  /** JPEG only; PNG ignores it, as `convertToBlob` does. */
  quality: number
  /** Longest edge of the written file, or null for "as rendered". */
  maxDimension: number | null
}

export interface RenderedExport {
  blob: Blob
  width: number
  height: number
  /** Pixels the renderer was actually handed, after the memory cap below. */
  renderWidth: number
  renderHeight: number
  /** Full decoded size, before the cap. */
  sourceWidth: number
  sourceHeight: number
  /** True when the cap, not the user, chose the render size. */
  capped: boolean
}

export function extensionFor(fmt: ExportFormat): string {
  return fmt === 'png' ? '.png' : '.jpg'
}

// ---------------------------------------------------------------- filenames

export interface FilenameTokens {
  /** The source file's stem — no extension. */
  name: string
  /** 1-based position in the batch. Rendered zero-padded to four digits, as
   *  `export_extras.render_filename` does. */
  seq: number
  rating: number
  /** Capture date as YYYY-MM-DD, or null when we never read one. */
  date: string | null
  /** Including the dot. */
  ext: string
}

/** `export_extras.render_filename`, token for token.
 *
 *  Unknown tokens throw rather than being left in the name: a file called
 *  `IMG_1{unpaired}.jpg` is a mistake the user should see at the dialog, not
 *  on disk. `/` is allowed and nests folders; `..` is refused outright. */
export function renderFilename(template: string, t: FilenameTokens): string {
  const rel = template.replace(/\{([^{}]*)\}/g, (_, key: string) => {
    switch (key) {
      case 'name': return t.name
      case 'seq': return String(t.seq).padStart(4, '0')
      case 'rating': return String(t.rating)
      case 'date': return t.date || 'undated'
      case 'ext': return t.ext
      default: throw new Error(`unknown token {${key}} in filename template`)
    }
  }).replace(/^\/+/, '')
  const parts = rel.split('/')
  if (parts.some((p) => p === '..')) throw new Error("filename template must not contain '..'")
  if (parts.length === 0 || parts[parts.length - 1] === '') {
    throw new Error('filename template must end in a filename')
  }
  return rel
}

/**
 * `PIL.Image.thumbnail`'s target size for a square box of `max`.
 *
 * Ported rather than approximated because it is the one piece of the resize the
 * desktop app and the browser can genuinely agree on. PIL fits the box and then
 * picks whichever of floor/ceil on the short edge lands closest to the original
 * aspect ratio, which is not the same as rounding — a 6000x4000 into 2000 is
 * 2000x1333, and plain rounding gives 1333 only by luck.
 *
 * Never upscales, matching `thumbnail`'s early return.
 */
export function fitWithin(w: number, h: number, max: number): [number, number] {
  if (!max || max <= 0) return [w, h]
  let x = Math.floor(max)
  let y = Math.floor(max)
  if (x >= w && y >= h) return [w, h]
  const aspect = w / h
  const pick = (n: number, key: (v: number) => number): number => {
    const lo = Math.floor(n)
    const hi = Math.ceil(n)
    return Math.max(key(hi) < key(lo) ? hi : lo, 1)
  }
  if (x / y >= aspect) {
    x = pick(y * aspect, (n) => Math.abs(aspect - n / y))
  } else {
    y = pick(x / aspect, (n) => (n === 0 ? 0 : Math.abs(aspect - x / n)))
  }
  return [x, y]
}

// ------------------------------------------------------------------- memory

/**
 * The most pixels this will hand the GPU, and why there is a number at all.
 *
 * A 24 MP frame is ~290 MB as the float32 the decoder produces, ~96 MB as the
 * RGB9_E5 texture it is uploaded as, and 192 MB per RGBA16F render target — and
 * `GpuRenderer` keeps two of those alive at all times plus up to three scratch
 * planes, a geometry pair and, for a masked recipe, eight more. A full-frame
 * 45 MP RAW with a crop and a mask on it therefore asks for something north of
 * two gigabytes of VRAM, and what a browser does when that fails is not "throw"
 * — it is a lost context or a dead tab.
 *
 * So the frame is shrunk to fit this budget before it is uploaded, and the
 * caller is *told* it happened: `RenderedExport.capped` is what puts "exported
 * at 6000x4000, not the file's 8192x5464" in front of the user. A smaller file
 * you were warned about beats a crashed tab, and both beat a silent downscale.
 */
export const EXPORT_PIXEL_CAP = 24_000_000

/** Longest edge WebGL will accept as a texture, cached per page. Separate from
 *  the pixel cap: a 30000x800 panorama is well under the budget and still
 *  wider than any driver's `MAX_TEXTURE_SIZE`. */
let maxTextureSize: number | null = null

export function maxExportEdge(): number {
  if (maxTextureSize !== null) return maxTextureSize
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    maxTextureSize = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 4096
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    maxTextureSize = 4096
  }
  return maxTextureSize ?? 4096
}

/** Render size for a decoded frame: itself, unless the budget says otherwise. */
export function cappedSize(w: number, h: number, edge = maxExportEdge()): [number, number] {
  const scale = Math.min(
    1,
    Math.sqrt(EXPORT_PIXEL_CAP / (w * h)),
    edge / Math.max(w, h),
  )
  if (scale >= 1) return [w, h]
  // Floor, not round: rounding both edges up can put the result back *over*
  // the budget the scale was computed to satisfy (8192x5464 lands on
  // 5999x4001, which is 24.0000002 MP), and the budget is the whole point.
  return [Math.max(1, Math.floor(w * scale)), Math.max(1, Math.floor(h * scale))]
}

// ------------------------------------------------------------------ refusal

/** Human names for the recipe fields the shader cannot draw, so a refusal can
 *  say *what* is missing rather than just "unsupported". */
const GAP_LABELS: [string, string][] = [
  ['masks', 'AI or unsupported masks'],
  ['retouch', 'retouch (heal/clone)'],
  ['effects.grain', 'grain'],
  ['detail.sharpening', 'sharpening'],
  ['detail.noiseReduction', 'noise reduction'],
  ['lens.defringe', 'defringe'],
  ['color.lut', 'a LUT'],
]

/** Why this recipe cannot be exported here, or null if it can. */
export function exportRefusal(recipe: unknown): string | null {
  if (gpuSupportsRecipe(recipe)) return null
  const gaps = gpuSupportGaps(recipe)
  const named = new Set<string>()
  for (const path of gaps) {
    const hit = GAP_LABELS.find(([p]) => path === p || path.startsWith(`${p}.`))
    named.add(hit ? hit[1] : path)
  }
  const list = [...named].join(', ')
  return list
    ? `needs ${list}, which only the desktop app renders`
    : 'uses an edit this browser build cannot render'
}

// ------------------------------------------------------------------- render

/** One renderer for a whole batch: a WebGL context per photo would run a tab
 *  out of them, and the targets are reallocated on `setSource` anyway.
 *  Deliberately *not* shared with `preview.ts` — that one is sized for a 1600px
 *  preview and must not be left holding full-resolution targets. */
let exportCanvas: HTMLCanvasElement | null = null
let exportRenderer: GpuRenderer | null = null

function acquire(): GpuRenderer {
  if (exportRenderer && !exportRenderer.lost) return exportRenderer
  exportRenderer?.dispose()
  exportCanvas ??= document.createElement('canvas')
  exportRenderer = new GpuRenderer(exportCanvas)
  return exportRenderer
}

/** Hand the VRAM back. Called when a batch finishes, however it finishes. */
export function releaseExportRenderer(): void {
  exportRenderer?.dispose()
  exportRenderer = null
  exportCanvas = null
}

/**
 * Draw `recipe` over an already-decoded frame and encode the result.
 *
 * Split from the file path so the diagnostic page can exercise a full-size
 * render and an encode without a folder-picker gesture.
 */
export async function renderExport(
  img: LinearImage,
  recipe: unknown,
  opts: LocalExportOptions,
): Promise<RenderedExport> {
  if (!gpuEnabled()) throw new Error('WebGL2 is unavailable, so nothing can be rendered')
  const refusal = exportRefusal(recipe)
  if (refusal) throw new Error(refusal)

  const [rw, rh] = cappedSize(img.width, img.height)
  const capped = rw !== img.width || rh !== img.height
  const frame = capped ? resizeLinear(img, rw, rh) : img

  const gpu = acquire()
  // `scale` is this frame's size relative to full resolution — the detail ops'
  // radii are absolute pixels. They are refused above, so it can only ever be
  // 1 in practice; it is passed honestly anyway so that lifting that refusal
  // does not silently start rendering the wrong radius.
  gpu.setSource(encodeSource(frame, 'rgb9e5'), rw / img.width)
  gpu.render(recipe)
  const { width, height } = gpu.size

  // The drawing buffer is not preserved across tasks, so the copy out of the GL
  // canvas happens synchronously, in the same turn as the draw.
  let surface: OffscreenCanvas = new OffscreenCanvas(width, height)
  const ctx = surface.getContext('2d')
  if (!ctx) throw new Error('no 2D context for the export surface')
  ctx.drawImage(exportCanvas!, 0, 0)

  const [tw, th] = opts.maxDimension ? fitWithin(width, height, opts.maxDimension) : [width, height]
  if (tw !== width || th !== height) surface = downscaleCanvas(surface, tw, th)

  const blob = await surface.convertToBlob(
    opts.format === 'png'
      ? { type: 'image/png' }
      : { type: 'image/jpeg', quality: Math.min(100, Math.max(1, opts.quality)) / 100 },
  )
  return {
    blob,
    width: tw,
    height: th,
    renderWidth: width,
    renderHeight: height,
    sourceWidth: img.width,
    sourceHeight: img.height,
    capped,
  }
}

/**
 * Shrink a canvas, halving at a time.
 *
 * This is the one place the browser and the desktop app genuinely differ:
 * `export.py` resizes with PIL's Lanczos, and the only way to reproduce that
 * here would be to read 24 MP of RGBA back into float32 and run
 * `downscale.ts` over it — three more full-frame buffers at the exact moment
 * memory is tightest. Repeated halving into `drawImage` with high smoothing is
 * a box-ish filter rather than Lanczos: no aliasing, marginally softer than
 * PIL. The *dimensions* still come from the PIL port above, so a resized export
 * is the same size as the desktop app's and very slightly less crisp.
 */
function downscaleCanvas(src: OffscreenCanvas, tw: number, th: number): OffscreenCanvas {
  let cur = src
  while (cur.width > tw * 2 && cur.height > th * 2) {
    cur = drawInto(cur, Math.max(tw, cur.width >> 1), Math.max(th, cur.height >> 1))
  }
  return drawInto(cur, tw, th)
}

function drawInto(src: OffscreenCanvas, w: number, h: number): OffscreenCanvas {
  const out = new OffscreenCanvas(w, h)
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('no 2D context for the resize surface')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, w, h)
  return out
}

/** Decode `file` and export it. The decode is the cached one, so a photo that
 *  was previewed this session does not pay LibRaw twice. */
export async function exportFile(
  file: File,
  recipe: unknown,
  opts: LocalExportOptions,
): Promise<RenderedExport> {
  const refusal = exportRefusal(recipe)
  if (refusal) throw new Error(refusal)
  return renderExport(await decodeCached(file), recipe, opts)
}

// -------------------------------------------------------------- destination

/** Where this session's exports go. Asked for once — a picker per file in a
 *  batch of forty is not a workflow — and kept until the tab is closed. Not
 *  persisted to IndexedDB on purpose: an export that silently writes into a
 *  folder chosen last week is a surprise, and the prompt is one click. */
let destination: FileSystemDirectoryHandle | null = null

export function exportDestination(): FileSystemDirectoryHandle | null {
  return destination
}

export function forgetExportDestination(): void {
  destination = null
}

/** Prompt for a destination. Needs a user gesture, so it must be the first
 *  thing an export click does, before any decode. */
export async function chooseExportDestination(): Promise<FileSystemDirectoryHandle> {
  destination = await window.showDirectoryPicker({
    mode: 'readwrite',
    id: 'viberoom-exports',
    startIn: 'pictures',
  })
  return destination
}

/** The remembered destination, prompting only if there is not one yet. */
export async function requireExportDestination(): Promise<FileSystemDirectoryHandle> {
  if (destination) {
    // A handle kept across a long session can lose its grant; re-asking is
    // cheap and silent when it is still granted.
    if ((await destination.queryPermission({ mode: 'readwrite' })) === 'granted') return destination
    if ((await destination.requestPermission({ mode: 'readwrite' })) === 'granted') return destination
    destination = null
  }
  return chooseExportDestination()
}

/** Write `blob` at `relPath` under `dir`, creating any folders the template
 *  asked for. Returns the path written, for the report. */
export async function writeExport(
  dir: FileSystemDirectoryHandle,
  relPath: string,
  blob: Blob,
): Promise<string> {
  const parts = relPath.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) throw new Error('empty output filename')
  let cur = dir
  for (const part of parts) cur = await cur.getDirectoryHandle(part, { create: true })
  const handle = await cur.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(blob)
  } finally {
    await writable.close()
  }
  return `${dir.name}/${relPath}`
}
