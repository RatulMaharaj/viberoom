/** Turning decoded pixels back into something the DOM can draw.
 *
 * Everything else in this directory moves towards linear float32, because that
 * is what the renderer and the Python engine agree on. This is the one file
 * that goes the other way: linear light in, 8-bit sRGB `ImageBitmap` out, for
 * the grid and the filmstrip where the only consumer is an `<img>`.
 */

import type { LinearImage } from './types.ts'

const SRGB_GAMMA = 2.4

/** Inverse of `bitmap.ts::srgbToLinear`, i.e. `engine/encode.py`'s transfer. */
function linearToSrgb(x: number): number {
  if (!(x > 0)) return 0 // also catches NaN
  if (x >= 1) return 1
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / SRGB_GAMMA) - 0.055
}

/**
 * 8-bit sRGB from linear float.
 *
 * No lookup table: unlike the decode direction, the input here is a float, so
 * a table would have to be indexed by a quantized value and would introduce an
 * error the server does not have. It runs on already-downscaled frames only —
 * a thumbnail, not a 24 MP decode — so the pow per subpixel is affordable.
 */
export function linearToBitmap(img: LinearImage): Promise<ImageBitmap> {
  const { width, height, data } = img
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let i = 0, p = 0, o = 0; i < width * height; i++, p += 3, o += 4) {
    rgba[o] = linearToSrgb(data[p]) * 255 + 0.5
    rgba[o + 1] = linearToSrgb(data[p + 1]) * 255 + 0.5
    rgba[o + 2] = linearToSrgb(data[p + 2]) * 255 + 0.5
    rgba[o + 3] = 255
  }
  return createImageBitmap(new ImageData(rgba, width, height))
}

/**
 * Apply an EXIF orientation to a bitmap, and cap its width.
 *
 * LibRaw hands back the embedded preview exactly as the camera wrote it —
 * unrotated, and usually with no EXIF of its own — while reporting the
 * orientation separately. Drawing it as-is puts every portrait frame on its
 * side, which is precisely the kind of silently-wrong output this codebase
 * refuses elsewhere.
 */
export async function orientBitmap(
  bitmap: ImageBitmap,
  flip: number,
  maxWidth: number,
): Promise<ImageBitmap> {
  // EXIF numbering, as LibRaw reports it in `sizes.flip`: 3 is 180 degrees,
  // 5 is 90 CCW, 6 is 90 CW. Anything else (0, 1, or a mirrored value we do
  // not handle) is drawn straight through.
  const turn = flip === 3 ? 180 : flip === 5 ? 270 : flip === 6 ? 90 : 0
  const swapped = turn === 90 || turn === 270
  const srcW = swapped ? bitmap.height : bitmap.width
  const srcH = swapped ? bitmap.width : bitmap.height
  if (turn === 0 && srcW <= maxWidth) return bitmap

  const scale = Math.min(1, maxWidth / srcW)
  const w = Math.max(1, Math.round(srcW * scale))
  const h = Math.max(1, Math.round(srcH * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) return bitmap
  ctx.translate(w / 2, h / 2)
  ctx.rotate((turn * Math.PI) / 180)
  const drawW = (swapped ? h : w)
  const drawH = (swapped ? w : h)
  ctx.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH)
  bitmap.close()
  return canvas.transferToImageBitmap()
}
