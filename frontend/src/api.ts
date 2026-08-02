const BASE = '/api/v1'

export type Flag = 'pick' | 'reject' | null

export interface ImageMeta {
  id: string
  rel_path: string
  filename: string
  ext: string
  is_raw: boolean
  filesize: number
  mtime: number
  width: number | null
  height: number | null
  exif: Record<string, string>
  rating: number
  flag: Flag
  has_edits: boolean
}

export interface Filters {
  rating_gte?: number
  flag?: 'pick' | 'reject' | 'none'
  ext?: string
  sort?: 'filename' | 'mtime' | 'rating'
  order?: 'asc' | 'desc'
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json()
}

export const api = {
  getLibrary: () => fetch(`${BASE}/library`).then((r) => json<{ library: string | null }>(r)),

  setLibrary: (path: string) =>
    fetch(`${BASE}/library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then((r) => json<{ library: string; total: number }>(r)),

  scan: () => fetch(`${BASE}/library/scan`, { method: 'POST' }).then((r) => json<object>(r)),

  listExts: () => fetch(`${BASE}/exts`).then((r) => json<{ exts: string[] }>(r)),

  browseFs: (path?: string) =>
    fetch(`${BASE}/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`).then((r) =>
      json<{ path: string | null; parent: string | null; dirs: string[] }>(r),
    ),

  listImages: (f: Filters = {}) => {
    const params = new URLSearchParams()
    if (f.rating_gte) params.set('rating_gte', String(f.rating_gte))
    if (f.flag) params.set('flag', f.flag)
    if (f.ext) params.set('ext', f.ext)
    if (f.sort) params.set('sort', f.sort)
    if (f.order) params.set('order', f.order)
    params.set('limit', '500')
    return fetch(`${BASE}/images?${params}`).then((r) =>
      json<{ total: number; images: ImageMeta[] }>(r),
    )
  },

  getImage: (id: string) => fetch(`${BASE}/images/${id}`).then((r) => json<ImageMeta>(r)),

  setRating: (id: string, rating: number) =>
    fetch(`${BASE}/images/${id}/rating`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating }),
    }).then((r) => json<object>(r)),

  setFlag: (id: string, flag: Flag) =>
    fetch(`${BASE}/images/${id}/flag`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag }),
    }).then((r) => json<object>(r)),

  getRecipe: (id: string) =>
    fetch(`${BASE}/images/${id}/recipe`).then((r) => json<Record<string, any>>(r)),

  putRecipe: (id: string, recipe: object) =>
    fetch(`${BASE}/images/${id}/recipe`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recipe),
    }).then((r) => json<Record<string, any>>(r)),

  patchRecipe: (id: string, patch: object) =>
    fetch(`${BASE}/images/${id}/recipe`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<Record<string, any>>(r)),

  autoAdjust: (id: string) =>
    fetch(`${BASE}/images/${id}/auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ white_balance: true }),
    }).then((r) => json<Record<string, any>>(r)),

  resetRecipe: (id: string) =>
    fetch(`${BASE}/images/${id}/recipe`, { method: 'DELETE' }).then((r) =>
      json<Record<string, any>>(r),
    ),

  exportImage: (id: string, opts: { quality?: number; max_dimension?: number } = {}) =>
    fetch(`${BASE}/images/${id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    }).then((r) => json<{ path: string }>(r)),

  thumbnailUrl: (id: string) => `${BASE}/images/${id}/thumbnail`,
  previewUrl: (id: string, size = 1600, bust = '', original = false, nocrop = false) =>
    `${BASE}/images/${id}/preview?size=${size}${original ? '&original=true' : ''}${nocrop ? '&nocrop=true' : ''}${bust ? `&t=${bust}` : ''}`,
}
