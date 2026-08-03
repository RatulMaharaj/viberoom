/** Encoding a decoded linear frame into the texture bytes the GPU renderer
 *  uploads — the client-side replacement for `engine/source.py`.
 *
 *  The wire formats are unchanged, and they have to be: `gpu/renderer.ts`
 *  uploads these buffers straight to WebGL2, so the layout is fixed by the
 *  driver, not by us. RGB9_E5 is 4 bytes/px and the default; RGBA16F is
 *  8 bytes/px for drivers that mishandle the packed format.
 *
 *  There is no PNG option for the same reason there never was: browsers decode
 *  PNG through ImageBitmap, which truncates every channel to 8 bits and throws
 *  away exactly the highlight headroom a RAW decode exists to carry.
 */

import type { LinearImage } from './types.ts'

export type SourceFormat = 'rgb9e5' | 'rgba16f'

/** Structurally identical to `gpu/source.ts`'s SourceFrame, so this drops into
 *  the place the `/source` fetch used to occupy. Redeclared rather than
 *  imported to keep the decode layer free of a dependency on the renderer. */
export interface SourceFrame {
  width: number
  height: number
  format: SourceFormat
  data: ArrayBuffer
}

// GL_UNSIGNED_INT_5_9_9_9_REV: three 9-bit mantissas sharing one 5-bit
// exponent, biased by 15. Largest representable value is (2^9-1)/2^9 * 2^16.
const MANTISSA_BITS = 9
const EXP_BIAS = 15
const MAX_EXP = 31
const RGB9E5_MAX = 65408

/** float16 saturates here; beyond it the cast produces inf, which a shader
 *  then propagates through every later op as NaN. */
const F16_MAX = 65504

function clamp(x: number, hi: number): number {
  if (!(x > 0)) return 0 // also catches NaN
  return x > hi ? hi : x
}

/** Packs linear RGB into GL_UNSIGNED_INT_5_9_9_9_REV, 4 bytes per pixel. */
export function encodeRgb9e5(img: LinearImage): ArrayBuffer {
  const src = img.data
  const out = new Uint32Array(img.width * img.height)
  for (let i = 0, p = 0; i < out.length; i++, p += 3) {
    const r = clamp(src[p], RGB9E5_MAX)
    const g = clamp(src[p + 1], RGB9E5_MAX)
    const b = clamp(src[p + 2], RGB9E5_MAX)
    const maxc = Math.max(r, g, b)

    // The all-zero pixel has no logarithm, so it is substituted out and lands
    // on a zero mantissa anyway.
    let exp = Math.max(Math.floor(Math.log2(maxc > 0 ? maxc : 1)), -EXP_BIAS - 1) + 1 + EXP_BIAS
    // Rounding the shared maximum can carry out of nine bits (511.5 -> 512);
    // the spec's remedy is to bump the exponent and quantize again.
    if (Math.floor(maxc / 2 ** (exp - EXP_BIAS - MANTISSA_BITS) + 0.5) >= 512) exp += 1
    exp = Math.min(Math.max(exp, 0), MAX_EXP)

    const quantum = 2 ** (exp - EXP_BIAS - MANTISSA_BITS)
    const mr = Math.min(511, Math.floor(r / quantum + 0.5))
    const mg = Math.min(511, Math.floor(g / quantum + 0.5))
    const mb = Math.min(511, Math.floor(b / quantum + 0.5))
    out[i] = (mr | (mg << MANTISSA_BITS) | (mb << (2 * MANTISSA_BITS)) | (exp << (3 * MANTISSA_BITS))) >>> 0
  }
  return out.buffer
}

/** Half-float RGBA, 8 bytes per pixel, alpha pinned to 1.0. */
export function encodeRgba16f(img: LinearImage): ArrayBuffer {
  const src = img.data
  const n = img.width * img.height
  // Float16Array is too new to rely on, so the conversion goes through a
  // Float32Array view of a scratch buffer and DataView's rounding.
  const out = new Uint16Array(n * 4)
  const f32 = new Float32Array(1)
  const bits = new Uint32Array(f32.buffer)

  /** Round-to-nearest-even, as both numpy's float16 cast and the GPU do. Plain
   *  truncation would bias every channel down by half a quantum, which at the
   *  bottom of the range is a visible lift lost from the shadows. */
  const half = (x: number): number => {
    const v = clamp(x, F16_MAX)
    if (v < 6.103515625e-5) {
      // Subnormal: quantum is a fixed 2^-24, so this is one rounded division.
      const m = v * 16777216
      const down = Math.floor(m)
      const frac = m - down
      return down + (frac > 0.5 || (frac === 0.5 && (down & 1)) ? 1 : 0)
    }
    f32[0] = v
    const b = bits[0]
    // Carrying out of the mantissa lands in the exponent field on its own,
    // which is why exponent and mantissa are incremented as one number.
    let packed = ((((b >>> 23) & 0xff) - 112) << 10) | ((b >>> 13) & 0x3ff)
    const rest = b & 0x1fff
    if (rest > 0x1000 || (rest === 0x1000 && (packed & 1))) packed++
    return packed
  }
  const ONE = half(1)
  for (let i = 0, p = 0, o = 0; i < n; i++, p += 3, o += 4) {
    out[o] = half(src[p])
    out[o + 1] = half(src[p + 1])
    out[o + 2] = half(src[p + 2])
    out[o + 3] = ONE
  }
  return out.buffer
}

export function encodeSource(img: LinearImage, format: SourceFormat): SourceFrame {
  return {
    width: img.width,
    height: img.height,
    format,
    data: format === 'rgb9e5' ? encodeRgb9e5(img) : encodeRgba16f(img),
  }
}
