/** Turning a file on disk into something an <img> can show.
 *
 *  For formats the browser already decodes this is one `createImageBitmap`
 *  call with `resizeWidth`, which downscales during decode rather than after —
 *  the difference between a few MB and a few hundred MB of bitmaps across a
 *  grid of a thousand photos.
 *
 *  RAW arrives through the hook below rather than by importing `local/decode/`
 *  directly, which keeps this module free of the wasm decoder and of any
 *  opinion about how a RAW gets to be a bitmap. `local/index.ts` registers the
 *  real one.
 */

const BROWSER_DECODABLE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'])

/** Filled in by `local/decode/` — takes the original file, returns RGBA pixels
 *  at roughly `maxWidth`. Left null until that lands. */
export type RawDecoder = (file: File, maxWidth: number) => Promise<ImageBitmap>
let rawDecoder: RawDecoder | null = null

export function registerRawDecoder(decoder: RawDecoder): void {
  rawDecoder = decoder
}

export function canDecodeInBrowser(ext: string): boolean {
  return BROWSER_DECODABLE.has(ext)
}

/** A bitmap for `file`, no wider than `maxWidth`. Throws if nothing can decode
 *  it — callers fall back to `placeholderUrl()`. */
export async function decodeToBitmap(
  file: File,
  ext: string,
  maxWidth: number,
): Promise<ImageBitmap> {
  if (canDecodeInBrowser(ext)) {
    return createImageBitmap(file, { resizeWidth: maxWidth, resizeQuality: 'high' })
  }
  // TIFF/HEIC land here too: Chromium decodes neither reliably, and both are
  // close enough to RAW in cost that the decode agent's path is the right home.
  if (rawDecoder) return rawDecoder(file, maxWidth)
  throw new Error(`No decoder for ${ext}`)
}

/** JPEG bytes for a decoded bitmap, which is what actually gets cached: a
 *  thumbnail blob is tens of kilobytes where the bitmap it came from is
 *  megabytes of RGBA. Closes the bitmap. */
export async function bitmapToBlob(bitmap: ImageBitmap, quality = 0.85): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D context')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}

/** Object-URL for a decoded bitmap. Caller revokes. */
export async function bitmapToUrl(bitmap: ImageBitmap, quality = 0.85): Promise<string> {
  return URL.createObjectURL(await bitmapToBlob(bitmap, quality))
}

/** A neutral tile for anything we cannot decode yet, so an undecodable RAW
 *  reads as "not ready" rather than as a broken image. */
export function placeholderUrl(label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="213">
<rect width="100%" height="100%" fill="#1d232a"/>
<text x="50%" y="50%" fill="#7a8590" font-family="monospace" font-size="20"
 text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
}
