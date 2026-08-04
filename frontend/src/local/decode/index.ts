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
export async function sourceFrame(
  file: File,
  size: number,
  format: SourceFormat = 'rgb9e5',
): Promise<SourceFrame> {
  const full = await decodeCached(file)
  // Downscaled frames are cached too. Encoding is cheap next to decoding, but
  // the Lanczos pass over 24 MP is not, and a slider drag asks for the same
  // size over and over.
  const key = fileKey(file, `|src${size}`)
  const frame = await frameCache.get(key, async () =>
    downscaleLinear(full, previewScale(full, size)),
  )
  return encodeSource(frame, format)
}
