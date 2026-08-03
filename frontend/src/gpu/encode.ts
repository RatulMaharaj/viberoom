/** RGB9_E5 packing, client side.
 *
 *  The server does all the real encoding (engine/source.py); this exists only
 *  so the capability probe can build a one-pixel texture without a round-trip,
 *  and it is the same arithmetic so that a driver that mangles the format
 *  fails the probe for the same reason it would mangle a real frame.
 */

/** Packs `rgb` (3 floats per pixel, row-major) into GL_UNSIGNED_INT_5_9_9_9_REV. */
export function encodeRgb9e5(rgb: ArrayLike<number>, width: number, height: number): ArrayBuffer {
  const out = new Uint32Array(width * height)
  for (let i = 0; i < out.length; i++) {
    const r = Math.max(0, rgb[i * 3])
    const g = Math.max(0, rgb[i * 3 + 1])
    const b = Math.max(0, rgb[i * 3 + 2])
    const maxc = Math.max(r, g, b)

    let exp = Math.max(Math.floor(Math.log2(maxc > 0 ? maxc : 1)), -16) + 16
    if (Math.floor(maxc / 2 ** (exp - 24) + 0.5) >= 512) exp += 1
    exp = Math.min(exp, 31)

    const q = 2 ** (exp - 24)
    const m = (v: number) => Math.min(511, Math.floor(v / q + 0.5))
    out[i] = m(r) | (m(g) << 9) | (m(b) << 18) | (exp << 27)
  }
  return out.buffer
}
