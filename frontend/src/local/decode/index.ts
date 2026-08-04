/** Decoding images in the browser, with no server.
 *
 * One contract, two paths: RAW goes through LibRaw-wasm in a Web Worker, and
 * anything the browser already decodes goes through `createImageBitmap`. Both
 * end up as float32 linear RGB — the same array `engine/decode.py` produces —
 * so nothing downstream has to know which path a picture came in on.
 */

import { decodeBitmapBlob } from './bitmap.ts'
import { decodeCache, fileKey, frameCache } from './cache.ts'
import { linearToBitmap, orientBitmap } from './display.ts'
import { downscaleLinear, previewScale } from './downscale.ts'
import { metadataFromLibRaw, readExif, type ImageMetadata } from './exif.ts'
import { decodeRawBuffer, rawThumbnail, readRawMetadata, UnsupportedRawError } from './raw.ts'
import { encodeSource, type SourceFormat, type SourceFrame } from './source.ts'
import { isRaw, isSupported, type LinearImage } from './types.ts'

export type { LinearImage } from './types.ts'
export type { SourceFormat, SourceFrame } from './source.ts'
export type { ExifSummary, ImageMetadata, RawExif } from './exif.ts'
export { metadataFromLibRaw, readExif } from './exif.ts'
export { DecodeCache, decodeCache, fileKey, frameCache } from './cache.ts'
export { linearToBitmap, orientBitmap } from './display.ts'
export { downscaleLinear, previewScale, resizeLinear } from './downscale.ts'
export { encodeRgb9e5, encodeRgba16f, encodeSource } from './source.ts'
export { extensionOf, isRaw, isSupported } from './types.ts'
export { rawThumbnail, readRawMetadata, setRawDecoderFactory, UnsupportedRawError } from './raw.ts'
export type { RawDecoder, RawThumbnail } from './raw.ts'

/**
 * Decode one image to linear float32 RGB.
 *
 * Accepts an ArrayBuffer as well as a File because a RAW that arrived over a
 * drag-and-drop or a File System Access handle is already in memory, and
 * re-wrapping it in a Blob only to read it back would double peak memory on
 * files that routinely run to 80 MB.
 */
export async function decodeRaw(file: File | ArrayBuffer, name?: string): Promise<LinearImage> {
  const filename = name ?? (file instanceof File ? file.name : '')
  if (!isSupported(filename)) {
    throw new UnsupportedRawError(`unsupported file type: ${filename || 'unknown'}`)
  }
  if (!isRaw(filename)) {
    return decodeBitmapBlob(file instanceof File ? file : new Blob([file]))
  }
  return decodeRawBuffer(file instanceof File ? await file.arrayBuffer() : file)
}

/**
 * Catalog metadata for one file, from whichever reader can see it.
 *
 * exifr is asked first because it costs one header read and works on every
 * JPEG and most RAWs. It cannot open a Canon CR3 or a Fuji RAF, though, so for
 * a RAW it returned nothing on, LibRaw gets a turn — that only parses the
 * container, not the pixels, so the fallback is tens of milliseconds.
 */
export async function readMetadata(file: File): Promise<ImageMetadata> {
  const meta = await readExif(file)
  if (Object.keys(meta.exif).length > 0 || !isRaw(file.name)) return meta

  const libraw = await readRawMetadata(await file.arrayBuffer())
  return libraw ? metadataFromLibRaw(libraw) : meta
}

/** Cached decode. Repeated visits to one image — which is every recipe edit,
 *  and every step back through a filmstrip — pay LibRaw once. */
export function decodeCached(file: File): Promise<LinearImage> {
  return decodeCache.get(fileKey(file), () => decodeRaw(file))
}

/**
 * A bitmap no wider than `maxWidth`, as cheaply as the file allows.
 *
 * The grid asks for one of these per tile, so the ordering matters more than
 * the fidelity does: LibRaw's embedded preview first, because a full RAW
 * decode is 0.6-9 seconds and a folder of them would leave the grid grey for
 * minutes; the real decode only when the camera embedded nothing usable.
 *
 * The slow path shares `decodeCache` with the preview renderer, so a RAW that
 * had to be decoded for its thumbnail is already in memory when the user opens
 * it in the loupe.
 */
export async function thumbnailBitmap(file: File, maxWidth: number): Promise<ImageBitmap> {
  if (!isRaw(file.name)) {
    return createImageBitmap(file, {
      resizeWidth: maxWidth,
      resizeQuality: 'high',
      imageOrientation: 'from-image',
    })
  }

  const thumb = await rawThumbnail(await file.arrayBuffer())
  if (thumb) {
    // The embedded JPEG normally carries no EXIF of its own; `from-image` is
    // still asked for in case it does, and `orientBitmap` handles the usual
    // case from LibRaw's separately-reported flip.
    const bitmap = await createImageBitmap(thumb.blob, { imageOrientation: 'from-image' })
    return orientBitmap(bitmap, thumb.flip, maxWidth)
  }

  const full = await decodeCached(file)
  return linearToBitmap(downscaleLinear(full, previewScale(full, maxWidth)))
}

/**
 * The linear frame the GPU renderer draws from, ready to upload.
 *
 * Replaces `fetchSource` in `gpu/source.ts`: same fields, same texture layout,
 * and — importantly — the same *resolution* rule. The frame is cut to the size
 * the pipeline would render a preview at, not to `size` itself, so that a
 * client-rendered frame and a later full render depict the same image.
 */
/** Encoded frames, ready to hand straight to the GPU.
 *
 *  What is cached is the *packed* frame, not the linear one. Encoding was
 *  outside the cache, so every revisit re-packed several million pixels into
 *  RGB9_E5 in JavaScript before anything could be drawn — the decode was
 *  cached and the wait stayed. Packed is also the smaller of the two: 4 bytes
 *  per pixel against float32's 12, so an 11 MB entry replaces a 32 MB one.
 *
 *  Bounded by count rather than bytes because these are all one of two sizes.
 *  Sixteen covers arrowing back and forth through a filmstrip. */
const encodedFrames = new Map<string, SourceFrame>()
const ENCODED_LIMIT = 16

export async function sourceFrame(
  file: File,
  size: number,
  format: SourceFormat = 'rgb9e5',
): Promise<SourceFrame> {
  const key = fileKey(file, `|src${size}|${format}`)
  const hit = encodedFrames.get(key)
  if (hit) {
    // Re-insert so the LRU order reflects use, not arrival.
    encodedFrames.delete(key)
    encodedFrames.set(key, hit)
    return hit
  }

  const dbg = typeof location !== 'undefined'
    && new URLSearchParams(location.search).has('debug')
  const mark = (label: string, at: number) =>
    dbg && console.log(`[frame] ${label} ${Math.round(performance.now() - at)}ms`)

  const t0 = performance.now()
  const full = await decodeCached(file)
  mark(`decode ${full.width}x${full.height}`, t0)

  // The Lanczos pass over 24 MP is not cheap either, so the linear frame stays
  // cached as well — the export path asks for it at a different size.
  const t1 = performance.now()
  const frame = await frameCache.get(fileKey(file, `|src${size}`), async () =>
    downscaleLinear(full, previewScale(full, size)),
  )
  mark(`resize -> ${frame.width}x${frame.height}`, t1)

  const t2 = performance.now()
  const encoded = encodeSource(frame, format)
  mark('pack', t2)
  encodedFrames.set(key, encoded)
  while (encodedFrames.size > ENCODED_LIMIT) {
    encodedFrames.delete(encodedFrames.keys().next().value as string)
  }
  return encoded
}
