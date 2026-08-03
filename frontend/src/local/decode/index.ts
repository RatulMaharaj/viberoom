/** Decoding images in the browser, with no server.
 *
 * One contract, two paths: RAW goes through LibRaw-wasm in a Web Worker, and
 * anything the browser already decodes goes through `createImageBitmap`. Both
 * end up as float32 linear RGB — the same array `engine/decode.py` produces —
 * so nothing downstream has to know which path a picture came in on.
 */

import { decodeBitmapBlob } from './bitmap.ts'
import { decodeCache, fileKey } from './cache.ts'
import { downscaleLinear, previewScale } from './downscale.ts'
import { metadataFromLibRaw, readExif, type ImageMetadata } from './exif.ts'
import { decodeRawBuffer, readRawMetadata, UnsupportedRawError } from './raw.ts'
import { encodeSource, type SourceFormat, type SourceFrame } from './source.ts'
import { isRaw, isSupported, type LinearImage } from './types.ts'

export type { LinearImage } from './types.ts'
export type { SourceFormat, SourceFrame } from './source.ts'
export type { ExifSummary, ImageMetadata, RawExif } from './exif.ts'
export { metadataFromLibRaw, readExif } from './exif.ts'
export { DecodeCache, decodeCache, fileKey } from './cache.ts'
export { downscaleLinear, previewScale, resizeLinear } from './downscale.ts'
export { encodeRgb9e5, encodeRgba16f, encodeSource } from './source.ts'
export { extensionOf, isRaw, isSupported } from './types.ts'
export { readRawMetadata, setRawDecoderFactory, UnsupportedRawError } from './raw.ts'
export type { RawDecoder } from './raw.ts'

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
  const frame = await decodeCache.get(key, async () =>
    downscaleLinear(full, previewScale(full, size)),
  )
  return encodeSource(frame, format)
}
