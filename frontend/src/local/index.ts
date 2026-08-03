/** `LocalSource` — the whole app's data layer, with no server behind it.
 *
 *  The library is a folder the user handed us through the File System Access
 *  API. Listings are derived by walking that folder; ratings, flags and
 *  recipes live in `.vibe.json` sidecars next to each original. There is no
 *  catalog: the Python one is disposable by design, and reimplementing SQLite
 *  in the browser would buy a cache we can rebuild in a directory walk.
 */

import type { Filters, Flag, ImageMeta, PhotoSource, PreviewOpts, SourceUrl } from '../source'
import { readMetadata, thumbnailBitmap, type ExifSummary } from './decode'
import { pickLibrary, restoreLibrary } from './handles'
import { renderPreview } from './preview'
import { defaultRecipe, hasEdits, mergeRecipe } from './recipe'
import { walkLibrary, type ScannedFile } from './scan'
import { loadSidecar, saveSidecar, type Sidecar } from './sidecar'
import { bitmapToBlob, decodeToBitmap, placeholderUrl, registerRawDecoder } from './thumbs'

// The one wiring line that gives RAW files thumbnails. `thumbnailBitmap`
// prefers the camera's own embedded preview, so a grid of RAWs costs a header
// read per tile rather than the 0.6-9 seconds a full decode takes.
registerRawDecoder(thumbnailBitmap)

/** Everything we know about one photo, held in memory for the session. The
 *  sidecar half is cached because the grid reads rating/flag on every render
 *  and re-parsing a thousand JSON files per keystroke is not a trade. */
interface Entry {
  file: ScannedFile
  meta: ImageMeta
  sidecar: Sidecar
  /** EXIF-derived columns, once the backfill has reached this file. Null means
   *  "not read yet", which is why it is not simply an all-null summary. */
  summary: ExifSummary | null
}

let root: FileSystemDirectoryHandle | null = null
let index = new Map<string, Entry>()

/** Thumbnails as JPEG bytes, keyed by image id.
 *
 *  Blobs and not object URLs: a URL has an owner and a lifetime, and the grid
 *  mounts and unmounts the same tile constantly. Caching the bytes lets every
 *  caller mint its own URL and revoke it whenever it likes, while a re-scroll
 *  costs a `createObjectURL` instead of a decode. */
const thumbBlobs = new Map<string, Blob>()
/** A thousand small JPEGs is a few tens of MB; beyond that the oldest go. */
const THUMB_CACHE_LIMIT = 1500
const THUMB_WIDTH = 320

function cacheThumb(id: string, blob: Blob): void {
  thumbBlobs.delete(id)
  thumbBlobs.set(id, blob)
  while (thumbBlobs.size > THUMB_CACHE_LIMIT) {
    thumbBlobs.delete(thumbBlobs.keys().next().value as string)
  }
}

/**
 * Decoding runs a few files at a time, never a few hundred.
 *
 * Every RAW that has no embedded preview spins up its own Web Worker with its
 * own copy of the wasm heap, so an unthrottled grid of them would try to hold
 * a hundred decoders at once and take the tab down. Four is enough to keep the
 * cores busy while the UI thread stays free.
 */
const MAX_DECODES = 4
let running = 0
const waiting: (() => void)[] = []

async function limit<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_DECODES) await new Promise<void>((r) => waiting.push(r))
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

function blobUrl(blob: Blob, rendered: SourceUrl['rendered']): SourceUrl {
  const url = URL.createObjectURL(blob)
  return { url, release: () => URL.revokeObjectURL(url), rendered }
}

function requireRoot(): FileSystemDirectoryHandle {
  if (!root) throw new Error('No library open')
  return root
}

function entry(id: string): Entry {
  const e = index.get(id)
  if (!e) throw new Error(`Unknown image ${id}`)
  return e
}

async function buildIndex(handle: FileSystemDirectoryHandle): Promise<void> {
  const files = await walkLibrary(handle)
  const next = new Map<string, Entry>()
  for (const file of files) {
    const sidecar = await loadSidecar(file)
    // One File object per photo: it is the only place size and mtime live, and
    // it is a handle to bytes, not the bytes themselves.
    const f = await file.handle.getFile().catch(() => null)
    next.set(file.id, {
      file,
      sidecar,
      summary: null,
      meta: {
        id: file.id,
        rel_path: file.relPath,
        filename: file.filename,
        ext: file.ext,
        is_raw: file.isRaw,
        filesize: f?.size ?? 0,
        mtime: f ? f.lastModified / 1000 : 0,
        // Filled in afterwards by `metadataReady`. The first render of the
        // grid must not wait on a header read per file, so these start empty
        // and the rows are patched as the sweep reaches them.
        width: null,
        height: null,
        exif: {},
        rating: sidecar.rating,
        flag: sidecar.flag,
        has_edits: hasEdits(sidecar.recipe),
      },
    })
  }
  index = next
  thumbBlobs.clear()
  backfill = null
  void metadataReady()
}

// ---------------------------------------------------------------- metadata

/** Anyone who wants to know that rows changed under them. The grid re-lists on
 *  this, which is how EXIF appears on cards that were drawn without it. */
const listeners = new Set<() => void>()
let backfill: Promise<void> | null = null

/** How many files are patched between notifications. Small enough that a
 *  scrolled-to card fills in while you are looking at it, large enough that a
 *  10,000-file folder does not re-render the grid 10,000 times. */
const NOTIFY_EVERY = 64

/**
 * Read EXIF for every file, in the background.
 *
 * The server does this once at scan time into SQLite; we have no catalog, so
 * it happens per session. It is a header read per file (`exifr`), with LibRaw
 * as a container-only fallback for the RAWs exifr cannot open — tens of
 * milliseconds each, but a thousand of them is still a wait, and making the
 * grid's first paint depend on it would be the wrong trade in every folder.
 *
 * Runs at most once per index; `buildIndex` clears it so a rescan re-reads.
 */
function metadataReady(): Promise<void> {
  backfill ??= (async () => {
    const pending = [...index.values()].filter((e) => e.summary === null)
    let done = 0
    const notify = () => listeners.forEach((l) => l())
    const worker = async () => {
      for (;;) {
        const e = pending.shift()
        if (!e) return
        try {
          const meta = await readMetadata(await e.file.handle.getFile())
          e.summary = meta.summary
          // A *new* row, not a mutated one. The grid's cards are memoized on
          // the identity of this object, so patching it in place would leave
          // every card showing the blank EXIF it first rendered with.
          // Dimensions are what the file claims; a decode would be
          // authoritative but costs seconds, and both are only ever labels.
          e.meta = { ...e.meta, exif: meta.exif, width: meta.width, height: meta.height }
        } catch {
          // A file we cannot read metadata for is a blank row, not a failure —
          // same rule `readExif` follows internally.
          e.summary = e.summary ?? EMPTY_SUMMARY
        }
        if (++done % NOTIFY_EVERY === 0) notify()
      }
    }
    // Two, not `MAX_DECODES`: this is background work and must leave the
    // decode budget to the thumbnails the user is actually looking at.
    await Promise.all([worker(), worker()])
    notify()
  })()
  return backfill
}

const EMPTY_SUMMARY: ExifSummary = {
  camera: null, lens: null, iso: null, focal_length: null,
  aperture: null, shutter: null, taken_at: null, gps_lat: null, gps_lon: null,
}

/** Filters and sorts that cannot be answered until the backfill has run. */
function needsMetadata(f: Filters): boolean {
  return Boolean(
    f.camera || f.lens || f.iso_gte || f.iso_lte ||
    f.taken_after || f.taken_before || f.has_gps !== undefined ||
    f.sort === 'taken_at',
  )
}

/** Client-side subset of the server's query language. Still partial:
 *  labels, keywords, collections, stacks and faces have no local store at all
 *  — they live in the server's catalog, not in the sidecar. */
function applyFilters(all: Entry[], f: Filters): ImageMeta[] {
  let out = all
  if (f.rating_gte) out = out.filter((e) => e.meta.rating >= f.rating_gte!)
  if (f.flag) {
    out = out.filter((e) => (f.flag === 'none' ? e.meta.flag === null : e.meta.flag === f.flag))
  }
  if (f.ext) out = out.filter((e) => e.meta.ext === f.ext)
  if (f.has_edits !== undefined) out = out.filter((e) => e.meta.has_edits === f.has_edits)
  if (f.folder) out = out.filter((e) => e.meta.rel_path.startsWith(f.folder!))
  if (f.q) {
    const q = f.q.toLowerCase()
    out = out.filter((e) => e.meta.filename.toLowerCase().includes(q))
  }
  // Substring and case-insensitive, matching the server's LIKE on these two.
  if (f.camera) out = out.filter((e) => contains(e.summary?.camera, f.camera!))
  if (f.lens) out = out.filter((e) => contains(e.summary?.lens, f.lens!))
  if (f.iso_gte) out = out.filter((e) => (e.summary?.iso ?? -1) >= f.iso_gte!)
  if (f.iso_lte) out = out.filter((e) => (e.summary?.iso ?? Infinity) <= f.iso_lte!)
  // `taken_at` is stored as "YYYY-MM-DD HH:MM:SS", which sorts and compares
  // lexicographically — the same property the server's SQL relies on.
  if (f.taken_after) out = out.filter((e) => (e.summary?.taken_at ?? '') >= f.taken_after!)
  if (f.taken_before) out = out.filter((e) => (e.summary?.taken_at ?? '') <= f.taken_before!)
  if (f.has_gps !== undefined) {
    out = out.filter((e) => (e.summary?.gps_lat != null) === f.has_gps)
  }

  const sort = f.sort ?? 'filename'
  const dir = f.order === 'desc' ? -1 : 1
  out = [...out].sort((a, b) => {
    const cmp =
      sort === 'mtime'
        ? a.meta.mtime - b.meta.mtime
        : sort === 'rating'
          ? a.meta.rating - b.meta.rating
          : sort === 'taken_at'
            // Undated files sort together at the end, whichever way the order
            // runs — the alternative is them drifting to the top on a descending
            // sort, where they read as "most recent".
            ? cmp3(a.summary?.taken_at, b.summary?.taken_at, dir)
            : a.meta.filename.localeCompare(b.meta.filename)
    // Ties by filename keep the order stable across reloads, which matters
    // because arrow-key navigation walks this array by position.
    return (cmp || a.meta.filename.localeCompare(b.meta.filename)) * dir
  })

  const offset = f.offset ?? 0
  return out.slice(offset, offset + (f.limit ?? 500)).map((e) => e.meta)
}

const contains = (value: string | null | undefined, needle: string): boolean =>
  !!value && value.toLowerCase().includes(needle.toLowerCase())

/** Compare two optional dates, with "missing" always last. `dir` is undone by
 *  the caller's multiply, which is why it is applied here. */
function cmp3(a: string | null | undefined, b: string | null | undefined, dir: number): number {
  if (!a && !b) return 0
  if (!a) return dir
  if (!b) return -dir
  return a < b ? -1 : a > b ? 1 : 0
}

/** Write a sidecar and keep the in-memory copy in step, so the grid does not
 *  need a re-walk to show the star it just drew. */
async function updateSidecar(id: string, mutate: (s: Sidecar) => void): Promise<Sidecar> {
  const e = entry(id)
  mutate(e.sidecar)
  await saveSidecar(e.file, e.sidecar)
  // Replaced rather than patched, for the memoization reason in the backfill.
  e.meta = {
    ...e.meta,
    rating: e.sidecar.rating,
    flag: e.sidecar.flag,
    has_edits: hasEdits(e.sidecar.recipe),
  }
  return e.sidecar
}

/** A tile we could not produce. Not cached: whatever stopped the decode may
 *  well be temporary (a revoked permission, a busy disk). */
function placeholder(ext: string): SourceUrl {
  const url = placeholderUrl(ext.slice(1).toUpperCase())
  return { url, release: () => URL.revokeObjectURL(url), rendered: 'original' }
}

async function thumbnailUrl(id: string): Promise<SourceUrl> {
  const e = entry(id)
  const hit = thumbBlobs.get(id)
  if (hit) return blobUrl(hit, 'original')
  try {
    const blob = await limit(async () => {
      const file = await e.file.handle.getFile()
      return bitmapToBlob(await decodeToBitmap(file, e.file.ext, THUMB_WIDTH))
    })
    cacheThumb(id, blob)
    return blobUrl(blob, 'original')
  } catch {
    return placeholder(e.file.ext)
  }
}

/** The develop preview, rendered here rather than fetched. See
 *  `local/preview.ts` for what happens to a recipe the shader cannot draw. */
async function previewUrl(id: string, opts: PreviewOpts): Promise<SourceUrl> {
  const e = entry(id)
  try {
    const file = await e.file.handle.getFile()
    const out = await limit(() =>
      renderPreview(file, e.sidecar.recipe, opts.size ?? 1600, opts.original ?? false),
    )
    return blobUrl(out.blob, out.rendered)
  } catch {
    return placeholder(e.file.ext)
  }
}

export const LocalSource: PhotoSource = {
  kind: 'local',

  async getLibrary() {
    // Restoring never prompts; a stored-but-unpermitted handle reads as "no
    // library" so the UI offers a reconnect click instead of failing reads.
    root ??= await restoreLibrary()
    if (root && index.size === 0) await buildIndex(root)
    return { library: root?.name ?? null }
  },

  async openLibrary() {
    // Ignores the path hint: the browser will not open a folder we name, only
    // one the user points at. Needs to run inside a user gesture.
    root = await pickLibrary()
    await buildIndex(root)
    return { library: root.name, total: index.size }
  },

  async scan() {
    await buildIndex(requireRoot())
  },

  async listExts() {
    return [...new Set([...index.values()].map((e) => e.meta.ext))].sort()
  },

  async listImages(filters: Filters = {}) {
    // Only a query that actually reads EXIF waits for the backfill. The common
    // case — no filter, or rating and flag, which live in the sidecar — answers
    // from the walk alone and paints immediately.
    if (needsMetadata(filters)) await metadataReady()
    const all = [...index.values()]
    return { total: all.length, images: applyFilters(all, filters) }
  },

  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  async getImage(id) {
    return entry(id).meta
  },

  async setRating(id, rating) {
    await updateSidecar(id, (s) => {
      s.rating = rating
    })
  },

  async setFlag(id, flag: Flag) {
    await updateSidecar(id, (s) => {
      s.flag = flag
    })
  },

  async getRecipe(id) {
    return entry(id).sidecar.recipe
  },

  async putRecipe(id, recipe) {
    const s = await updateSidecar(id, (sc) => {
      sc.history.push({ at: new Date().toISOString(), recipe: sc.recipe })
      // HISTORY_CAP in sidecar.py; keeping the cap here stops a long editing
      // session from growing the sidecar without bound.
      sc.history = sc.history.slice(-40)
      sc.recipe = recipe as Record<string, any>
    })
    return s.recipe
  },

  async patchRecipe(id, patch) {
    const s = await updateSidecar(id, (sc) => {
      sc.recipe = mergeRecipe(sc.recipe, patch as Record<string, any>)
    })
    return s.recipe
  },

  async resetRecipe(id) {
    const s = await updateSidecar(id, (sc) => {
      sc.recipe = defaultRecipe()
    })
    return s.recipe
  },

  thumbnail: (id) => thumbnailUrl(id),
  preview: (id, opts: PreviewOpts = {}) => previewUrl(id, opts),

  async getFile(id) {
    return entry(id).file.handle.getFile()
  },
}

export { fileSystemAccessSupported, forgetLibrary, libraryNeedsPermission, regrantLibrary } from './handles'
export { registerRawDecoder } from './thumbs'
export { metadataReady }
