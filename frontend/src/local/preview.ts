/** Rendering a develop preview with no server behind it.
 *
 *  In server mode `/preview` is the real pipeline and the WebGL renderer is an
 *  optimistic stand-in that the server render replaces as soon as it lands.
 *  Here there is no second opinion: whatever this file draws is the only image
 *  the photographer will see.
 *
 *  That changes the failure rule. `gpu/support.ts` is an allowlist of the ops
 *  the shader reproduces exactly, and a recipe outside it — a crop, a LUT, a
 *  mask, sharpening — has nowhere to fall back to. Rendering the supported
 *  half of such a recipe would put a picture on screen that matches neither the
 *  photographer's edits nor their original, so instead the *original* is shown
 *  and the caller is told which of the two it got. A visibly unedited photo
 *  with a badge over it is a state a person can reason about; a half-applied
 *  recipe is not.
 */

import { GpuRenderer, gpuEnabled, gpuSupportsRecipe } from '../gpu'
import { sourceFrame, thumbnailBitmap } from './decode'

/** What the pixels actually depict. */
export type RenderedAs =
  /** The recipe, drawn by the shader. */
  | 'gpu'
  /** The untouched original — either asked for, or all we could honestly draw. */
  | 'original'

export interface RenderedPreview {
  blob: Blob
  rendered: RenderedAs
}

/** One renderer for the whole session. Each instance holds a WebGL context and
 *  several float frames, and browsers cap contexts per page at around sixteen —
 *  one per preview would start silently losing the oldest. */
let canvas: HTMLCanvasElement | null = null
let renderer: GpuRenderer | null = null

function acquire(): GpuRenderer | null {
  if (renderer && !renderer.lost) return renderer
  renderer?.dispose()
  renderer = null
  try {
    canvas ??= document.createElement('canvas')
    renderer = new GpuRenderer(canvas)
  } catch {
    // Construction can fail where detection passed (a driver that lost its
    // context, a tab that ran out of them). Not a bug, just no GPU today.
    renderer = null
  }
  return renderer
}

/**
 * Snapshot the WebGL canvas.
 *
 * The drawing buffer is not preserved, so the copy has to happen in the same
 * task as the draw — hence a synchronous `drawImage` into a 2D canvas here,
 * rather than `toBlob` straight off the GL canvas, which resolves on a later
 * turn by which time the buffer may have been cleared.
 */
async function snapshot(gl: HTMLCanvasElement): Promise<Blob> {
  const out = new OffscreenCanvas(gl.width, gl.height)
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('No 2D context')
  ctx.drawImage(gl, 0, 0)
  return out.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
}

/**
 * Draw `recipe` over `file` at roughly `size` on the long edge.
 *
 * `original` and an unrenderable recipe take the same path on purpose: both
 * mean "show what the camera recorded", and the only difference is whether the
 * caller expected it.
 */
export async function renderPreview(
  file: File,
  recipe: unknown,
  size: number,
  original = false,
  nocrop = false,
): Promise<RenderedPreview> {
  // The crop tool needs every edit *except* the crop, so it can show what is
  // being trimmed away. Resetting it here rather than asking callers to hand
  // in a doctored recipe keeps the "what does this file look like" question
  // in one place.
  if (nocrop && recipe && typeof recipe === 'object') {
    const r = recipe as Record<string, any>
    recipe = { ...r, geometry: { ...r.geometry, crop: { left: 0, top: 0, right: 1, bottom: 1 } } }
  }
  // `?debug=1` breaks the wait into its parts. "Switching is slow" can mean
  // the decode, the resample, the texture packing, the draw or the JPEG
  // encode, and they are fixed in completely different places.
  const t = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')
    ? (label: string, at: number) => console.log(`[preview] ${label} ${Math.round(performance.now() - at)}ms`)
    : () => {}

  const drawable = !original && gpuEnabled() && gpuSupportsRecipe(recipe)
  if (drawable) {
    try {
      const t0 = performance.now()
      const frame = await sourceFrame(file, size)
      t(`frame (decode+resize+pack) ${file.name}`, t0)
      const gpu = acquire()
      if (gpu) {
        const t1 = performance.now()
        gpu.setSource(frame)
        gpu.render(recipe)
        t('upload+render', t1)
        const t2 = performance.now()
        const blob = await snapshot(canvas!)
        t('jpeg encode', t2)
        t('TOTAL', t0)
        return { blob, rendered: 'gpu' }
      }
    } catch {
      // A decode that failed, a context lost mid-render: fall through to the
      // original rather than leaving the loupe empty.
    }
  }

  // The unedited frame, by the same route the grid uses — which means a RAW
  // whose camera embedded a preview does not pay for a decode to show it.
  const bitmap = await thumbnailBitmap(file, size)
  const out = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('No 2D context')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return { blob: await out.convertToBlob({ type: 'image/jpeg', quality: 0.92 }), rendered: 'original' }
}
