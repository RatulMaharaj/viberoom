/** Recipe -> shader uniforms.
 *
 *  Everything that is constant across the frame is folded here rather than in
 *  GLSL: the sigmoid's normalization constants, the white-balance gains, the
 *  grading wheels' chroma offsets. It keeps the per-pixel work to the parts
 *  that genuinely vary, and it keeps the arithmetic somewhere it can be read
 *  next to the Python it mirrors.
 */

import {
  CURVE_SIZE,
  CURVE_ROWS,
  PRESENCE_CLARITY,
  PRESENCE_DEHAZE,
  PRESENCE_TEXTURE,
} from './shader'
import { HSL_CHANNEL_ORDER } from './constants'

/** What the multi-pass stage needs to know about the frame it is drawing.
 *
 *  Presence radii are fractions of the short edge and so rescale themselves;
 *  detail's are absolute pixel counts, which is why `scale` is here at all —
 *  see the docstring on `engine/ops/detail.py apply_detail`.
 */
export interface FrameInfo {
  width: number
  height: number
  /** This frame's size relative to the full-resolution one, as `render_float`
   *  means it. */
  scale: number
}

/** One presence op, already reduced to what the passes need. */
export interface PresencePass {
  /** PRESENCE_* from shader.ts; also the order `apply_presence` runs them. */
  mode: number
  /** slider / 100 */
  amount: number
  /** Box radius of each of the six `fast_blur` passes. */
  radius: number
}

/** A separable gaussian, as `engine/ops/detail.py _blur` parameterizes one. */
export interface GaussPass {
  sigma: number
  radius: number
}

export interface DetailUniforms {
  /** Null when the op is off or its radius has stopped meaning anything. */
  luma: GaussPass | null
  chroma: GaussPass | null
  /** True when either NR slider is up: the split-and-clip runs even if both
   *  blurs were skipped for being degenerate, and clipping is observable. */
  nrOn: boolean
  sharpen: GaussPass | null
  sharpenStrength: number
}

export interface Uniforms {
  wbGain: [number, number, number]
  exposure: number
  regions: [number, number, number, number]
  contrast: [number, number, number, number]
  contrastSign: number
  curveOn: [number, number, number, number]
  curves: Float32Array
  colorOn: number
  satVib: [number, number]
  hsl: Float32Array
  gradingOn: number
  gradeExp: number
  gradeBalance: number
  gradeTint: Float32Array
  gradeLum: [number, number, number]
  vignetteOn: number
  vignette: [number, number, number, number]
  /** Empty unless a `FrameInfo` was supplied — the radii cannot be known
   *  without one, and guessing them would draw the wrong blur. */
  presence: PresencePass[]
  detail: DetailUniforms | null
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** engine/ops/color.py `_hsv_to_rgb`, for one colour. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const h6 = h * 6
  const i = ((Math.floor(h6) % 6) + 6) % 6
  const f = h6 - Math.floor(h6)
  const p = v * (1 - s)
  const q = v * (1 - s * f)
  const t = v * (1 - s * (1 - f))
  return [
    [v, q, p, p, t, v][i],
    [t, v, v, q, p, p][i],
    [p, p, t, v, v, q][i],
  ] as [number, number, number]
}

const IDENTITY_CURVE = (pts: any): boolean =>
  Array.isArray(pts) &&
  pts.length === 2 &&
  pts[0][0] === 0 &&
  pts[0][1] === 0 &&
  pts[1][0] === 255 &&
  pts[1][1] === 255

/** engine/ops/tone.py `_curve_lut`: np.interp over 1024 evenly spaced inputs,
 *  clamped to the endpoints outside the control points' range. */
function curveLut(pts: [number, number][], out: Float32Array, offset: number): void {
  const xs = pts.map((p) => p[0] / 255)
  const ys = pts.map((p) => p[1] / 255)
  let seg = 0
  for (let i = 0; i < CURVE_SIZE; i++) {
    const x = i / (CURVE_SIZE - 1)
    while (seg < xs.length - 2 && x > xs[seg + 1]) seg++
    let y: number
    if (x <= xs[0]) y = ys[0]
    else if (x >= xs[xs.length - 1]) y = ys[ys.length - 1]
    else {
      const span = xs[seg + 1] - xs[seg]
      y = span <= 0 ? ys[seg] : ys[seg] + ((x - xs[seg]) / span) * (ys[seg + 1] - ys[seg])
    }
    out[offset + i] = y
  }
}

/** Fills `out` with the identity ramp — what a curve texture row holds when
 *  the shader is told to skip it, so a stale row can never leak through. */
function identityLut(out: Float32Array, offset: number): void {
  for (let i = 0; i < CURVE_SIZE; i++) out[offset + i] = i / (CURVE_SIZE - 1)
}

/** engine/ops/blur.py `box_radius`.
 *
 *  `fast_blur` is three chained box blurs, not a gaussian, and this integer is
 *  the whole difference between the two at large sigma. Python rounds
 *  half-to-even and this rounds half-up; the two disagree only when the
 *  expression lands on an exact .5, which needs `sigma * sqrt(5) / 2` to be
 *  exactly integral in binary floating point.
 */
function boxRadius(sigma: number): number {
  return Math.max(1, Math.round((sigma * Math.sqrt(12 / 3 + 1)) / 2 - 0.5))
}

/** engine/ops/detail.py `_gaussian_kernel`: `int()` truncates, it does not
 *  round, so a sigma of 0.9 gives radius 2 and not 3. */
const gauss = (sigma: number): GaussPass => ({
  sigma,
  radius: Math.max(1, Math.trunc(sigma * 3)),
})

/** engine/ops/presence.py, in `apply_presence`'s order. Sigmas are fractions
 *  of the short edge, so nothing here is scaled. */
function buildPresence(tone: any, frame: FrameInfo): PresencePass[] {
  const short = Math.min(frame.height, frame.width)
  const ops: [number, number, number][] = [
    [PRESENCE_DEHAZE, num(tone.dehaze, 0), Math.max(4.0, short * 0.02)],
    [PRESENCE_CLARITY, num(tone.clarity, 0), Math.max(2.0, short * 0.015)],
    [PRESENCE_TEXTURE, num(tone.texture, 0), Math.max(1.0, short / 1000)],
  ]
  return ops
    .filter(([, amount]) => amount !== 0)
    .map(([mode, amount, sigma]) => ({ mode, amount: amount / 100, radius: boxRadius(sigma) }))
}

/** engine/ops/detail.py `apply_detail`. */
function buildDetail(detail: any, frame: FrameInfo): DetailUniforms | null {
  const nr = detail?.noiseReduction ?? {}
  const sh = detail?.sharpening ?? {}
  const lum = num(nr.luminance, 0)
  const col = num(nr.color, 0)
  const amount = num(sh.amount, 0)
  const sharpenSigma = num(sh.radius, 1.0) * frame.scale

  // "Radii below ~0.3 px stop meaning anything" — the engine drops the blur
  // and keeps the rest of the op, so the skips have to be per-blur.
  const lumaSigma = (0.5 + (lum / 100) * 2.0) * frame.scale
  const chromaSigma = (0.5 + (col / 100) * 3.0) * frame.scale
  const out: DetailUniforms = {
    luma: lum && lumaSigma >= 0.3 ? gauss(lumaSigma) : null,
    chroma: col && chromaSigma >= 0.3 ? gauss(chromaSigma) : null,
    nrOn: lum !== 0 || col !== 0,
    sharpen: amount && sharpenSigma >= 0.3 ? gauss(sharpenSigma) : null,
    sharpenStrength: (amount / 100) * (0.5 + num(sh.detail, 25) / 100),
  }
  return out.nrOn || out.sharpen ? out : null
}

export function buildUniforms(recipe: any, frame?: FrameInfo): Uniforms {
  const wb = recipe?.whiteBalance ?? {}
  const tone = recipe?.tone ?? {}
  const color = recipe?.color ?? {}
  const grading = color.grading ?? {}
  const vig = recipe?.effects?.vignette ?? {}

  // ---- white balance: log-scale channel gains around the 5500K baseline ----
  let wbR = 1
  let wbB = 1
  if (typeof wb.temp === 'number') {
    const shift = Math.log2(wb.temp / 5500)
    wbR = 2 ** (shift * 0.5)
    wbB = 2 ** (-shift * 0.5)
  }
  const wbG = 2 ** ((-num(wb.tint, 0) / 150) * 0.3)

  // ---- contrast: the sigmoid and its endpoint normalization ----
  const contrast = num(tone.contrast, 0)
  const k = 1 + (Math.abs(contrast) / 100) * 1.5
  const lo = 1 / (1 + Math.exp(k * 2))
  const hi = 1 / (1 + Math.exp(-k * 2))

  // ---- tone curve: one 1024-wide row per curve, luma first ----
  const curveDefs = [tone.toneCurve?.points, tone.toneCurve?.red, tone.toneCurve?.green, tone.toneCurve?.blue]
  const curves = new Float32Array(CURVE_SIZE * CURVE_ROWS)
  const curveOn = [0, 0, 0, 0] as [number, number, number, number]
  curveDefs.forEach((pts, row) => {
    if (Array.isArray(pts) && pts.length >= 2 && !IDENTITY_CURVE(pts)) {
      curveOn[row] = 1
      curveLut(pts, curves, row * CURVE_SIZE)
    } else {
      identityLut(curves, row * CURVE_SIZE)
    }
  })
  const saturation = num(color.saturation, 0)
  const vibrance = num(color.vibrance, 0)

  // ---- HSL bands, in the order the engine composes them ----
  const hsl = new Float32Array(8 * 3)
  let hslTouched = false
  HSL_CHANNEL_ORDER.forEach((name, i) => {
    const ch = color.hsl?.[name] ?? {}
    const v = [num(ch.hue, 0) / 100, num(ch.saturation, 0) / 100, num(ch.luminance, 0) / 100]
    if (v.some((x) => x !== 0)) hslTouched = true
    hsl.set(v, i * 3)
  })

  // ---- colour grading: chroma-only tints, zero net brightness ----
  const blending = num(grading.blending, 50)
  const bands = ['shadows', 'midtones', 'highlights'] as const
  const gradeTint = new Float32Array(9)
  const gradeLum: [number, number, number] = [0, 0, 0]
  let gradingTouched = blending !== 50 || num(grading.balance, 0) !== 0
  bands.forEach((name, i) => {
    const band = grading[name] ?? {}
    const sat = num(band.saturation, 0)
    const lum = num(band.luminance, 0)
    if (sat !== 0 || lum !== 0 || num(band.hue, 0) !== 0) gradingTouched = true
    if (sat !== 0) {
      const tint = hsvToRgb(num(band.hue, 0) / 360, 1, 1)
      const mean = (tint[0] + tint[1] + tint[2]) / 3
      const scale = (sat / 100) * 0.35
      gradeTint.set(tint.map((t) => (t - mean) * scale), i * 3)
    }
    gradeLum[i] = (lum / 100) * 0.4
  })

  const vigAmount = num(vig.amount, 0)

  return {
    wbGain: [wbR, wbG, wbB],
    exposure: num(tone.exposure, 0),
    regions: [
      num(tone.highlights, 0) / 100,
      num(tone.shadows, 0) / 100,
      num(tone.whites, 0) / 100,
      num(tone.blacks, 0) / 100,
    ],
    contrast: [k, lo, hi, Math.abs(contrast) / 100],
    contrastSign: contrast > 0 ? 1 : -1,
    curveOn,
    curves,
    colorOn: saturation !== 0 || vibrance !== 0 || hslTouched ? 1 : 0,
    satVib: [saturation / 100, vibrance / 100],
    hsl,
    gradingOn: gradingTouched ? 1 : 0,
    gradeExp: 1 + ((100 - blending) / 100) * 2 + 1,
    gradeBalance: (num(grading.balance, 0) / 100) * 0.25,
    gradeTint,
    gradeLum,
    vignetteOn: vigAmount !== 0 ? 1 : 0,
    vignette: [
      vigAmount / 100,
      num(vig.midpoint, 50) / 100,
      0.05 + (num(vig.feather, 50) / 100) * 0.9,
      2 * 2 ** (num(vig.roundness, 0) / 100),
    ],
    presence: frame ? buildPresence(tone, frame) : [],
    detail: frame ? buildDetail(recipe?.detail, frame) : null,
  }
}
