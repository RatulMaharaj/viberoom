/** WebGL2 renderer for the pointwise chain and the blur-based stages above it.
 *
 *  Framework-free by design — DOM and WebGL only, no React anywhere in this
 *  directory. That is what makes it drivable from a plain page (or a headless
 *  harness) without standing up a component tree.
 */

import {
  BOX_SOURCE,
  CURVE_ROWS,
  CURVE_SIZE,
  EDIT_SOURCE,
  GAUSS_SOURCE,
  GEOM_SOURCE,
  LENS_SOURCE,
  NR_SOURCE,
  PLANE_CHROMA,
  PLANE_DARK,
  PLANE_LUMA,
  PLANE_MEAN,
  PLANE_SOURCE,
  PRESENCE_DEHAZE,
  PRESENCE_SOURCE,
  PRESENT_SOURCE,
  SHARPEN_SOURCE,
  VERTEX_SOURCE,
  VIGNETTE_SOURCE,
} from './shader'
import { buildUniforms } from './uniforms'
import type { GaussPass, GeomPass, LensUniforms, PresencePass } from './uniforms'
import type { LutData } from './lut'
import type { SourceFrame } from './source'

export class GpuUnavailable extends Error {}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new GpuUnavailable('could not create shader')
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new GpuUnavailable(`shader compile failed: ${log}`)
  }
  return sh
}

function link(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment)
  const prog = gl.createProgram()
  if (!prog) throw new GpuUnavailable('could not create program')
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog)
    gl.deleteProgram(prog)
    throw new GpuUnavailable(`program link failed: ${log}`)
  }
  return prog
}

/** Uniform locations, looked up once — getUniformLocation is a string lookup
 *  in the driver and this runs per animation frame. */
type Locations = Record<string, WebGLUniformLocation | null>

function locations(gl: WebGL2RenderingContext, prog: WebGLProgram, names: string[]): Locations {
  const out: Locations = {}
  for (const n of names) out[n] = gl.getUniformLocation(prog, n)
  return out
}

const EDIT_UNIFORMS = [
  'uSource', 'uCurves', 'uWbGain', 'uExposure', 'uRegions',
  'uContrast', 'uContrastSign', 'uCurveOn', 'uColorOn', 'uSatVib', 'uHsl',
  'uGradingOn', 'uGradeExp', 'uGradeBalance', 'uGradeTint', 'uGradeLum',
  'uLut3', 'uLut1', 'uLutKind', 'uLutSize', 'uLutStrength', 'uLutStage',
]

/** The programs above the edit pass, and the uniforms each one needs. */
const PASS_UNIFORMS: Record<string, string[]> = {
  lens: ['uSrc', 'uSize', 'uCenter', 'uNorm', 'uK', 'uVig', 'uCaScale', 'uRemap'],
  geom: ['uSrc', 'uSrcSize', 'uInSize', 'uOrient', 'uOrigin', 'uSign', 'uMap', 'uResample'],
  plane: ['uFrame', 'uPlaneMode'],
  box: ['uSrc', 'uSize', 'uStep', 'uRadius'],
  gauss: ['uSrc', 'uSize', 'uStep', 'uRadius', 'uSigma'],
  presence: ['uFrame', 'uPlane', 'uMode', 'uAmount'],
  nr: ['uLuma', 'uChroma'],
  sharpen: ['uFrame', 'uBlur', 'uStrength'],
  vignette: ['uFrame', 'uResolution', 'uVignette'],
  present: ['uFrame'],
}

const PASS_SOURCES: Record<string, string> = {
  lens: LENS_SOURCE,
  geom: GEOM_SOURCE,
  plane: PLANE_SOURCE,
  box: BOX_SOURCE,
  gauss: GAUSS_SOURCE,
  presence: PRESENCE_SOURCE,
  nr: NR_SOURCE,
  sharpen: SHARPEN_SOURCE,
  vignette: VIGNETTE_SOURCE,
  present: PRESENT_SOURCE,
}

/** A float render target: the texture, the framebuffer that writes it, and the
 *  size both were allocated at.
 *
 *  The size is on the target rather than on the renderer because geometry
 *  changes it: a crop or a 90-degree orientation makes every pass downstream
 *  of it a different shape from every pass upstream, so "the current size" is
 *  no longer a property of the frame being drawn. */
interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  width: number
  height: number
}

export class GpuRenderer {
  private gl: WebGL2RenderingContext
  private edit: WebGLProgram
  private editLoc: Locations
  private progs: Record<string, WebGLProgram> = {}
  private locs: Record<string, Locations> = {}
  private curveTex: WebGLTexture
  private sourceTex: WebGLTexture | null = null
  /** Two full frames to ping-pong between, plus three scratch planes. The
   *  scratch is allocated on first use: a recipe with no blur in it never pays
   *  for three extra float frames. */
  private frames: Target[] = []
  private aux: Target[] = []
  /** Ping-pong pair at the *geometry output* size, allocated only when a
   *  recipe actually changes the frame's shape. */
  private geoFrames: Target[] = []
  private lut: { tex3: WebGLTexture | null; tex1: WebGLTexture | null; kind: '1D' | '3D'; size: number } | null = null
  private width = 0
  private height = 0
  /** Size of the last frame drawn, after geometry. */
  private outWidth = 0
  private outHeight = 0
  /** This frame's size relative to full resolution, for `apply_detail`. */
  private scale = 1
  private contextLost = false
  private canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // The canvas is read back for the capability smoke test and is otherwise
      // only ever composited, so the browser may drop the buffer after a swap.
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new GpuUnavailable('no webgl2 context')
    // Float render targets are not optional: the edit pass writes RGBA16F so
    // later stages have somewhere with headroom to read back from.
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new GpuUnavailable('EXT_color_buffer_float unavailable')
    }
    this.gl = gl

    canvas.addEventListener('webglcontextlost', this.onLost)
    this.edit = link(gl, EDIT_SOURCE)
    this.editLoc = locations(gl, this.edit, EDIT_UNIFORMS)
    for (const [name, src] of Object.entries(PASS_SOURCES)) {
      this.progs[name] = link(gl, src)
      this.locs[name] = locations(gl, this.progs[name], PASS_UNIFORMS[name])
    }

    const curveTex = gl.createTexture()
    if (!curveTex) throw new GpuUnavailable('could not create curve texture')
    this.curveTex = curveTex
    gl.bindTexture(gl.TEXTURE_2D, curveTex)
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
      gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST)
    }
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) {
      gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE)
    }
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, CURVE_SIZE, CURVE_ROWS)
  }

  private onLost = (e: Event) => {
    // Backgrounding a tab really does take the context away; say so loudly so
    // the caller can fall back rather than presenting a frozen frame.
    e.preventDefault()
    this.contextLost = true
  }

  get lost(): boolean {
    return this.contextLost || this.gl.isContextLost()
  }

  /** The size of the frame last drawn. Geometry can make this differ from the
   *  source frame's size, and it is the canvas's size, so it is what a caller
   *  laying the canvas out has to go by. */
  get size(): { width: number; height: number } {
    return { width: this.outWidth || this.width, height: this.outHeight || this.height }
  }

  /** Size of the uploaded source frame, before any geometry. */
  get sourceSize(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  /**
   * Hand the renderer the LUT a recipe is about to name, or `null` to drop it.
   *
   * The engine loads LUTs from `~/.viberoom/luts` by name; a browser has no
   * such directory, so the renderer takes the *data* and stays out of the
   * question of where it came from. Parse a `.cube` with `parseCube` from
   * ./lut — from a file the user dropped, from IndexedDB, from a bundled
   * asset — and pass the result here.
   *
   * Which LUT is loaded is also an input to `gpuSupportsRecipe`: a recipe
   * naming a LUT this renderer does not hold must fall back to the server,
   * because the engine would have applied one and the shader would not.
   */
  setLut(data: LutData | null): void {
    const gl = this.gl
    if (this.lut) {
      if (this.lut.tex3) gl.deleteTexture(this.lut.tex3)
      if (this.lut.tex1) gl.deleteTexture(this.lut.tex1)
      this.lut = null
    }
    if (!data) return

    const tex = gl.createTexture()
    if (!tex) throw new GpuUnavailable('could not create LUT texture')
    // NEAREST throughout: the shader does its own (tri)linear blend, both to
    // match `_apply_3d` exactly and because a LINEAR-filterable float texture
    // is an extension this renderer does not otherwise need.
    const target = data.kind === '3D' ? gl.TEXTURE_3D : gl.TEXTURE_2D
    gl.bindTexture(target, tex)
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
      gl.texParameteri(target, p, gl.NEAREST)
    }
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
      gl.texParameteri(target, p, gl.CLAMP_TO_EDGE)
    }
    // RGB32F is not colour-renderable but is perfectly legal to sample, and
    // texelFetch needs no filtering support at all.
    if (data.kind === '3D') {
      const n = data.size
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, n, n, n, 0, gl.RGB, gl.FLOAT, data.data)
      this.lut = { tex3: tex, tex1: null, kind: '3D', size: n }
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGB32F, data.size, 1, 0, gl.RGB, gl.FLOAT, data.data,
      )
      this.lut = { tex3: null, tex1: tex, kind: '1D', size: data.size }
    }
  }

  /** What `buildUniforms` needs to know about the loaded LUT. */
  get lutInfo(): { kind: '1D' | '3D'; size: number } | null {
    return this.lut ? { kind: this.lut.kind, size: this.lut.size } : null
  }

  /** Allocates one RGBA16F target, at the source size unless told otherwise. */
  private makeTarget(width = this.width, height = this.height): Target {
    const gl = this.gl
    const tex = gl.createTexture()
    if (!tex) throw new GpuUnavailable('could not create render target')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
      gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST)
    }
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) {
      gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE)
    }
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height)
    const fbo = gl.createFramebuffer()
    if (!fbo) throw new GpuUnavailable('could not create framebuffer')
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new GpuUnavailable(`float framebuffer incomplete (0x${status.toString(16)})`)
    }
    return { tex, fbo, width, height }
  }

  /** Scratch planes, allocated the first time a blur asks for them. Presence
   *  needs two and noise reduction three, so a recipe that only ever uses the
   *  former never pays for the third. */
  private scratch(n: number): Target[] {
    while (this.aux.length < n) this.aux.push(this.makeTarget())
    return this.aux
  }

  /** The geometry stage's ping-pong pair, at whatever size that stage needs.
   *
   *  Two intermediate sizes can be in play at once — a perspective warp runs at
   *  the oriented size and the straighten after it lands at the cropped one —
   *  so these are sized to the largest of the two and the viewport picks out
   *  the part each pass actually writes. Reallocating between passes would
   *  churn a full float frame on every pointer move. */
  private geoScratch(width: number, height: number): Target[] {
    const [a] = this.geoFrames
    if (!a || a.width < width || a.height < height) {
      this.release(this.geoFrames)
      const w = Math.max(width, a?.width ?? 0)
      const h = Math.max(height, a?.height ?? 0)
      this.geoFrames = [this.makeTarget(w, h), this.makeTarget(w, h)]
    }
    return this.geoFrames
  }

  private release(targets: Target[]): void {
    for (const t of targets) {
      this.gl.deleteTexture(t.tex)
      this.gl.deleteFramebuffer(t.fbo)
    }
    targets.length = 0
  }

  /** Binds a program and the target it draws into. `null` means the canvas.
   *
   *  The viewport comes from the target, and `size` narrows it further for the
   *  geometry passes, which draw into a buffer deliberately larger than the
   *  region they fill. */
  private begin(name: string, target: Target | null, size?: [number, number]): Locations {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null)
    const [w, h] = size ?? [target?.width ?? this.width, target?.height ?? this.height]
    gl.viewport(0, 0, w, h)
    gl.useProgram(this.progs[name])
    return this.locs[name]
  }

  private bind(unit: number, tex: WebGLTexture | null, loc: WebGLUniformLocation | null): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(loc, unit)
  }

  private draw(): void {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3)
  }

  /**
   * Uploads a decoded frame and resizes the render targets to match it.
   *
   * `scale` is what `render_float` calls scale — this frame's size relative to
   * the full-resolution one. It only matters to the detail ops, whose radii are
   * absolute pixel counts; leaving it at 1 is why `support.ts` refuses recipes
   * that use them.
   */
  setSource(frame: SourceFrame, scale = 1): void {
    const gl = this.gl
    this.scale = scale
    const { width: w, height: h } = frame

    if (this.sourceTex) gl.deleteTexture(this.sourceTex)
    const tex = gl.createTexture()
    if (!tex) throw new GpuUnavailable('could not create source texture')
    this.sourceTex = tex
    gl.bindTexture(gl.TEXTURE_2D, tex)
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
      gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST)
    }
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) {
      gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE)
    }
    if (frame.format === 'rgb9e5') {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGB9_E5, w, h, 0, gl.RGB,
        gl.UNSIGNED_INT_5_9_9_9_REV, new Uint32Array(frame.data),
      )
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA,
        gl.HALF_FLOAT, new Uint16Array(frame.data),
      )
    }

    if (w !== this.width || h !== this.height) {
      this.width = w
      this.height = h
      this.canvas.width = w
      this.canvas.height = h
      this.release(this.frames)
      this.release(this.aux)
      this.release(this.geoFrames)
      this.frames = [this.makeTarget(), this.makeTarget()]
    }
  }

  /** Extracts a plane from `src` into `dst`. */
  private planePass(mode: number, src: Target, dst: Target): void {
    const l = this.begin('plane', dst)
    this.bind(0, src.tex, l.uFrame)
    this.gl.uniform1i(l.uPlaneMode, mode)
    this.draw()
  }

  /**
   * `fast_blur` in place over two scratch targets: three box passes per axis,
   * alternating y, x, y, x, y, x as the Python's `i % 2` does.
   *
   * Returns whichever of `a`/`b` the result landed in. A pass that the Python
   * would have short-circuited — a degenerate axis, or a radius the axis is too
   * short to hold — is skipped rather than run with a clamped radius, so the
   * two agree on which buffer the answer is in as well as what it contains.
   */
  private fastBlur(radius: number, a: Target, b: Target): Target {
    let src = a
    let dst = b
    for (let i = 0; i < 6; i++) {
      const alongY = i % 2 === 0
      const n = alongY ? this.height : this.width
      const r = Math.min(radius, n - 1)
      if (r <= 0 || n <= 1) continue
      const l = this.begin('box', dst)
      this.bind(0, src.tex, l.uSrc)
      this.gl.uniform2i(l.uSize, this.width, this.height)
      this.gl.uniform2i(l.uStep, alongY ? 0 : 1, alongY ? 1 : 0)
      this.gl.uniform1i(l.uRadius, r)
      this.draw()
      ;[src, dst] = [dst, src]
    }
    return src
  }

  /** `detail._blur`: a separable gaussian, y then x, `src` -> `a` -> `b`.
   *
   *  `b` may be `src`, which is how the callers below keep two independent
   *  blurs alive in three scratch targets instead of four. */
  private gaussBlur(g: GaussPass, src: Target, a: Target, b: Target): Target {
    let from = src
    for (const [pass, to] of [a, b].entries()) {
      const alongY = pass === 0
      const l = this.begin('gauss', to)
      this.bind(0, from.tex, l.uSrc)
      this.gl.uniform2i(l.uSize, this.width, this.height)
      this.gl.uniform2i(l.uStep, alongY ? 0 : 1, alongY ? 1 : 0)
      this.gl.uniform1i(l.uRadius, g.radius)
      this.gl.uniform1f(l.uSigma, g.sigma)
      this.draw()
      from = to
    }
    return from
  }

  /** One presence op: build its plane, blur it, fold it back in. */
  private presencePass(p: PresencePass, from: Target, to: Target): void {
    const [s0, s1] = this.scratch(2)
    this.planePass(p.mode === PRESENCE_DEHAZE ? PLANE_DARK : PLANE_LUMA, from, s0)
    const blurred = this.fastBlur(p.radius, s0, s1)
    const l = this.begin('presence', to)
    this.bind(0, from.tex, l.uFrame)
    this.bind(1, blurred.tex, l.uPlane)
    this.gl.uniform1i(l.uMode, p.mode)
    this.gl.uniform1f(l.uAmount, p.amount)
    this.draw()
  }

  /** engine/ops/lens.py, drawn from the uploaded source into `dst`.
   *
   *  It reads `sourceTex` rather than a frame target because it is the first
   *  op in `render_float` — the edit pass then reads this instead of the
   *  source, which is the only structural change lens makes to the chain. */
  private lensPass(l: LensUniforms, dst: Target): void {
    const gl = this.gl
    const loc = this.begin('lens', dst)
    this.bind(0, this.sourceTex, loc.uSrc)
    gl.uniform2i(loc.uSize, this.width, this.height)
    gl.uniform2f(loc.uCenter, (this.width - 1) / 2, (this.height - 1) / 2)
    const cx = (this.width - 1) / 2
    const cy = (this.height - 1) / 2
    gl.uniform1f(loc.uNorm, Math.sqrt(cx * cx + cy * cy))
    gl.uniform1f(loc.uK, l.k)
    gl.uniform1f(loc.uVig, l.vig)
    gl.uniform3fv(loc.uCaScale, l.caScale)
    gl.uniform3fv(loc.uRemap, l.remap)
    this.draw()
  }

  /** One invocation of the geometry program. */
  private geomPass(p: GeomPass, src: Target, srcW: number, srcH: number, dst: Target): void {
    const gl = this.gl
    const loc = this.begin('geom', dst, [p.outWidth, p.outHeight])
    this.bind(0, src.tex, loc.uSrc)
    gl.uniform2i(loc.uSrcSize, srcW, srcH)
    gl.uniform2i(loc.uInSize, p.inWidth, p.inHeight)
    gl.uniform1i(loc.uOrient, p.orient)
    gl.uniform2i(loc.uOrigin, p.originX, p.originY)
    gl.uniform2i(loc.uSign, p.signX, p.signY)
    // `mat` is row-major; GLSL wants columns, and transposing here beats
    // relying on the transpose flag, which WebGL1 forbade and habits linger.
    const m = p.mat
    gl.uniformMatrix3fv(loc.uMap, false, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]])
    gl.uniform1i(loc.uResample, p.resample ? 1 : 0)
    this.draw()
  }

  /** Draws one frame for `recipe`. Cheap enough to call from a rAF loop. */
  render(recipe: any): void {
    const gl = this.gl
    if (!this.sourceTex || this.lost || this.frames.length < 2) return
    const u = buildUniforms(
      recipe,
      { width: this.width, height: this.height, scale: this.scale },
      this.lutInfo,
    )

    gl.bindTexture(gl.TEXTURE_2D, this.curveTex)
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, CURVE_SIZE, CURVE_ROWS, gl.RED, gl.FLOAT, u.curves,
    )

    // `cur` is the frame the chain has reached; every pass reads it and writes
    // the other one, so no pass ever samples the target it is drawing into.
    let cur = 0
    const next = () => this.frames[1 - cur]
    const done = () => {
      cur = 1 - cur
    }

    // Lens is first, in linear light, before white balance. When it runs, the
    // edit pass reads its output instead of the uploaded source.
    let editSrc = this.sourceTex
    if (u.lens) {
      this.lensPass(u.lens, this.frames[cur])
      editSrc = this.frames[cur].tex
      done()
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frames[cur].fbo)
    gl.viewport(0, 0, this.width, this.height)
    gl.useProgram(this.edit)
    const l = this.editLoc
    this.bind(0, editSrc, l.uSource)
    this.bind(1, this.curveTex, l.uCurves)
    // Unit 2 and 3 stay bound whether or not there is a LUT: sampling a
    // never-declared unit is undefined behaviour on some drivers even inside a
    // branch that is not taken.
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_3D, this.lut?.tex3 ?? null)
    gl.uniform1i(l.uLut3, 2)
    this.bind(3, this.lut?.tex1 ?? null, l.uLut1)
    gl.uniform1i(l.uLutKind, u.lut.kind)
    gl.uniform1i(l.uLutSize, u.lut.size)
    gl.uniform1f(l.uLutStrength, u.lut.strength)
    gl.uniform1i(l.uLutStage, u.lut.stage)
    gl.uniform3fv(l.uWbGain, u.wbGain)
    gl.uniform1f(l.uExposure, u.exposure)
    gl.uniform4fv(l.uRegions, u.regions)
    gl.uniform4fv(l.uContrast, u.contrast)
    gl.uniform1f(l.uContrastSign, u.contrastSign)
    gl.uniform4fv(l.uCurveOn, u.curveOn)
    gl.uniform1f(l.uColorOn, u.colorOn)
    gl.uniform2fv(l.uSatVib, u.satVib)
    gl.uniform3fv(l.uHsl, u.hsl)
    gl.uniform1f(l.uGradingOn, u.gradingOn)
    gl.uniform1f(l.uGradeExp, u.gradeExp)
    gl.uniform1f(l.uGradeBalance, u.gradeBalance)
    gl.uniform3fv(l.uGradeTint, u.gradeTint)
    gl.uniform3fv(l.uGradeLum, u.gradeLum)
    this.draw()

    for (const p of u.presence) {
      this.presencePass(p, this.frames[cur], next())
      done()
    }

    if (u.detail) {
      const d = u.detail
      if (d.nrOn) {
        const [s0, s1, s2] = this.scratch(3)
        // The two halves of the split are blurred independently and both have
        // to be live at the end, so each blur ping-pongs back into its own
        // buffer: luma across s0/s1, chroma across s1/s2.
        this.planePass(PLANE_MEAN, this.frames[cur], s0)
        const luma = d.luma ? this.gaussBlur(d.luma, s0, s1, s0) : s0
        this.planePass(PLANE_CHROMA, this.frames[cur], s1)
        const chroma = d.chroma ? this.gaussBlur(d.chroma, s1, s2, s1) : s1
        const nl = this.begin('nr', next())
        this.bind(0, luma.tex, nl.uLuma)
        this.bind(1, chroma.tex, nl.uChroma)
        this.draw()
        done()
      }
      if (d.sharpen) {
        const [s0, s1] = this.scratch(2)
        const blurred = this.gaussBlur(d.sharpen, this.frames[cur], s0, s1)
        const sl = this.begin('sharpen', next())
        this.bind(0, this.frames[cur].tex, sl.uFrame)
        this.bind(1, blurred.tex, sl.uBlur)
        gl.uniform1f(sl.uStrength, d.sharpenStrength)
        this.draw()
        done()
      }
    }

    // Geometry: after detail, before the vignette, and the one stage that
    // changes the frame's size. Everything below here works at the output
    // size, which is why the vignette is only consistent with a crop now that
    // this pass exists — the engine's vignette tracks the cropped frame.
    let out = this.frames[cur]
    let outW = this.width
    let outH = this.height
    if (u.geometry) {
      const g = u.geometry
      const pool = this.geoScratch(
        Math.max(...g.passes.map((p) => p.outWidth)),
        Math.max(...g.passes.map((p) => p.outHeight)),
      )
      let src = out
      let srcW = outW
      let srcH = outH
      let slot = 0
      for (const p of g.passes) {
        this.geomPass(p, src, srcW, srcH, pool[slot])
        src = pool[slot]
        srcW = p.outWidth
        srcH = p.outHeight
        slot = 1 - slot
      }
      out = src
      outW = g.width
      outH = g.height
    }

    if (u.vignetteOn > 0.5) {
      // The vignette needs somewhere the right size to land. After geometry
      // that is the other half of the geometry pool; before it, the frame
      // ping-pong as before.
      const dst = u.geometry
        ? this.geoFrames.find((t) => t !== out) ?? this.geoFrames[0]
        : next()
      const vl = this.begin('vignette', dst, [outW, outH])
      this.bind(0, out.tex, vl.uFrame)
      gl.uniform2f(vl.uResolution, outW, outH)
      gl.uniform4fv(vl.uVignette, u.vignette)
      this.draw()
      out = dst
      if (!u.geometry) done()
    }

    if (this.canvas.width !== outW || this.canvas.height !== outH) {
      this.canvas.width = outW
      this.canvas.height = outH
    }
    this.outWidth = outW
    this.outHeight = outH
    const pl = this.begin('present', null, [outW, outH])
    this.bind(0, out.tex, pl.uFrame)
    this.draw()
  }

  /** RGBA bytes of the canvas as last drawn. Only used by the smoke test —
   *  a readback stalls the pipeline and has no place in the render loop. */
  /** Pixels of the presented canvas, **bottom row first**.
   *
   *  glReadPixels counts from the bottom-left, and the present pass flips the
   *  frame so the image is the right way up on screen — so this comes back in
   *  the opposite order to the image. Only the 1x1 capability probe reads it,
   *  where that cannot matter; anything larger has to reverse the rows. */
  readPixels(): Uint8Array {
    const { width, height } = this.size
    const out = new Uint8Array(width * height * 4)
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, out)
    return out
  }

  dispose(): void {
    const gl = this.gl
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    if (this.sourceTex) gl.deleteTexture(this.sourceTex)
    this.setLut(null)
    this.release(this.frames)
    this.release(this.aux)
    this.release(this.geoFrames)
    gl.deleteTexture(this.curveTex)
    gl.deleteProgram(this.edit)
    for (const p of Object.values(this.progs)) gl.deleteProgram(p)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
