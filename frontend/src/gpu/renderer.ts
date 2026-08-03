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
import type { GaussPass, PresencePass } from './uniforms'
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
]

/** The programs above the edit pass, and the uniforms each one needs. */
const PASS_UNIFORMS: Record<string, string[]> = {
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
  plane: PLANE_SOURCE,
  box: BOX_SOURCE,
  gauss: GAUSS_SOURCE,
  presence: PRESENCE_SOURCE,
  nr: NR_SOURCE,
  sharpen: SHARPEN_SOURCE,
  vignette: VIGNETTE_SOURCE,
  present: PRESENT_SOURCE,
}

/** A float render target: the texture and the framebuffer that writes it. */
interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
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
  private width = 0
  private height = 0
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

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  /** Allocates one RGBA16F target at the current size. */
  private makeTarget(): Target {
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
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, this.width, this.height)
    const fbo = gl.createFramebuffer()
    if (!fbo) throw new GpuUnavailable('could not create framebuffer')
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new GpuUnavailable(`float framebuffer incomplete (0x${status.toString(16)})`)
    }
    return { tex, fbo }
  }

  /** Scratch planes, allocated the first time a blur asks for them. Presence
   *  needs two and noise reduction three, so a recipe that only ever uses the
   *  former never pays for the third. */
  private scratch(n: number): Target[] {
    while (this.aux.length < n) this.aux.push(this.makeTarget())
    return this.aux
  }

  private release(targets: Target[]): void {
    for (const t of targets) {
      this.gl.deleteTexture(t.tex)
      this.gl.deleteFramebuffer(t.fbo)
    }
    targets.length = 0
  }

  /** Binds a program and the target it draws into. `null` means the canvas. */
  private begin(name: string, target: Target | null): Locations {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null)
    gl.viewport(0, 0, this.width, this.height)
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

  /** Draws one frame for `recipe`. Cheap enough to call from a rAF loop. */
  render(recipe: any): void {
    const gl = this.gl
    if (!this.sourceTex || this.lost || this.frames.length < 2) return
    const u = buildUniforms(recipe, {
      width: this.width,
      height: this.height,
      scale: this.scale,
    })

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

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frames[cur].fbo)
    gl.viewport(0, 0, this.width, this.height)
    gl.useProgram(this.edit)
    const l = this.editLoc
    this.bind(0, this.sourceTex, l.uSource)
    this.bind(1, this.curveTex, l.uCurves)
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

    if (u.vignetteOn > 0.5) {
      const vl = this.begin('vignette', next())
      this.bind(0, this.frames[cur].tex, vl.uFrame)
      gl.uniform2f(vl.uResolution, this.width, this.height)
      gl.uniform4fv(vl.uVignette, u.vignette)
      this.draw()
      done()
    }

    const pl = this.begin('present', null)
    this.bind(0, this.frames[cur].tex, pl.uFrame)
    this.draw()
  }

  /** RGBA bytes of the canvas as last drawn. Only used by the smoke test —
   *  a readback stalls the pipeline and has no place in the render loop. */
  readPixels(): Uint8Array {
    const out = new Uint8Array(this.width * this.height * 4)
    this.gl.readPixels(0, 0, this.width, this.height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, out)
    return out
  }

  dispose(): void {
    const gl = this.gl
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    if (this.sourceTex) gl.deleteTexture(this.sourceTex)
    this.release(this.frames)
    this.release(this.aux)
    gl.deleteTexture(this.curveTex)
    gl.deleteProgram(this.edit)
    for (const p of Object.values(this.progs)) gl.deleteProgram(p)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
