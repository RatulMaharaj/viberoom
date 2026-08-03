/** `LocalSource` — the whole app's data layer, with no server behind it.
 *
 *  The library is a folder the user handed us through the File System Access
 *  API. Listings are derived by walking that folder; ratings, flags and
 *  recipes live in `.vibe.json` sidecars next to each original. There is no
 *  catalog: the Python one is disposable by design, and reimplementing SQLite
 *  in the browser would buy a cache we can rebuild in a directory walk.
 */

import type { Filters, Flag, ImageMeta, PhotoSource, PreviewOpts, SourceUrl } from '../source'
import { pickLibrary, restoreLibrary } from './handles'
import { defaultRecipe, hasEdits, mergeRecipe } from './recipe'
import { walkLibrary, type ScannedFile } from './scan'
import { loadSidecar, saveSidecar, type Sidecar } from './sidecar'
import { bitmapToUrl, decodeToBitmap, placeholderUrl } from './thumbs'

/** Everything we know about one photo, held in memory for the session. The
 *  sidecar half is cached because the grid reads rating/flag on every render
 *  and re-parsing a thousand JSON files per keystroke is not a trade. */
interface Entry {
  file: ScannedFile
  meta: ImageMeta
  sidecar: Sidecar
}

let root: FileSystemDirectoryHandle | null = null
let index = new Map<string, Entry>()

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
      meta: {
        id: file.id,
        rel_path: file.relPath,
        filename: file.filename,
        ext: file.ext,
        is_raw: file.isRaw,
        filesize: f?.size ?? 0,
        mtime: f ? f.lastModified / 1000 : 0,
        // Dimensions and EXIF need a decode. The grid does not use them, and
        // paying for a thousand decodes at open time would.
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
}

/** Client-side subset of the server's query language. Deliberately partial:
 *  everything EXIF-derived (camera, lens, iso, taken_*, gps) needs metadata we
 *  do not read yet, and collections/stacks/faces have no local store at all. */
function applyFilters(all: ImageMeta[], f: Filters): ImageMeta[] {
  let out = all
  if (f.rating_gte) out = out.filter((m) => m.rating >= f.rating_gte!)
  if (f.flag) out = out.filter((m) => (f.flag === 'none' ? m.flag === null : m.flag === f.flag))
  if (f.ext) out = out.filter((m) => m.ext === f.ext)
  if (f.has_edits !== undefined) out = out.filter((m) => m.has_edits === f.has_edits)
  if (f.folder) out = out.filter((m) => m.rel_path.startsWith(f.folder!))
  if (f.q) {
    const q = f.q.toLowerCase()
    out = out.filter((m) => m.filename.toLowerCase().includes(q))
  }

  const sort = f.sort ?? 'filename'
  const dir = f.order === 'desc' ? -1 : 1
  out = [...out].sort((a, b) => {
    const cmp =
      sort === 'mtime'
        ? a.mtime - b.mtime
        : sort === 'rating'
          ? a.rating - b.rating
          : a.filename.localeCompare(b.filename)
    // Ties by filename keep the order stable across reloads, which matters
    // because arrow-key navigation walks this array by position.
    return (cmp || a.filename.localeCompare(b.filename)) * dir
  })

  const offset = f.offset ?? 0
  return out.slice(offset, offset + (f.limit ?? 500))
}

/** Write a sidecar and keep the in-memory copy in step, so the grid does not
 *  need a re-walk to show the star it just drew. */
async function updateSidecar(id: string, mutate: (s: Sidecar) => void): Promise<Sidecar> {
  const e = entry(id)
  mutate(e.sidecar)
  await saveSidecar(e.file, e.sidecar)
  e.meta.rating = e.sidecar.rating
  e.meta.flag = e.sidecar.flag
  e.meta.has_edits = hasEdits(e.sidecar.recipe)
  return e.sidecar
}

async function renderUrl(id: string, maxWidth: number): Promise<SourceUrl> {
  const e = entry(id)
  const file = await e.file.handle.getFile()
  try {
    const bitmap = await decodeToBitmap(file, e.file.ext, maxWidth)
    // The decoded frame is also the only place dimensions come from, so bank
    // them while we have it.
    e.meta.width ??= bitmap.width
    e.meta.height ??= bitmap.height
    const url = await bitmapToUrl(bitmap)
    return { url, release: () => URL.revokeObjectURL(url) }
  } catch {
    const url = placeholderUrl(e.file.ext.slice(1).toUpperCase())
    return { url, release: () => URL.revokeObjectURL(url) }
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
    const all = [...index.values()].map((e) => e.meta)
    return { total: all.length, images: applyFilters(all, filters) }
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

  thumbnail: (id) => renderUrl(id, 320),
  preview: (id, opts: PreviewOpts = {}) => renderUrl(id, opts.size ?? 1600),

  async getFile(id) {
    return entry(id).file.handle.getFile()
  },
}

export { fileSystemAccessSupported, forgetLibrary, libraryNeedsPermission, regrantLibrary } from './handles'
export { registerRawDecoder } from './thumbs'
