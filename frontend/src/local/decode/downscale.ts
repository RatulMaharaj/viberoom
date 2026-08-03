/** Lanczos downscale of a linear float image.
 *
 * A port of what `engine/cache.py::_downscale_linear` does with PIL, and it has
 * to stay a port: the client-side GPU preview and the settled server render are
 * meant to be the same image, so a different resampler would show up as a
 * visible change at the swap.
 *
 * Resampling happens in linear light, which is where averaging pixels is
 * physically meaningful — the same reduction after the sRGB transfer curve
 * would darken every gradient.
 *
 * The `halfSize` decode LibRaw-wasm advertises does not work in this build, so
 * this is also the *only* way to get a cheap frame out of a RAW: decode full
 * size once and shrink here.
 */

import type { LinearImage } from './types.ts'

const SUPPORT = 3 // Lanczos3, matching PIL's LANCZOS

/** Precomputed per-output-pixel taps for one axis. */
interface Coeffs {
  /** First contributing input index for output pixel i, at `bounds[i * 2]`,
   *  and the tap count at `bounds[i * 2 + 1]`. */
  bounds: Int32Array
  weights: Float32Array
  /** Stride of the weight block per output pixel — the widest support used. */
  stride: number
}

function lanczos(x: number): number {
  if (x === 0) return 1
  if (x >= SUPPORT || x <= -SUPPORT) return 0
  const px = Math.PI * x
  return (SUPPORT * Math.sin(px) * Math.sin(px / SUPPORT)) / (px * px)
}

/**
 * PIL's `precompute_coeffs`, tap for tap.
 *
 * The filter is *stretched* by the reduction factor when shrinking — a
 * fixed-width kernel would sample far too sparsely and alias. That stretch is
 * the whole reason a naive "average N pixels" downscale looks different from
 * PIL's, so it is reproduced rather than approximated.
 */
function coeffsFor(inSize: number, outSize: number): Coeffs {
  const scale = inSize / outSize
  const filterScale = Math.max(scale, 1)
  const support = SUPPORT * filterScale
  const stride = Math.ceil(support) * 2 + 1

  const bounds = new Int32Array(outSize * 2)
  const weights = new Float32Array(outSize * stride)

  for (let i = 0; i < outSize; i++) {
    const center = (i + 0.5) * scale
    const start = Math.max(0, Math.floor(center - support + 0.5))
    // Both bounds truncate, PIL's `(int)` — rounding the far edge up instead
    // would add a tap PIL never weighs.
    const end = Math.min(inSize, Math.floor(center + support + 0.5))
    const count = end - start

    let total = 0
    const base = i * stride
    for (let j = 0; j < count; j++) {
      const w = lanczos((start + j + 0.5 - center) / filterScale)
      weights[base + j] = w
      total += w
    }
    // Normalizing keeps a flat field flat; the raw taps sum to slightly off 1.
    if (total !== 0) {
      for (let j = 0; j < count; j++) weights[base + j] /= total
    }
    bounds[i * 2] = start
    bounds[i * 2 + 1] = count
  }
  return { bounds, weights, stride }
}

/** One separable pass over rows (horizontal) into a fresh buffer. */
function resampleAxis(
  src: Float32Array,
  srcW: number,
  height: number,
  outW: number,
  c: Coeffs,
  clip: boolean,
): Float32Array {
  const out = new Float32Array(outW * height * 3)
  for (let y = 0; y < height; y++) {
    const rowIn = y * srcW * 3
    const rowOut = y * outW * 3
    for (let x = 0; x < outW; x++) {
      const start = c.bounds[x * 2]
      const count = c.bounds[x * 2 + 1]
      const wBase = x * c.stride
      let r = 0, g = 0, b = 0
      for (let j = 0; j < count; j++) {
        const w = c.weights[wBase + j]
        const p = rowIn + (start + j) * 3
        r += src[p] * w
        g += src[p + 1] * w
        b += src[p + 2] * w
      }
      const o = rowOut + x * 3
      out[o] = clip && !(r > 0) ? 0 : r
      out[o + 1] = clip && !(g > 0) ? 0 : g
      out[o + 2] = clip && !(b > 0) ? 0 : b
    }
  }
  return out
}

/** Transpose an interleaved RGB image, so the vertical pass can reuse the
 *  horizontal one and keep every read sequential. */
function transpose(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const o = (x * h + y) * 3
      out[o] = src[i]
      out[o + 1] = src[i + 1]
      out[o + 2] = src[i + 2]
    }
  }
  return out
}

/** Shrink by `scale` (<= 1). Returns the input untouched at scale 1. */
export function downscaleLinear(img: LinearImage, scale: number): LinearImage {
  const tw = Math.max(1, Math.round(img.width * scale))
  const th = Math.max(1, Math.round(img.height * scale))
  return resizeLinear(img, tw, th)
}

/** Resample to exact dimensions. */
export function resizeLinear(img: LinearImage, tw: number, th: number): LinearImage {
  if (tw === img.width && th === img.height) return img

  // Only the second pass clamps. Lanczos overshoots at hard edges and negative
  // light is not a thing, but clamping the intermediate too would throw away
  // undershoot that the vertical taps are still entitled to weigh — and the
  // server clamps once, at the end, for the same reason.
  const horizontal = resampleAxis(
    img.data, img.width, img.height, tw, coeffsFor(img.width, tw), false,
  )
  // Second pass runs on the transpose, then transposes back: strictly two
  // extra copies, and still faster than striding a 24 MP buffer column-wise.
  const swapped = transpose(horizontal, tw, img.height)
  const vertical = resampleAxis(swapped, img.height, tw, th, coeffsFor(img.height, th), true)
  return { width: tw, height: th, data: transpose(vertical, th, tw) }
}

/**
 * Extra input resolution kept beyond what the output strictly needs, so that
 * rotation and perspective have real pixels to resample from at the edges
 * instead of inventing them. Same constant as `engine/cache.py`.
 */
const RESAMPLE_MARGIN = 1.15

/**
 * How much to shrink a decoded frame before rendering it at `size`.
 *
 * `engine/cache.py::_preview_scale` with the crop term dropped: the client
 * renderer only ever handles uncropped recipes, which is the same assumption
 * `engine/source.py` makes when it passes a default Recipe.
 */
export function previewScale(img: { width: number; height: number }, size: number): number {
  return Math.min(1, (size * RESAMPLE_MARGIN) / Math.max(img.width, img.height))
}
