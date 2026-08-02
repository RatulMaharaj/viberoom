import { useCallback, useEffect, useRef, useState } from 'react'

/** Fit-to-container image with wheel zoom (cursor-anchored), drag pan and
 * double-click fit/zoom toggle. Scale 1 = fit. */
export function ZoomableImage({ src, alt, resetKey, onZoomChange }: {
  src: string
  alt: string
  /** zoom/pan reset when this changes (not on src changes, so the src can be
   * swapped for a higher-res version mid-zoom) */
  resetKey: string
  onZoomChange?: (zoomed: boolean) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 })
  const drag = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null)

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
    if (t.scale === 1) return
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startY: e.clientY, x: t.x, y: t.y }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const d = drag.current
    setT((cur) =>
      clamp({ scale: cur.scale, x: d.x + e.clientX - d.startX, y: d.y + e.clientY - d.startY }),
    )
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const el = container.current
    if (!el) return
    if (t.scale > 1) {
      setT({ scale: 1, x: 0, y: 0 })
    } else {
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      setT(clamp({ scale: 3, x: -cx * 2, y: -cy * 2 }))
    }
  }

  return (
    <div
      ref={container}
      className="w-full h-full overflow-hidden flex items-center justify-center select-none"
      style={{ cursor: t.scale > 1 ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="max-h-full max-w-full object-contain"
        style={{
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
          transition: drag.current ? 'none' : 'transform 120ms ease-out',
        }}
      />
    </div>
  )
}
