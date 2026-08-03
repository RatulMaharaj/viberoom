/** The seam between the app and wherever the photos actually live.
 *
 *  Today that is the local Python server (`api.ts`). As a PWA there is no
 *  server at all and the browser reads the folder itself over the File System
 *  Access API. Both answer the same questions, so the pages can stop caring
 *  which one they got.
 *
 *  This is deliberately *not* all ~70 functions in `api.ts`. It covers what
 *  `pages/Library.tsx` and `pages/Edit.tsx` actually call. Everything below is
 *  knowingly left out, because it either has no browser-side answer yet or is
 *  owned by a panel that will get its own seam later:
 *
 *    - history / snapshots / variants        (sidecar has the data; no UI need yet)
 *    - IPTC, XMP, keywords, labels           (OrganizePanel)
 *    - collections, stacks, duplicates       (OrganizePanel)
 *    - merge, import, faces, map, tether     (server-side compute, no PWA story)
 *    - enhance, soft proof, auto-adjust      (server-side compute)
 *    - export + export presets, LUTs, presets, batch ops
 *    - fs browse / mkdir / native picker / extra roots
 *
 *  Pixels are the one place the shapes diverge: the server hands out URLs
 *  synchronously, the browser has to open and decode a file first. So the
 *  pixel methods are async and return an object-URL the caller must release.
 */

import { api, type Filters, type Flag, type ImageMeta } from './api'

export type { Filters, Flag, ImageMeta }

/** A URL plus the means to let go of it. Server URLs are free; local ones are
 *  `blob:` and leak the whole decoded frame until revoked. */
export interface SourceUrl {
  url: string
  release: () => void
  /** What the pixels actually are. The server always renders the full recipe;
   *  the browser renders what its shader can and otherwise hands back the
   *  untouched original, which the UI has to be able to say out loud. */
  rendered?: 'server' | 'gpu' | 'original'
}

export interface PreviewOpts {
  size?: number
  /** Cache-buster; meaningless locally, where the blob is already fresh. */
  bust?: string
  /** Render the untouched original — the "before" view. */
  original?: boolean
  /** Keep every edit but ignore the crop, so the crop tool can show what is
   *  being cropped *out*. */
  nocrop?: boolean
}

/** Everything the export dialog can ask for. A superset of what the browser
 *  can do on purpose: the fields the local source cannot honour are disabled
 *  in the UI rather than dropped silently here, so the two halves of "what did
 *  I actually get" stay in one place. */
export interface ExportSettings {
  format: 'jpeg' | 'png' | 'tiff'
  quality: number
  bit_depth: 8 | 16
  max_dimension: number | null
  color_space: 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto'
  output_sharpen: 'screen' | 'matte' | 'glossy' | null
  variant: string | null
  /** Server only: a path typed or browsed to. Locally the destination is a
   *  directory handle the user picked, which has no path we are allowed to
   *  see. */
  dest_dir: string | null
  filename: string | null
  watermark: {
    text: string | null
    image: string | null
    position: string
    opacity: number
    scale: number
  } | null
}

export interface ExportProgress {
  /** 1-based, so it reads as "3 of 12" without arithmetic at the call site. */
  index: number
  total: number
  filename: string
  stage: 'render' | 'write' | 'done'
}

export interface ExportResult {
  id: string
  filename: string
  ok: boolean
  /** Where it landed, when it landed. */
  path?: string
  /** Why it did not, in a sentence meant for a person. */
  error?: string
  /** Something true but unasked-for — a frame the memory cap shrank. */
  note?: string
}

export interface ExportReport {
  written: number
  results: ExportResult[]
  /** Human name of where the files went. */
  destination?: string
}

export interface PhotoSource {
  readonly kind: 'server' | 'local'

  // ---------- library ----------

  /** Currently open library, or null if the user has not chosen one. */
  getLibrary(): Promise<{ library: string | null }>
  /** Open a library. `hint` is a path for the server; the local source ignores
   *  it and shows the browser's own directory picker (which needs a user
   *  gesture, so call this straight from a click handler). */
  openLibrary(hint?: string): Promise<{ library: string; total: number }>
  /** Re-read the folder. Cheap locally, where the listing is derived anyway. */
  scan(): Promise<void>
  /** Extensions actually present, for the type filter. */
  listExts(): Promise<string[]>

  // ---------- listing & metadata ----------

  listImages(filters?: Filters): Promise<{ total: number; images: ImageMeta[] }>
  getImage(id: string): Promise<ImageMeta>
  setRating(id: string, rating: number): Promise<void>
  setFlag(id: string, flag: Flag): Promise<void>

  // ---------- recipe ----------

  getRecipe(id: string): Promise<Record<string, any>>
  putRecipe(id: string, recipe: object): Promise<Record<string, any>>
  patchRecipe(id: string, patch: object): Promise<Record<string, any>>
  resetRecipe(id: string): Promise<Record<string, any>>

  // ---------- pixels ----------

  thumbnail(id: string): Promise<SourceUrl>
  preview(id: string, opts?: PreviewOpts): Promise<SourceUrl>
  /** The original bytes, for the GPU renderer and the RAW decoder. Null when
   *  the source cannot hand out the file itself (the server never can). */
  getFile(id: string): Promise<File | null>

  // ---------- export ----------

  /** Write finished files. Sequential and progress-reporting because locally
   *  it is a full-resolution GPU render plus an encode per photo — seconds
   *  each — and a frozen dialog for a minute is not an acceptable answer.
   *
   *  Never throws for one bad photo: a batch reports per-image outcomes, so a
   *  recipe the browser refuses does not lose the other thirty-nine. It does
   *  throw when the whole export cannot start (no destination, no WebGL). */
  exportImages(
    ids: string[],
    settings: ExportSettings,
    onProgress?: (p: ExportProgress) => void,
  ): Promise<ExportReport>

  /** Ask for the export destination now, from a click. Local only: the browser
   *  will not hand over a folder without a gesture, and the server takes a
   *  path typed into the dialog instead. Returns null if the user cancels. */
  chooseExportDestination?(): Promise<string | null>
  /** The destination remembered for this session, if any. */
  exportDestinationName?(): string | null

  /** Told when rows the source already returned have changed underneath —
   *  locally, that is EXIF arriving after the grid has painted. Absent on the
   *  server, which has read everything before it answers at all. */
  subscribe?(listener: () => void): () => void
}

/** Server URLs need no cleanup, but callers should not have to know that. */
const plain = (url: string): SourceUrl => ({ url, release: () => {}, rendered: 'server' })

/** The status quo: delegate straight to the existing REST client. Wrapping it
 *  rather than reshaping it keeps this wave a no-op for the running app. */
export const ServerSource: PhotoSource = {
  kind: 'server',

  getLibrary: () => api.getLibrary(),
  openLibrary: (hint?: string) => {
    if (!hint) throw new Error('The server source needs a path to open')
    return api.setLibrary(hint)
  },
  scan: () => api.scan().then(() => undefined),
  listExts: () => api.listExts().then((r) => r.exts),

  listImages: (filters: Filters = {}) => api.listImages(filters),
  getImage: (id) => api.getImage(id),
  setRating: (id, rating) => api.setRating(id, rating).then(() => undefined),
  setFlag: (id, flag) => api.setFlag(id, flag).then(() => undefined),

  getRecipe: (id) => api.getRecipe(id),
  putRecipe: (id, recipe) => api.putRecipe(id, recipe),
  patchRecipe: (id, patch) => api.patchRecipe(id, patch),
  resetRecipe: (id) => api.resetRecipe(id),

  thumbnail: async (id) => plain(api.thumbnailUrl(id)),
  preview: async (id, opts = {}) =>
    plain(api.previewUrl(id, opts.size ?? 1600, opts.bust ?? '', opts.original ?? false, opts.nocrop ?? false)),
  getFile: async () => null,

  async exportImages(ids, s, onProgress) {
    // The request body the dialog used to build itself. Unset fields are left
    // off rather than sent as null: the endpoint applies an export preset
    // underneath whatever the request sets explicitly, and a null would
    // overwrite the preset's value with nothing.
    const body: Record<string, any> = {
      format: s.format,
      quality: s.quality,
      bit_depth: s.bit_depth,
      color_space: s.color_space,
    }
    if (s.max_dimension) body.max_dimension = s.max_dimension
    if (s.output_sharpen) body.output_sharpen = s.output_sharpen
    if (s.variant) body.variant = s.variant
    if (s.dest_dir) body.dest_dir = s.dest_dir
    if (s.watermark && (s.watermark.text || s.watermark.image)) body.watermark = s.watermark

    // The server renders the batch itself, so there is one round trip and no
    // per-image progress to report — only that it started and finished.
    onProgress?.({ index: 1, total: ids.length, filename: '', stage: 'render' })
    if (ids.length > 1) {
      if (s.filename) body.filename = s.filename
      const r: any = await api.batchExport({ ...body, image_ids: ids })
      const count = r.count ?? ids.length
      return {
        written: count,
        results: ids.slice(0, count).map((id) => ({ id, filename: '', ok: true })),
        destination: s.dest_dir ?? '<library>/exports',
      }
    }
    const r = await api.exportImage(ids[0], body)
    return {
      written: 1,
      results: [{ id: ids[0], filename: r.path, ok: true, path: r.path }],
      destination: s.dest_dir ?? '<library>/exports',
    }
  },
}

/** Cached so the probe below runs once per page load, not once per caller. */
let resolved: Promise<PhotoSource> | null = null

/** Pick a source: the Python server if it is answering on this origin,
 *  otherwise the browser's own filesystem.
 *
 *  We probe rather than sniff the hostname because the dev server proxies
 *  `/api/v1` from a different port, and a statically-hosted PWA build can sit
 *  on any origin at all. A 404 still counts as "no server here" — the endpoint
 *  exists whenever the backend is up, so anything but a real answer means we
 *  are on our own. */
export function getSource(): Promise<PhotoSource> {
  resolved ??= probeServer().then(async (up) => {
    if (up) return ServerSource
    const { LocalSource } = await import('./local')
    return LocalSource
  })
  return resolved
}

async function probeServer(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/library', { method: 'GET' })
    if (!res.ok) return false
    // A 200 is not enough. Most static hosts answer an unknown path with the
    // SPA shell rather than a 404 — so the API probe comes back as a cheerful
    // 200 of HTML, the app concludes it has a backend, and then every call
    // fails. Insist on the JSON this endpoint actually returns.
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return false
    const body = await res.json()
    return typeof body === 'object' && body !== null && 'library' in body
  } catch {
    // Network failure, or HTML that would not parse as JSON. Either way there
    // is nothing to talk to.
    return false
  }
}
