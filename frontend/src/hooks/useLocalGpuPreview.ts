import { useEffect, useRef, useState } from 'react'
import { GpuRenderer, gpuEnabled, gpuSupportsRecipe, type LiveRecipe } from '../gpu'
import { sourceFrame } from '../local/decode'
import { getSource } from '../source'

/** Live develop preview with no server behind it.
 *
 *  `useGpuPreview` exists to arbitrate between two pictures — the optimistic
 *  GPU frame and the server render that eventually replaces it. Locally there
 *  is no second opinion, so all of that machinery (server fetches, hashes,
 *  out-of-order guards, the settle-back-to-server transition) is dead weight.
 *  What remains is small enough to say plainly: decode the file once, then
 *  redraw whenever the sliders publish a new recipe.
 *
 *  The one honest limit is `gpu/support.ts`. A recipe using an op the shader
 *  lacks cannot be drawn here at all, and there is nothing to fall back to, so
 *  this reports `off` and the caller keeps showing the still frame from
 *  `local/preview.ts` — which in that case is the untouched original, badged
 *  as such. Editing still works; only the picture stops keeping up.
 */
export function useLocalGpuPreview({
  imageId,
  size,
  live,
  enabled,
}: {
  imageId: string | undefined
  size: number
  live: LiveRecipe
  /** False for the views the shader chain cannot reproduce — before/after,
   *  the crop tool, and zoomed-in, where the still frame is rendered larger. */
  enabled: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<GpuRenderer | null>(null)
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState<'gpu' | 'off'>('off')

  const active = enabled && gpuEnabled()

  // ---- renderer lifecycle ----
  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    if (!canvas) return
    let renderer: GpuRenderer
    try {
      renderer = new GpuRenderer(canvas)
    } catch {
      // Detection passed, construction did not. No preview to drive; the
      // caller's still frame stays on screen.
      return
    }
    rendererRef.current = renderer
    return () => {
      rendererRef.current = null
      setReady(false)
      renderer.dispose()
    }
  }, [active])

  // ---- source frame, decoded from the file itself ----
  useEffect(() => {
    if (!active || !imageId) return
    let stale = false
    setReady(false)
    ;(async () => {
      const source = await getSource()
      const file = await source.getFile(imageId)
      // `getFile` is null on the server source, which is also the only case
      // where this hook is never enabled.
      if (!file || stale) return
      const frame = await sourceFrame(file, size)
      if (stale) return
      rendererRef.current?.setSource(frame)
      setReady(Boolean(rendererRef.current))
    })().catch(() => {})
    return () => {
      stale = true
    }
  }, [active, imageId, size])

  // ---- the render loop ----
  useEffect(() => {
    if (!active || !ready) {
      setMode('off')
      return
    }
    let raf = 0
    let drawnVersion = -1
    let current: 'gpu' | 'off' = 'off'
    let redrawOnShow = false

    const to = (next: 'gpu' | 'off') => {
      if (next === current) return
      // Coming back from hidden, redraw once the canvas is really in the
      // layout again — same reason as the server-mode loop.
      if (next === 'gpu') redrawOnShow = true
      current = next
      setMode(next)
    }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const renderer = rendererRef.current
      const recipe = live.current
      if (!renderer || !recipe || renderer.lost || !gpuSupportsRecipe(recipe)) {
        to('off')
        return
      }
      to('gpu')
      if (live.version !== drawnVersion || redrawOnShow) {
        redrawOnShow = current !== 'gpu'
        drawnVersion = live.version
        renderer.render(recipe)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, ready, live])

  return { canvasRef, mode }
}
