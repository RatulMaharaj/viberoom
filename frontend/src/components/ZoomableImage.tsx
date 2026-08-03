import { useCallback, useEffect, useRef, useState } from 'react'

/** Fit-to-container image with wheel zoom (cursor-anchored), drag pan and
 * click-to-zoom. Scale 1 = fit. */

/** Where a single click lands. Scale is relative to fit, so 2 is twice the
 *  fitted size — enough to judge focus without losing your place. */
const CLICK_ZOOM = 2
export function ZoomableImage({
  src,
  alt,
  resetKey,
  filter,
  onZoomChange,
  onLoaded,
  overlay,
  hideImage = false,
}: {
  src: string
  alt: string
  /** zoom/pan reset when this changes (not on src changes, so the src can be
   * swapped for a higher-res version mid-zoom) */
  resetKey: string
  /** CSS filter applied to the image (live edit approximation) */
  filter?: string
  onZoomChange?: (zoomed: boolean) => void
  /** fires when a (new) src finishes loading */
  onLoaded?: () => void
  /** An alternative surface — the GPU canvas — laid out where the image is and
   *  handed the same transform, so zoom and pan apply to whichever is showing. */
  overlay?: (transform: React.CSSProperties) => React.ReactNode
  /** Hide the <img> rather than unmount it, so a src that is still current
   *  does not have to be re-decoded when it comes back. */
  hideImage?: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 })
  const drag = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null)
  /** set once a pointer travels far enough to count as a pan, so releasing
   *  after a drag doesn't also fire the click-to-zoom toggle */
  const panned = useRef(false)

  // reset when the image changes
  useEffect(() => {
    setT({ scale: 1, x: 0, y: 0 })
  }, [resetKey])

  useEffect(() => {
    onZoomChange?.(t.scale > 1)
  }, [t.scale, onZoomChange])

  const clamp = useCallback((next: { scale: number; x: number; y: number }) => {
    const scale = Math.min(8, Math.max(1, next.scale))
    if (scale === 1) return { scale: 1, x: 0, y: 0 }
    const el = container.current
    if (!el) return { ...next, scale }
    // keep the image from being dragged fully out of view
    const maxX = (el.clientWidth * (scale - 1)) / 2
    const maxY = (el.clientHeight * (scale - 1)) / 2
    return {
      scale,
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    }
  }, [])

  useEffect(() => {
    const el = container.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setT((cur) => {
        const factor = Math.exp(-e.deltaY * 0.002)
        const scale = Math.min(8, Math.max(1, cur.scale * factor))
        if (scale === cur.scale) return cur
        // zoom anchored at the cursor position
        const rect = el.getBoundingClientRect()
        const cx = e.clientX - rect.left - rect.width / 2
        const cy = e.clientY - rect.top - rect.height / 2
        const k = scale / cur.scale
        return clamp({ scale, x: cx - k * (cx - cur.x), y: cy - k * (cy - cur.y) })
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [clamp])

  const onPointerDown = (e: React.PointerEvent) => {
    panned.current = false
    if (t.scale === 1) return
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startY: e.clientY, x: t.x, y: t.y }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const d = drag.current
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 4) panned.current = true
    setT((cur) =>
      clamp({ scale: cur.scale, x: d.x + e.clientX - d.startX, y: d.y + e.clientY - d.startY }),
    )
  }
  const onPointerUp = () => {
    drag.current = null
  }

  /** Toggle fit <-> CLICK_ZOOM, centring on whatever was clicked. */
  const onClick = (e: React.MouseEvent) => {
    if (panned.current) return
    const el = container.current
    if (!el) return
    if (t.scale > 1) {
      setT({ scale: 1, x: 0, y: 0 })
      return
    }
    const rect = el.getBoundingClientRect()
    const cx = e.clientX - rect.left - rect.width / 2
    const cy = e.clientY - rect.top - rect.height / 2
    setT(clamp({ scale: CLICK_ZOOM, x: -cx * (CLICK_ZOOM - 1), y: -cy * (CLICK_ZOOM - 1) }))
  }

  const transform: React.CSSProperties = {
    transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
    transition: drag.current ? 'none' : 'transform 120ms ease-out',
  }

  return (
    <div
      ref={container}
      className="w-full h-full overflow-hidden flex items-center justify-center select-none"
      style={{ cursor: t.scale > 1 ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in' }}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={onLoaded}
        className="max-h-full max-w-full object-contain"
        style={{
          ...transform,
          filter: filter || undefined,
          display: hideImage ? 'none' : undefined,
        }}
      />
      {overlay?.(transform)}
    </div>
  )
}
