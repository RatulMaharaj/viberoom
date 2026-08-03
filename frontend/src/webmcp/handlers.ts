/** What the tools actually do, with no WebMCP in sight.
 *
 *  The registration in `tools.ts` is a shim over these; keeping them as plain
 *  async functions means they can be called (and tested) in any browser, not
 *  only the one shipping `navigator.modelContext`.
 *
 *  Everything goes through `getSource()`, so the same tools work whether the
 *  photos come from the Python server or straight off the user's disk.
 */

import { getSource, type Filters, type ImageMeta } from '../source'
import { loadLastImage } from '../selection'

/** The listing is what an agent reads to find ids, and a 200-row page of full
 *  EXIF is mostly noise in a context window. Trim to what identifies an image
 *  and what the cull filters key off. */
function summarize(m: ImageMeta) {
  return {
    id: m.id,
    filename: m.filename,
    rel_path: m.rel_path,
    ext: m.ext,
    is_raw: m.is_raw,
    width: m.width,
    height: m.height,
    rating: m.rating,
    flag: m.flag,
    has_edits: m.has_edits,
  }
}

export async function listImages(input: Filters = {}) {
  const source = await getSource()
  const { total, images } = await source.listImages(input)
  return { total, count: images.length, images: images.map(summarize) }
}

export async function getImage(input: { image_id: string }) {
  const source = await getSource()
  return await source.getImage(input.image_id)
}

/** The selection lives in the tab, not in a database — the PWA has no session
 *  endpoint to ask. `selection.ts` is already the one place that records it. */
export async function getCurrentImage() {
  const image_id = loadLastImage()
  if (!image_id) return { image_id: null }
  const source = await getSource()
  try {
    return { image_id, image: await source.getImage(image_id) }
  } catch {
    // The library can have been closed or reopened since the id was stored.
    return { image_id: null }
  }
}

export async function setRating(input: { image_id: string; rating: number }) {
  const source = await getSource()
  await source.setRating(input.image_id, input.rating)
  return { image_id: input.image_id, rating: input.rating }
}

export async function setFlag(input: { image_id: string; flag: 'pick' | 'reject' | null }) {
  const source = await getSource()
  await source.setFlag(input.image_id, input.flag ?? null)
  return { image_id: input.image_id, flag: input.flag ?? null }
}

export async function getRecipe(input: { image_id: string }) {
  const source = await getSource()
  return await source.getRecipe(input.image_id)
}

export async function updateRecipe(input: { image_id: string; patch: Record<string, unknown> }) {
  const source = await getSource()
  return await source.patchRecipe(input.image_id, input.patch)
}

export async function setRecipe(input: { image_id: string; recipe: Record<string, unknown> }) {
  const source = await getSource()
  return await source.putRecipe(input.image_id, input.recipe)
}

export async function resetRecipe(input: { image_id: string }) {
  const source = await getSource()
  return await source.resetRecipe(input.image_id)
}

/** Rendered pixels, base64'd. An agent cannot follow a `blob:` URL out of the
 *  page, so the bytes have to travel inline — and the object URL has to be
 *  released here or the whole decoded frame stays resident. */
export async function renderPreview(input: { image_id: string; size?: number }) {
  const source = await getSource()
  const size = clamp(input.size ?? 1024, 256, 4096)
  const shot = await source.preview(input.image_id, { size })
  try {
    const blob = await (await fetch(shot.url)).blob()
    return {
      image_id: input.image_id,
      size,
      // Which edits the pixels actually reflect: the browser renderer covers
      // less of the recipe than the server does, and an agent judging its own
      // edit needs to know that before it trusts what it sees.
      rendered: shot.rendered ?? 'unknown',
      mimeType: blob.type || 'image/jpeg',
      data: await base64(blob),
    }
  } finally {
    shot.release()
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const url = reader.result as string
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}
