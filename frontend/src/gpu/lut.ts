/** .cube LUT parsing, transcribed from engine/ops/lut.py `parse_cube`.
 *
 *  The engine reads its LUTs from `~/.viberoom/luts` — a directory that does
 *  not exist in a browser. So the renderer takes LUT *data*, not a name: hand
 *  it a `LutData` with `GpuRenderer.setLut` and it uploads it as a texture.
 *  Where that data comes from is the caller's problem, and deliberately so —
 *  a PWA would parse a `.cube` the user dropped on the window (or one kept in
 *  IndexedDB) with `parseCube` below and pass the result straight in, with no
 *  server in the loop.
 *
 *  Nothing here touches the DOM or the network, so it is also the piece the
 *  parity harness can exercise directly.
 */

export class LutError extends Error {}

export interface LutData {
  kind: '1D' | '3D'
  /** Entries per axis: N for a 1D table, N per side for a 3D cube. */
  size: number
  /** RGB triples. 1D is N*3 in table order. 3D is N^3*3 with **red varying
   *  fastest**, then green, then blue — which is both `.cube` file order and
   *  the memory order of the engine's `cube[b, g, r]`, so it uploads to a
   *  TEXTURE_3D whose x axis is red with no reshuffling. */
  data: Float32Array
}

/** engine/ops/lut.py `parse_cube`. Values come out on the 0-1 domain. */
export function parseCube(text: string): LutData {
  let size1d = 0
  let size3d = 0
  const domMin = [0, 0, 0]
  const domMax = [1, 1, 1]
  const rows: number[] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#', 1)[0].trim()
    if (!line) continue
    const upper = line.toUpperCase()
    if (upper.startsWith('TITLE')) continue
    const parts = line.split(/\s+/)
    if (upper.startsWith('LUT_1D_SIZE')) size1d = parseInt(parts[1], 10)
    else if (upper.startsWith('LUT_3D_SIZE')) size3d = parseInt(parts[1], 10)
    else if (upper.startsWith('DOMAIN_MIN')) for (let i = 0; i < 3; i++) domMin[i] = Number(parts[i + 1])
    else if (upper.startsWith('DOMAIN_MAX')) for (let i = 0; i < 3; i++) domMax[i] = Number(parts[i + 1])
    else if (parts.length === 3) {
      for (const p of parts) {
        const v = Number(p)
        if (!Number.isFinite(v)) throw new LutError(`bad LUT data line: ${line}`)
        rows.push(v)
      }
    }
  }

  const span = domMin.map((lo, i) => Math.max(domMax[i] - lo, 1e-6))
  const normalize = (n: number): Float32Array => {
    const out = new Float32Array(n * 3)
    for (let i = 0; i < n * 3; i++) out[i] = (rows[i] - domMin[i % 3]) / span[i % 3]
    return out
  }

  if (size1d) {
    if (rows.length !== size1d * 3) {
      throw new LutError(`expected ${size1d} 1D entries, got ${rows.length / 3}`)
    }
    return { kind: '1D', size: size1d, data: normalize(size1d) }
  }
  if (size3d) {
    const n = size3d ** 3
    if (rows.length !== n * 3) {
      throw new LutError(`expected ${n} 3D entries, got ${rows.length / 3}`)
    }
    return { kind: '3D', size: size3d, data: normalize(n) }
  }
  throw new LutError('no LUT_1D_SIZE or LUT_3D_SIZE header found')
}
