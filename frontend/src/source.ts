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
    plain(api.previewUrl(id, opts.size ?? 1600, opts.bust ?? '', opts.original ?? false)),
  getFile: async () => null,
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
    return res.ok
  } catch {
    return false
  }
}
