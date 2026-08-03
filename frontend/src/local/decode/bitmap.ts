/** The non-RAW path: JPEG, PNG, WebP.
 *
 * No wasm here. The browser already has decoders for these, and
 * `createImageBitmap` runs them off the main thread; the pixels come back
 * through an OffscreenCanvas because that is the only way to read an
 * ImageBitmap's samples.
 */

import type { LinearImage } from './types.ts'

const SRGB_GAMMA = 2.4

/** `engine/decode.py::_srgb_to_linear`, per sample. */
function srgbToLinear(x: number): number {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, SRGB_GAMMA)
}

/**
 * 8-bit sRGB has 256 possible inputs, so the transfer curve is a 256-entry
 * table rather than a pow per subpixel — ~75 million of them on a 24 MP frame.
 * Unlike the LUT the server rejected for the *inverse* direction, this one is
 * exact: it is indexed by the integer sample, not by a quantized float.
 */
const SRGB_LUT = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255))

export async function decodeBitmapBlob(blob: Blob): Promise<LinearImage> {
  // `imageOrientation: 'from-image'` is the browser's equivalent of Pillow's
  // exif_transpose — without it a portrait JPEG decodes on its side.
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    // willReadFrequently is deliberately off: this reads back exactly once, and
    // the hint forces a software canvas that draws the bitmap far slower.
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
    if (!ctx) throw new Error('no 2d context for image decode')
    ctx.drawImage(bitmap, 0, 0)
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)

    // Alpha is dropped rather than composited: the pipeline is RGB throughout,
    // and matting against an invented background would be a decision this
    // layer has no business making.
    const out = new Float32Array(bitmap.width * bitmap.height * 3)
    for (let i = 0, o = 0; o < out.length; i += 4, o += 3) {
      out[o] = SRGB_LUT[data[i]]
      out[o + 1] = SRGB_LUT[data[i + 1]]
      out[o + 2] = SRGB_LUT[data[i + 2]]
    }
    return { width: bitmap.width, height: bitmap.height, data: out }
  } finally {
    bitmap.close()
  }
}
