/** Deciding whether the GPU path may run at all.
 *
 *  Precedence is `?gpu=0|1`, then the stored preference, then detection. The
 *  URL wins so a bug report can be reproduced (or ruled out) without touching
 *  settings, and detection is last because it is the only one that can be
 *  wrong.
 */

import { encodeRgb9e5 } from './encode'
import { GpuRenderer, GpuUnavailable } from './renderer'

const STORAGE_KEY = 'viberoom.gpuPreview'

/** An explicit yes/no from the URL or localStorage, or null for "decide". */
export function gpuOverride(): boolean | null {
  const q = new URLSearchParams(window.location.search).get('gpu')
  if (q === '0') return false
  if (q === '1') return true
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === '0') return false
    if (stored === '1') return true
  } catch {
    // private-mode storage throws; that is not a reason to refuse to render
  }
  return null
}

/** A colour with three distinguishable channels and no headroom, so the
 *  expected output is a value anyone can check by hand against the sRGB
 *  transfer function. */
const PROBE = [0.5, 0.25, 0.75]

const srgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

let cached: boolean | null = null

/**
 * One-frame smoke render, compared against a known answer.
 *
 * Feature queries are not enough. Drivers exist that advertise WebGL2 and
 * EXT_color_buffer_float, link the program without complaint, and then render
 * a black or garbled frame — and a wrong preview is far worse than a slow one,
 * so nothing is taken on trust that can be measured instead.
 */
export function detectGpuSupport(): boolean {
  if (cached !== null) return cached
  cached = false
  let renderer: GpuRenderer | null = null
  try {
    const canvas = document.createElement('canvas')
    renderer = new GpuRenderer(canvas)
    renderer.setSource({
      width: 1,
      height: 1,
      format: 'rgb9e5',
      data: encodeRgb9e5(Float32Array.from(PROBE), 1, 1),
    })
    // An empty recipe: the only thing left in the chain is the sRGB transfer,
    // which makes the expected pixel exact rather than a tolerance guess.
    renderer.render({})
    const px = renderer.readPixels()
    cached = PROBE.every((v, i) => Math.abs(px[i] - Math.round(srgb(v) * 255)) <= 2)
  } catch (e) {
    if (!(e instanceof GpuUnavailable)) console.warn('gpu preview smoke test failed', e)
    cached = false
  } finally {
    renderer?.dispose()
  }
  return cached
}

/**
 * Is the GPU path allowed in this session?
 *
 * On by default where detection says it will work. It shipped opt-in until a
 * real frame had been confirmed on real hardware (Apple M4 / ANGLE Metal),
 * since the numpy parity check and the smoke test above, between them, still
 * cannot prove a driver renders the whole chain correctly.
 *
 * `?gpu=0` remains the escape hatch, and every recipe the shader does not
 * implement still falls back on its own.
 */
export function gpuEnabled(): boolean {
  return gpuOverride() ?? detectGpuSupport()
}
