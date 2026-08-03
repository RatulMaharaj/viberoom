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
  MASK_COLOR,
  MASK_LINEAR,
  MASK_LUMINANCE,
  MASK_RADIAL,
  MAX_STROKE_POINTS,
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

/** engine/ops/lens.py, minus defringe. Null when every slider is at zero. */
export interface LensUniforms {
  /** distortion / 100 * 0.15 */
  k: number
  /** vignette / 100 * 0.8 */
  vig: number
  /** Per channel: 1 + ca / 100 * 0.001. Green is never shifted. */
  caScale: [number, number, number]
  /** Per channel: 1 when `_plan` would not have short-circuited to a copy. */
  remap: [number, number, number]
}

/** One invocation of `GEOM_SOURCE`. */
export interface GeomPass {
  /** rot90 count folded into this pass's input fetches (0 on all but the
   *  first). */
  orient: number
  /** Logical input extent, after `orient`. */
  inWidth: number
  inHeight: number
  outWidth: number
  outHeight: number
  /** Logical output index of fragment (0, 0), and the step per fragment. */
  originX: number
  originY: number
  signX: number
  signY: number
  /** Row-major projective map, output half-pixel -> input half-pixel. Identity
   *  when `resample` is false. */
  mat: number[]
  resample: boolean
}

export interface GeometryUniforms {
  passes: GeomPass[]
  /** Size of the frame the *rest of the pipeline* sees from here on. */
  width: number
  height: number
}

/** engine/ops/lut.py, reduced to what the edit pass needs. The LUT *data* is
 *  not here — it is a texture, uploaded once by `GpuRenderer.setLut`. */
export interface LutUniforms {
  /** 0 when there is no LUT to apply, else the entries-per-axis. */
  size: number
  kind: 0 | 1 | 3
  strength: number
  /** 0 = "pre", 1 = "post". */
  stage: 0 | 1
}

// ---- stage 4: local adjustments (engine/ops/masks.py) ---------------------

/** One `STROKE_SOURCE` invocation. A stroke longer than `MAX_STROKE_POINTS`
 *  becomes several, sharing their boundary point; only the last composites. */
export interface StrokeChunk {
  /** Pixel coordinates, packed two points per vec4 for the uniform array. */
  pts: Float32Array
  count: number
  init: boolean
  final: boolean
}

/** `_stroke_patch` for one stroke, already reduced to what the shader needs. */
export interface StrokePass {
  chunks: StrokeChunk[]
  /** hard radius, outer radius, flow/100, erase. */
  shape: [number, number, number, number]
}

export interface MaskWeightUniforms {
  /** MASK_* from shader.ts, or null for a brush mask. */
  mode: number | null
  /** Mode-specific; see the uniform block in `MASK_WEIGHT_SOURCE`. */
  a: [number, number, number, number]
  b: [number, number, number, number]
  strokes: StrokePass[]
}

/** `masks.py` `_adjust`, as the passes that reproduce it. */
export interface LocalAdjustUniforms {
  /** True when the gamma-linearized block or the contrast runs at all. */
  toneOn: boolean
  gammaOn: number
  expGain: number
  wbGain: [number, number, number]
  regionsOn: number
  regions: [number, number]
  contrastOn: number
  contrast: [number, number, number, number]
  contrastSign: number
  /** Both use the *frame's* short edge for their radius, which is the whole
   *  reason `_adjust_margin` refuses to crop for them. */
  dehaze: PresencePass | null
  clarity: PresencePass | null
  /** 1 + saturation/100, or null when the slider is at zero. */
  satGain: number | null
  /** `fast_blur` radius and the unsharp strength, or null. */
  sharpen: { radius: number; strength: number } | null
}

export interface MaskUniforms {
  weight: MaskWeightUniforms
  adjust: LocalAdjustUniforms
  invert: number
  opacity: number
}

export interface Uniforms {
  lens: LensUniforms | null
  geometry: GeometryUniforms | null
  lut: LutUniforms
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
  /** In recipe order. Empty unless a `FrameInfo` was supplied: mask radii and
   *  stroke geometry are all sized from the *post-geometry* frame. */
  masks: MaskUniforms[]
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

/** engine/ops/lens.py `apply_lens`. Null when the op is the identity. */
function buildLens(lens: any): LensUniforms | null {
  const distortion = num(lens?.distortion, 0)
  const vignette = num(lens?.vignette, 0)
  const caRed = num(lens?.caRed, 0)
  const caBlue = num(lens?.caBlue, 0)
  if (!distortion && !vignette && !caRed && !caBlue) return null
  const k = (distortion / 100) * 0.15
  // `_plan`'s `np.isscalar(scale) and scale == 1.0` copy: with distortion on,
  // `base` is a whole plane and the Python cannot take that branch on any
  // channel, so neither may this.
  const remap = (ca: number): number => (k !== 0 || ca !== 0 ? 1 : 0)
  return {
    k,
    vig: (vignette / 100) * 0.8,
    caScale: [1 + (caRed / 100) * 0.001, 1, 1 + (caBlue / 100) * 0.001],
    remap: [remap(caRed), remap(0), remap(caBlue)],
  }
}

const IDENTITY_MAT = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** Gaussian elimination with partial pivoting: `np.linalg.solve` for the 8x8
 *  system `_find_coeffs` builds. JS numbers are float64, so this agrees with
 *  numpy to rounding. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r
    }
    ;[m[col], m[piv]] = [m[piv], m[col]]
    const d = m[col][col]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = m[r][col] / d
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c]
    }
  }
  // Gauss-Jordan leaves `m` diagonal, so each unknown is one division.
  return m.map((row, i) => row[n] / row[i])
}

/** engine/ops/geometry.py `_apply_perspective`, as a row-major 3x3. */
function perspectiveMat(w: number, h: number, p: any): number[] {
  const v = (num(p.vertical, 0) / 100) * 0.35
  const hz = (num(p.horizontal, 0) / 100) * 0.35
  const s = 100 / num(p.scale, 100)
  const src: [number, number][] = [
    [(0 - Math.max(v, 0)) * w, (0 - Math.max(hz, 0)) * h],
    [(1 + Math.max(v, 0)) * w, (0 + Math.min(hz, 0)) * h],
    [(1 - Math.min(v, 0)) * w, (1 - Math.min(hz, 0)) * h],
    [(0 + Math.min(v, 0)) * w, (1 + Math.max(hz, 0)) * h],
  ]
  const cx = w / 2
  const cy = h / 2
  const q = src.map(([x, y]): [number, number] => [(x - cx) * s + cx, (y - cy) * s + cy])
  const dst: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h]]
  const rows: number[][] = []
  const rhs: number[] = []
  dst.forEach(([x, y], i) => {
    const [u, vv] = q[i]
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    rhs.push(u)
    rows.push([0, 0, 0, x, y, 1, -vv * x, -vv * y])
    rhs.push(vv)
  })
  const c = solve(rows, rhs)
  return [c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], 1]
}

/** `Image.rotate(-angle, expand=False)`, transcribed including its
 *  `round(..., 15)` on the trig — PIL really does quantize there, and at 15
 *  digits it is the difference between an exact 0 and a 6e-17 shear. */
function rotateMat(w: number, h: number, angleDeg: number): number[] {
  const r15 = (x: number): number => Number(x.toFixed(15))
  const a = -(-angleDeg * Math.PI) / 180
  const ca = r15(Math.cos(a))
  const sa = r15(Math.sin(a))
  const cx = w / 2
  const cy = h / 2
  return [ca, sa, ca * -cx + sa * -cy + cx, -sa, ca, -sa * -cx + ca * -cy + cy, 0, 0, 1]
}

/** engine/ops/geometry.py `apply_geometry`, planned as passes. */
function buildGeometry(geo: any, frame: FrameInfo): GeometryUniforms | null {
  const orientation = num(geo?.orientation, 0)
  const rotate = num(geo?.rotate, 0)
  const flipH = geo?.flipH === true
  const flipV = geo?.flipV === true
  const p = geo?.perspective ?? {}
  const c = geo?.crop ?? {}
  const left = num(c.left, 0)
  const top = num(c.top, 0)
  const right = num(c.right, 1)
  const bottom = num(c.bottom, 1)

  const doP = num(p.vertical, 0) !== 0 || num(p.horizontal, 0) !== 0 || num(p.scale, 100) !== 100
  const doR = rotate !== 0
  const cropped = left !== 0 || top !== 0 || right !== 1 || bottom !== 1
  if (!orientation && !doP && !doR && !flipH && !flipV && !cropped) return null

  // `(-orientation // 90) % 4` — Python floor division, so JS needs the floor.
  const k = ((Math.floor(-orientation / 90) % 4) + 4) % 4
  const w1 = k % 2 ? frame.height : frame.width
  const h1 = k % 2 ? frame.width : frame.height

  const y0 = cropped ? Math.trunc(top * h1) : 0
  const y1 = cropped ? Math.max(Math.trunc(top * h1) + 1, Math.trunc(bottom * h1)) : h1
  const x0 = cropped ? Math.trunc(left * w1) : 0
  const x1 = cropped ? Math.max(Math.trunc(left * w1) + 1, Math.trunc(right * w1)) : w1
  const outWidth = x1 - x0
  const outHeight = y1 - y0

  const mats: number[][] = []
  if (doP) mats.push(perspectiveMat(w1, h1, p))
  if (doR) mats.push(rotateMat(w1, h1, rotate))

  // Flip and crop as one output-index map, carried by the final pass alone:
  // fragment x is logical column `x0 + x`, or `w1 - 1 - (x0 + x)` when flipped.
  const tail = {
    originX: flipH ? w1 - 1 - x0 : x0,
    originY: flipV ? h1 - 1 - y0 : y0,
    signX: flipH ? -1 : 1,
    signY: flipV ? -1 : 1,
    outWidth,
    outHeight,
  }

  const passes: GeomPass[] = []
  if (mats.length === 0) {
    passes.push({ orient: k, inWidth: w1, inHeight: h1, mat: IDENTITY_MAT, resample: false, ...tail })
  } else {
    mats.forEach((mat, i) => {
      const last = i === mats.length - 1
      passes.push({
        orient: i === 0 ? k : 0,
        inWidth: w1,
        inHeight: h1,
        mat,
        resample: true,
        ...(last
          ? tail
          : { originX: 0, originY: 0, signX: 1, signY: 1, outWidth: w1, outHeight: h1 }),
      })
    })
  }
  return { passes, width: outWidth, height: outHeight }
}

/** engine/ops/lut.py `apply_lut`. `available` is the entries-per-axis and kind
 *  of the LUT the renderer currently holds; a recipe naming a LUT that is not
 *  loaded applies nothing, exactly as `load_lut` returning None does. */
function buildLut(lut: any, available: { kind: '1D' | '3D'; size: number } | null): LutUniforms {
  const off: LutUniforms = { size: 0, kind: 0, strength: 0, stage: 0 }
  const strength = num(lut?.strength, 100)
  if (!lut?.name || strength === 0 || !available) return off
  return {
    size: available.size,
    kind: available.kind === '3D' ? 3 : 1,
    strength: strength / 100,
    stage: lut?.stage === 'pre' ? 0 : 1,
  }
}

/** The ten sliders `LocalAdjustments` holds, in schema order. */
const LOCAL_SLIDERS = [
  'exposure', 'contrast', 'highlights', 'shadows', 'temp', 'tint',
  'saturation', 'clarity', 'dehaze', 'sharpness',
] as const

/** `masks.py` `_stroke_patch`, minus the bounding box the GPU does not need.
 *
 *  Points are converted to pixels here, in float64, exactly as the Python's
 *  `[(x * w, y * h) for x, y in stroke.points]` does before the float32 grid
 *  math starts.
 */
function buildStroke(stroke: any, w: number, h: number): StrokePass | null {
  const pts = Array.isArray(stroke?.points) ? stroke.points : []
  if (pts.length === 0) return null
  const rPx = num(stroke.radius, 0.05) * Math.min(h, w)
  const hard = rPx * (1 - num(stroke.feather, 50) / 100)
  const px: number[] = []
  for (const p of pts) {
    px.push(num(p?.[0], 0) * w, num(p?.[1], 0) * h)
  }

  const chunks: StrokeChunk[] = []
  const n = pts.length
  if (n === 1) {
    chunks.push({ pts: pack(px, 0, 1), count: 1, init: true, final: true })
  } else {
    // Chunks share their boundary point so no segment is dropped between them.
    for (let start = 0; start < n - 1; start += MAX_STROKE_POINTS - 1) {
      const count = Math.min(MAX_STROKE_POINTS, n - start)
      chunks.push({
        pts: pack(px, start, count),
        count,
        init: start === 0,
        final: start + count >= n,
      })
    }
  }
  return {
    chunks,
    shape: [hard, Math.max(rPx, hard + 0.5), num(stroke.flow, 100) / 100, stroke.erase === true ? 1 : 0],
  }
}

/** `count` points from `px` (a flat x,y list) as vec4s, two points each. */
function pack(px: number[], start: number, count: number): Float32Array {
  const out = new Float32Array(MAX_STROKE_POINTS * 2)
  out.set(px.slice(start * 2, (start + count) * 2))
  return out
}

/** `mask_weight`, split into the closed-form uniforms and the stroke list. */
function buildMaskWeight(mask: any, w: number, h: number): MaskWeightUniforms | null {
  const zero: [number, number, number, number] = [0, 0, 0, 0]
  const out = (mode: number, a: number[], b: number[] = []): MaskWeightUniforms => ({
    mode,
    a: [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0],
    b: [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0],
    strokes: [],
  })
  switch (mask?.type) {
    case 'linear':
      return out(MASK_LINEAR, [
        num(mask.start?.[0], 0), num(mask.start?.[1], 0),
        num(mask.end?.[0], 0), num(mask.end?.[1], 0),
      ])
    case 'radial': {
      const rx = num(mask.radiusX, 0)
      const ry = num(mask.radiusY, 0)
      if (rx <= 0 || ry <= 0) return null
      return out(
        MASK_RADIAL,
        [num(mask.center?.[0], 0), num(mask.center?.[1], 0), rx, ry],
        [1 - num(mask.feather, 50) / 100],
      )
    }
    case 'luminance': {
      const lumMin = num(mask.lumMin, 0)
      const lumMax = num(mask.lumMax, 100)
      return out(
        MASK_LUMINANCE,
        [lumMin, lumMax, Math.max((num(mask.feather, 25) / 100) * 20, 0.5), 0],
        [lumMin <= 0 ? 1 : 0, lumMax >= 100 ? 1 : 0],
      )
    }
    case 'color': {
      const range = num(mask.range, 30)
      if (range === 0) return null
      return out(MASK_COLOR, [num(mask.hue, 0), range])
    }
    case 'brush': {
      const strokes = (Array.isArray(mask.strokes) ? mask.strokes : [])
        .map((s: any) => buildStroke(s, w, h))
        .filter((s: StrokePass | null): s is StrokePass => s !== null)
      if (strokes.length === 0) return null
      return { mode: null, a: zero, b: zero, strokes }
    }
    default:
      // 'subject' / 'background' / 'sky' land here. support.ts refuses them
      // outright; this is the second line of defence, not the first.
      return null
  }
}

/** `masks.py` `_adjust`, sized from the frame masks actually run on. */
function buildLocalAdjust(adj: any, w: number, h: number): LocalAdjustUniforms | null {
  const v = (k: string): number => num(adj?.[k], 0)
  if (!LOCAL_SLIDERS.some((k) => v(k) !== 0)) return null
  const short = Math.min(h, w)

  const exposure = v('exposure')
  const temp = v('temp')
  const tint = v('tint')
  const highlights = v('highlights')
  const shadows = v('shadows')
  const gammaOn = exposure || temp || tint || highlights || shadows ? 1 : 0
  const rg = 2 ** ((temp / 100) * 0.35)
  const gg = 2 ** ((-tint / 100) * 0.25)

  const contrast = v('contrast')
  const k = 1 + (Math.abs(contrast) / 100) * 1.5
  const sharpness = v('sharpness')
  const saturation = v('saturation')
  const dehaze = v('dehaze')
  const clarity = v('clarity')

  return {
    toneOn: gammaOn === 1 || contrast !== 0,
    gammaOn,
    // The Python multiplies by 2**exposure and by the gains as two separate
    // steps; both are exactly 1.0 when their slider is at zero, so folding
    // them would change nothing — but the order they compose in would.
    expGain: 2 ** exposure,
    wbGain: temp || tint ? [rg, gg, 1 / rg] : [1, 1, 1],
    regionsOn: highlights || shadows ? 1 : 0,
    regions: [highlights / 100, shadows / 100],
    contrastOn: contrast !== 0 ? 1 : 0,
    contrast: [k, 1 / (1 + Math.exp(k * 2)), 1 / (1 + Math.exp(-k * 2)), Math.abs(contrast) / 100],
    contrastSign: contrast > 0 ? 1 : -1,
    dehaze: dehaze
      ? { mode: PRESENCE_DEHAZE, amount: dehaze / 100, radius: boxRadius(Math.max(4.0, short * 0.02)) }
      : null,
    clarity: clarity
      ? { mode: PRESENCE_CLARITY, amount: clarity / 100, radius: boxRadius(Math.max(2.0, short * 0.015)) }
      : null,
    satGain: saturation ? 1 + saturation / 100 : null,
    sharpen: sharpness
      // SHARPEN_SOURCE doubles its strength (`apply_detail`'s convention), so
      // the *1.5 the Python asks for is passed as 0.75.
      ? { radius: boxRadius(Math.max(1.0, short / 1500)), strength: (sharpness / 100) * 0.75 }
      : null,
  }
}

/** `apply_masks`, in recipe order.
 *
 *  `w`/`h` are the *post-geometry* frame, because that is what `render_float`
 *  hands `apply_masks` and every radius and stroke radius here is measured
 *  from it.
 *
 *  One thing the Python does that this cannot: `apply_masks` skips a mask
 *  whose weight never exceeds 1e-4, which needs a reduction over the frame.
 *  The shader blends it instead, and the two differ by at most 1e-4 of the
 *  adjustment — a fortieth of an 8-bit step, and always in the direction the
 *  mask was already pointing.
 */
function buildMasks(masks: any, w: number, h: number): MaskUniforms[] {
  if (!Array.isArray(masks)) return []
  const out: MaskUniforms[] = []
  for (const mask of masks) {
    const opacity = num(mask?.opacity, 100)
    if (opacity === 0) continue
    const adjust = buildLocalAdjust(mask?.adjustments, w, h)
    if (!adjust) continue
    const weight = buildMaskWeight(mask, w, h)
    if (!weight) continue
    out.push({ weight, adjust, invert: mask?.invert === true ? 1 : 0, opacity: opacity / 100 })
  }
  return out
}

export function buildUniforms(
  recipe: any,
  frame?: FrameInfo,
  lut: { kind: '1D' | '3D'; size: number } | null = null,
): Uniforms {
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

  // Geometry decides the size of everything after it, so like the presence
  // and detail radii it cannot be planned without knowing the frame.
  const geometry = frame ? buildGeometry(recipe?.geometry, frame) : null
  // Masks run after geometry, so they measure themselves against *its* output.
  const maskW = geometry?.width ?? frame?.width ?? 0
  const maskH = geometry?.height ?? frame?.height ?? 0

  return {
    lens: buildLens(recipe?.lens),
    geometry,
    lut: buildLut(color.lut, lut),
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
    masks: frame ? buildMasks(recipe?.masks, maskW, maskH) : [],
  }
}
