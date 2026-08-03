/** WebGL2 renderer for the stage-1 pointwise chain.
 *
 *  Framework-free by design — DOM and WebGL only, no React anywhere in this
 *  directory. That is what makes it drivable from a plain page (or a headless
 *  harness) without standing up a component tree.
 */

import { EDIT_SOURCE, PRESENT_SOURCE, VERTEX_SOURCE, CURVE_ROWS, CURVE_SIZE } from './shader'
import { buildUniforms } from './uniforms'
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
  'uSource', 'uCurves', 'uResolution', 'uWbGain', 'uExposure', 'uRegions',
  'uContrast', 'uContrastSign', 'uCurveOn', 'uColorOn', 'uSatVib', 'uHsl',
  'uGradingOn', 'uGradeExp', 'uGradeBalance', 'uGradeTint', 'uGradeLum',
  'uVignetteOn', 'uVignette',
]

export class GpuRenderer {
  private gl: WebGL2RenderingContext
  private edit: WebGLProgram
  private present: WebGLProgram
  private editLoc: Locations
  private presentLoc: Locations
  private curveTex: WebGLTexture
  private sourceTex: WebGLTexture | null = null
  private frameTex: WebGLTexture | null = null
  private fbo: WebGLFramebuffer | null = null
  private width = 0
  private height = 0
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
    this.present = link(gl, PRESENT_SOURCE)
    this.editLoc = locations(gl, this.edit, EDIT_UNIFORMS)
    this.presentLoc = locations(gl, this.present, ['uFrame'])

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

  /** Uploads a decoded frame and resizes the render targets to match it. */
  setSource(frame: SourceFrame): void {
    const gl = this.gl
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
      if (this.frameTex) gl.deleteTexture(this.frameTex)
      if (this.fbo) gl.deleteFramebuffer(this.fbo)
      this.frameTex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.frameTex)
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
        gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST)
      }
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) {
        gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE)
      }
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h)
      this.fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.frameTex, 0,
      )
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new GpuUnavailable(`float framebuffer incomplete (0x${status.toString(16)})`)
      }
    }
  }

  /** Draws one frame for `recipe`. Cheap enough to call from a rAF loop. */
  render(recipe: any): void {
    const gl = this.gl
    if (!this.sourceTex || this.lost) return
    const u = buildUniforms(recipe)

    gl.bindTexture(gl.TEXTURE_2D, this.curveTex)
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, CURVE_SIZE, CURVE_ROWS, gl.RED, gl.FLOAT, u.curves,
    )

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.viewport(0, 0, this.width, this.height)
    gl.useProgram(this.edit)
    const l = this.editLoc
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex)
    gl.uniform1i(l.uSource, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex)
    gl.uniform1i(l.uCurves, 1)
    gl.uniform2f(l.uResolution, this.width, this.height)
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
    gl.uniform1f(l.uVignetteOn, u.vignetteOn)
    gl.uniform4fv(l.uVignette, u.vignette)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.useProgram(this.present)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex)
    gl.uniform1i(this.presentLoc.uFrame, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
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
    if (this.frameTex) gl.deleteTexture(this.frameTex)
    if (this.fbo) gl.deleteFramebuffer(this.fbo)
    gl.deleteTexture(this.curveTex)
    gl.deleteProgram(this.edit)
    gl.deleteProgram(this.present)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
