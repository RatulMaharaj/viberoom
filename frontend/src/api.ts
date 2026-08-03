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


export interface HistoryEntry {
  index?: number
  at?: number
  label?: string
  [k: string]: any
}

export interface Iptc {
  title?: string
  caption?: string
  copyright?: string
  creator?: string
}

export interface MapPoint {
  id: string
  filename?: string
  lat: number
  lon: number
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

  browseFs: (path?: string, hidden = false) =>
    fetch(
      `${BASE}/fs?${new URLSearchParams({
        ...(path ? { path } : {}),
        ...(hidden ? { hidden: 'true' } : {}),
      })}`,
    ).then((r) =>
      json<{ path: string | null; parent: string | null; dirs: string[] }>(r),
    ),

  nativePickerAvailable: () =>
    fetch(`${BASE}/fs/native-picker`).then((r) => json<{ available: boolean }>(r)),

  nativePicker: (start?: string | null) =>
    fetch(`${BASE}/fs/native-picker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: start ?? null }),
    }).then((r) => json<{ path: string | null; cancelled: boolean }>(r)),

  mkdir: (parent: string, name: string) =>
    fetch(`${BASE}/fs/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, name }),
    }).then((r) => json<{ path: string }>(r)),

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

  exportImage: (id: string, opts: Record<string, any> = {}) =>
    fetch(`${BASE}/images/${id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    }).then((r) => json<{ path: string }>(r)),

  thumbnailUrl: (id: string) => `${BASE}/images/${id}/thumbnail`,
  previewUrl: (id: string, size = 1600, bust = '', original = false, nocrop = false) =>
    `${BASE}/images/${id}/preview?size=${size}${original ? '&original=true' : ''}${nocrop ? '&nocrop=true' : ''}${bust ? `&t=${bust}` : ''}`,

  // ---------- history, snapshots, virtual copies ----------

  getHistory: (id: string) =>
    fetch(`${BASE}/images/${id}/history`).then((r) => json<{ history: HistoryEntry[] }>(r)),

  restoreHistory: (id: string, index: number) =>
    fetch(`${BASE}/images/${id}/history/${index}/restore`, { method: 'POST' }).then((r) =>
      json<Record<string, any>>(r),
    ),

  saveSnapshot: (id: string, name: string) =>
    fetch(`${BASE}/images/${id}/snapshots/${encodeURIComponent(name)}`, { method: 'PUT' }).then(
      (r) => json<object>(r),
    ),

  deleteSnapshot: (id: string, name: string) =>
    fetch(`${BASE}/images/${id}/snapshots/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(
      (r) => json<object>(r),
    ),

  restoreSnapshot: (id: string, name: string) =>
    fetch(`${BASE}/images/${id}/snapshots/${encodeURIComponent(name)}/restore`, {
      method: 'POST',
    }).then((r) => json<Record<string, any>>(r)),

  saveVariant: (id: string, name: string) =>
    fetch(`${BASE}/images/${id}/variants/${encodeURIComponent(name)}`, { method: 'PUT' }).then((r) =>
      json<object>(r),
    ),

  deleteVariant: (id: string, name: string) =>
    fetch(`${BASE}/images/${id}/variants/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(
      (r) => json<object>(r),
    ),

  promoteVariant: (id: string, name: string) =>
    fetch(`${BASE}/images/${id}/variants/${encodeURIComponent(name)}/promote`, {
      method: 'POST',
    }).then((r) => json<object>(r)),

  // ---------- metadata ----------

  getIptc: (id: string) =>
    fetch(`${BASE}/images/${id}/iptc`).then((r) => json<Iptc>(r)),

  setIptc: (id: string, body: Iptc) =>
    fetch(`${BASE}/images/${id}/iptc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<Iptc>(r)),

  getXmp: (id: string) => fetch(`${BASE}/images/${id}/xmp`).then((r) => json<any>(r)),

  writeXmp: (id: string) =>
    fetch(`${BASE}/images/${id}/xmp/write`, { method: 'POST' }).then((r) => json<object>(r)),

  setKeywords: (id: string, keywords: string[]) =>
    fetch(`${BASE}/images/${id}/keywords`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords }),
    }).then((r) => json<{ keywords: string[] }>(r)),

  listKeywords: () => fetch(`${BASE}/keywords`).then((r) => json<{ keywords: string[] }>(r)),

  setLabel: (id: string, label: string | null) =>
    fetch(`${BASE}/images/${id}/label`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    }).then((r) => json<object>(r)),

  // ---------- enhance & proofing ----------

  enhance: (id: string, model?: string) =>
    fetch(`${BASE}/images/${id}/enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model ? { model } : {}),
    }).then((r) => json<object>(r)),

  proofUrl: (id: string, space: string, warn = true, size = 2048, bust = '') =>
    `${BASE}/images/${id}/proof?space=${space}&warn=${warn}&size=${size}${bust ? `&t=${bust}` : ''}`,

  // ---------- collections, stacks, duplicates ----------

  listCollections: () =>
    fetch(`${BASE}/collections`).then((r) => json<{ collections: Record<string, string[]> }>(r)),

  putCollection: (name: string) =>
    fetch(`${BASE}/collections/${encodeURIComponent(name)}`, { method: 'PUT' }).then((r) =>
      json<object>(r),
    ),

  deleteCollection: (name: string) =>
    fetch(`${BASE}/collections/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
      json<object>(r),
    ),

  editCollection: (name: string, body: { add?: string[]; remove?: string[] }) =>
    fetch(`${BASE}/collections/${encodeURIComponent(name)}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<object>(r)),

  createStack: (image_ids: string[]) =>
    fetch(`${BASE}/stacks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_ids }),
    }).then((r) => json<object>(r)),

  autoStack: () => fetch(`${BASE}/stacks/auto`, { method: 'POST' }).then((r) => json<object>(r)),

  deleteStack: (stackId: string) =>
    fetch(`${BASE}/stacks/${encodeURIComponent(stackId)}`, { method: 'DELETE' }).then((r) =>
      json<object>(r),
    ),

  duplicates: () => fetch(`${BASE}/duplicates`).then((r) => json<{ groups: string[][] }>(r)),

  // ---------- merge, import, faces, map, tether ----------

  mergeHdr: (image_ids: string[], out_name?: string) =>
    fetch(`${BASE}/merge/hdr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_ids, out_name }),
    }).then((r) => json<{ path?: string }>(r)),

  mergePano: (image_ids: string[], out_name?: string) =>
    fetch(`${BASE}/merge/pano`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_ids, out_name }),
    }).then((r) => json<{ path?: string }>(r)),

  importPhotos: (body: Record<string, any>) =>
    fetch(`${BASE}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<Record<string, any>>(r)),

  facesSetup: () => fetch(`${BASE}/faces/setup`, { method: 'POST' }).then((r) => json<object>(r)),
  facesScan: () => fetch(`${BASE}/faces/scan`, { method: 'POST' }).then((r) => json<object>(r)),
  mapPoints: () => fetch(`${BASE}/map`).then((r) => json<{ points: MapPoint[] }>(r)),

  tetherStatus: () => fetch(`${BASE}/tether`).then((r) => json<Record<string, any>>(r)),
  tetherCapture: () =>
    fetch(`${BASE}/tether/capture`, { method: 'POST' }).then((r) => json<Record<string, any>>(r)),

  // ---------- roots, LUTs, presets ----------

  listRoots: () => fetch(`${BASE}/library/roots`).then((r) => json<{ roots: string[] }>(r)),
  addRoot: (path: string) =>
    fetch(`${BASE}/library/roots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then((r) => json<object>(r)),
  removeRoot: (path: string) =>
    fetch(`${BASE}/library/roots?path=${encodeURIComponent(path)}`, { method: 'DELETE' }).then(
      (r) => json<object>(r),
    ),

  listLuts: () => fetch(`${BASE}/luts`).then((r) => json<{ luts: string[] }>(r)),
  putLut: (name: string, content: string) =>
    fetch(`${BASE}/luts/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).then((r) => json<object>(r)),
  deleteLut: (name: string) =>
    fetch(`${BASE}/luts/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
      json<object>(r),
    ),

  listPresets: () => fetch(`${BASE}/presets`).then((r) => json<{ presets: string[] }>(r)),
  savePreset: (name: string, recipe: object) =>
    fetch(`${BASE}/presets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recipe),
    }).then((r) => json<object>(r)),
  deletePreset: (name: string) =>
    fetch(`${BASE}/presets/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
      json<object>(r),
    ),
  applyPreset: (name: string, image_ids: string[]) =>
    fetch(`${BASE}/presets/${encodeURIComponent(name)}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_ids }),
    }).then((r) => json<object>(r)),

  listExportPresets: () =>
    fetch(`${BASE}/export-presets`).then((r) => json<{ presets: Record<string, any> }>(r)),
  putExportPreset: (name: string, settings: object) =>
    fetch(`${BASE}/export-presets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    }).then((r) => json<object>(r)),
  deleteExportPreset: (name: string) =>
    fetch(`${BASE}/export-presets/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
      json<object>(r),
    ),

  // ---------- batch ----------

  batchRecipe: (body: Record<string, any>) =>
    fetch(`${BASE}/batch/recipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<Record<string, any>>(r)),

  batchMeta: (body: Record<string, any>) =>
    fetch(`${BASE}/batch/meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<Record<string, any>>(r)),

  batchExport: (body: Record<string, any>) =>
    fetch(`${BASE}/batch/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<Record<string, any>>(r)),
}
