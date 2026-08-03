import { useEffect, useRef, useState } from 'react'
import {
  GpuRenderer,
  fetchServerFrame,
  fetchSource,
  gpuEnabled,
  gpuSupportsRecipe,
  type LiveRecipe,
  type ServerFrame,
} from '../gpu'

/** How the loupe should be drawing right now. */
export type PreviewMode =
  /** GPU frame on screen: the sliders have moved past what the server has. */
  | 'gpu'
  /** The fetched server render depicts the live recipe — show the real pixels. */
  | 'server'
  /** No GPU path; the caller keeps its plain <img src={previewUrl}>. */
  | 'off'

interface Options {
  imageId: string | undefined
  size: number
  live: LiveRecipe
  /** False for the modes the GPU chain has no answer for — soft proof, the
   *  before/after toggle, the crop tool. */
  enabled: boolean
  /** Bumped by the caller once a recipe has been persisted, so a fresh server
   *  render is worth asking for. */
  commitTick: number
}

/**
 * Drives the client-side preview and decides which of the two frames is shown.
 *
 * They are never composited. Either the server's render depicts exactly the
 * recipe the sliders are showing — in which case it wins, being the real
 * pipeline — or it does not, and the GPU frame stands alone until it does.
 * A cross-fade would put pixels on screen that are neither.
 */
export function useGpuPreview({ imageId, size, live, enabled, commitTick }: Options) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<GpuRenderer | null>(null)
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState<PreviewMode>('off')
  const [serverFrame, setServerFrame] = useState<ServerFrame | null>(null)

  /** The recipe the server frame on screen was rendered from, by identity —
   *  `setAt` allocates a fresh object per edit, so identity is exactly the
   *  question "have the sliders moved since". */
  const shownRecipe = useRef<any>(null)
  /** Serial of the newest server render applied, so a slow earlier response
   *  cannot overwrite a newer one that already landed. */
  const applied = useRef(-1)
  const issued = useRef(0)
  const shownHash = useRef('')

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
      // Detection passed and construction still failed. Nothing to do but use
      // the server; `liveDeltaFilter` stays the feedback path in that case.
      return
    }
    rendererRef.current = renderer
    return () => {
      rendererRef.current = null
      setReady(false)
      renderer.dispose()
    }
  }, [active])

  // ---- source frame ----
  useEffect(() => {
    if (!active || !imageId) return
    const ctrl = new AbortController()
    setReady(false)
    fetchSource(imageId, size, 'rgb9e5', ctrl.signal)
      .then((frame) => {
        if (ctrl.signal.aborted) return
        rendererRef.current?.setSource(frame)
        setReady(Boolean(rendererRef.current))
      })
      .catch(() => {})
    return () => ctrl.abort()
  }, [active, imageId, size])

  // ---- server render, fetched rather than <img>'d so its hash comes with it ----
  useEffect(() => {
    if (!active || !imageId) return
    const ctrl = new AbortController()
    const seq = ++issued.current
    const asked = live.current
    fetchServerFrame(imageId, size, ctrl.signal)
      .then((frame) => {
        // Out-of-order arrival is normal — a 4096 px render started earlier can
        // land after a later one. The hash settles it without a stale swap:
        // an older response whose pixels are already on screen is a no-op,
        // and any other older response is dropped.
        if (ctrl.signal.aborted || (seq < applied.current && frame.hash !== shownHash.current)) {
          frame.revoke()
          return
        }
        applied.current = seq
        shownHash.current = frame.hash
        shownRecipe.current = asked
        setServerFrame((prev) => {
          prev?.revoke()
          return frame
        })
      })
      .catch(() => {})
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, imageId, size, commitTick])

  // release the last blob URL on unmount
  useEffect(() => () => serverFrame?.revoke(), [serverFrame])

  // ---- the render loop ----
  useEffect(() => {
    if (!active || !ready) {
      setMode('off')
      return
    }
    let raf = 0
    let drawnVersion = -1
    let current: PreviewMode = 'off'
    const to = (next: PreviewMode) => {
      // setState only on a real transition: this runs 60 times a second and a
      // redundant update would re-render the whole develop panel each frame.
      if (next !== current) {
        current = next
        setMode(next)
      }
    }
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const renderer = rendererRef.current
      const recipe = live.current
      // Context loss from tab backgrounding is routine, not exceptional.
      if (!renderer || !recipe || renderer.lost || !gpuSupportsRecipe(recipe)) {
        to('off')
        return
      }
      if (shownRecipe.current === recipe) {
        to('server')
        return
      }
      to('gpu')
      if (live.version !== drawnVersion) {
        drawnVersion = live.version
        renderer.render(recipe)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, ready, live])

  return {
    canvasRef,
    mode,
    /** Blob URL of the last server render. Null while the GPU path is off, so
     *  the caller falls back to its own preview URL. */
    serverSrc: mode === 'off' ? null : (serverFrame?.url ?? null),
  }
}
