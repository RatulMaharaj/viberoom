import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, FlipHorizontal2, FlipVertical2, X } from 'lucide-react'
import { api } from '../api'
import { pushAction } from '../undo'

interface CropRect {
  left: number
  top: number
  right: number
  bottom: number
}

const FULL: CropRect = { left: 0, top: 0, right: 1, bottom: 1 }
const ASPECTS: { label: string; ratio: number | null }[] = [
  { label: 'Free', ratio: null },
  { label: '1:1', ratio: 1 },
  { label: '3:2', ratio: 3 / 2 },
  { label: '2:3', ratio: 2 / 3 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '16:9', ratio: 16 / 9 },
]

type DragMode =
  | 'move'
  | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w'

export function CropTool({
  imageId,
  onClose,
  onApplied,
}: {
  imageId: string
  onClose: () => void
  onApplied: () => void
}) {
  const [recipe, setRecipe] = useState<Record<string, any> | null>(null)
  const [crop, setCrop] = useState<CropRect>(FULL)
  const [rotate, setRotate] = useState(0)
  const [flipH, setFlipH] = useState(false)
  const [flipV, setFlipV] = useState(false)
  const [aspect, setAspect] = useState<number | null>(null)
  const [bust, setBust] = useState('')
  const wrap = useRef<HTMLDivElement>(null)
  const drag = useRef<{ mode: DragMode; fx: number; fy: number; start: CropRect } | null>(null)
  const rotateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api.getRecipe(imageId).then((r) => {
      setRecipe(r)
      const g = r.geometry ?? {}
      setCrop(g.crop ?? FULL)
      setRotate(g.rotate ?? 0)
      setFlipH(g.flipH ?? false)
      setFlipV(g.flipV ?? false)
    })
  }, [imageId])

  // rotate/flip re-render server-side (debounced); crop rect is client-only
  const patchGeom = useCallback(
    (geom: object) => {
      if (rotateTimer.current) clearTimeout(rotateTimer.current)
      rotateTimer.current = setTimeout(async () => {
        await api.patchRecipe(imageId, { geometry: geom })
        setBust(String(Date.now()))
      }, 250)
    },
    [imageId],
  )

  const setRotateLive = (v: number) => {
    setRotate(v)
    patchGeom({ rotate: v })
  }
  const toggleFlip = (axis: 'h' | 'v') => {
    if (axis === 'h') {
      const v = !flipH
      setFlipH(v)
      patchGeom({ flipH: v })
    } else {
      const v = !flipV
      setFlipV(v)
      patchGeom({ flipV: v })
    }
  }

  const clampRect = useCallback(
    (r: CropRect, mode: DragMode): CropRect => {
      const MIN = 0.05
      let { left, top, right, bottom } = r
      left = Math.max(0, Math.min(left, 1 - MIN))
      top = Math.max(0, Math.min(top, 1 - MIN))
      right = Math.min(1, Math.max(right, left + MIN))
      bottom = Math.min(1, Math.max(bottom, top + MIN))
      // aspect lock (in on-screen pixel terms) for corner/edge resizes
      const el = wrap.current
      if (aspect && el && mode !== 'move') {
        const W = el.clientWidth
        const H = el.clientHeight
        const targetHFrac = ((right - left) * W) / aspect / H
        if (mode === 'n' || mode === 'nw' || mode === 'ne') {
          top = Math.max(0, bottom - targetHFrac)
        } else {
          bottom = Math.min(1, top + targetHFrac)
        }
        // if height clamped, re-derive width to keep the ratio exact
        const hFrac = bottom - top
        const targetWFrac = (hFrac * H * aspect) / W
        if (mode === 'w' || mode === 'nw' || mode === 'sw') {
          left = Math.max(0, right - targetWFrac)
        } else {
          right = Math.min(1, left + targetWFrac)
        }
      }
      return { left, top, right, bottom }
    },
    [aspect],
  )

  const applyAspect = (ratio: number | null) => {
    setAspect(ratio)
    const el = wrap.current
    if (!ratio || !el) return
    // reshape the current rect around its center to the chosen pixel aspect
    const W = el.clientWidth
    const H = el.clientHeight
    const cx = (crop.left + crop.right) / 2
    const cy = (crop.top + crop.bottom) / 2
    let wFrac = crop.right - crop.left
    let hFrac = (wFrac * W) / ratio / H
    if (hFrac > 1) {
      hFrac = 1
      wFrac = (hFrac * H * ratio) / W
    }
    let left = cx - wFrac / 2
    let top = cy - hFrac / 2
    left = Math.max(0, Math.min(left, 1 - wFrac))
    top = Math.max(0, Math.min(top, 1 - hFrac))
    setCrop({ left, top, right: left + wFrac, bottom: top + hFrac })
  }

  const onPointerDown = (mode: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = wrap.current!.getBoundingClientRect()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    drag.current = {
      mode,
      fx: (e.clientX - rect.left) / rect.width,
      fy: (e.clientY - rect.top) / rect.height,
      start: crop,
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !wrap.current) return
    const rect = wrap.current.getBoundingClientRect()
    const fx = (e.clientX - rect.left) / rect.width
    const fy = (e.clientY - rect.top) / rect.height
    const dx = fx - drag.current.fx
    const dy = fy - drag.current.fy
    const s = drag.current.start
    const m = drag.current.mode
    let next: CropRect
    if (m === 'move') {
      const w = s.right - s.left
      const h = s.bottom - s.top
      const left = Math.max(0, Math.min(s.left + dx, 1 - w))
      const top = Math.max(0, Math.min(s.top + dy, 1 - h))
      next = { left, top, right: left + w, bottom: top + h }
    } else {
      next = { ...s }
      if (m.includes('w')) next.left = s.left + dx
      if (m.includes('e')) next.right = s.right + dx
      if (m.includes('n')) next.top = s.top + dy
      if (m.includes('s')) next.bottom = s.bottom + dy
      next = clampRect(next, m)
    }
    setCrop(next)
  }

  const onPointerUp = () => {
    drag.current = null
  }

  const apply = async () => {
    const prev = recipe
    const updated = await api.patchRecipe(imageId, {
      geometry: { crop, rotate, flipH, flipV },
    })
    if (prev) {
      pushAction({
        undo: () => api.putRecipe(imageId, prev),
        redo: () => api.putRecipe(imageId, updated),
      })
    }
    onApplied()
    onClose()
  }

  const cancel = async () => {
    // rotate/flip were patched live for preview; restore the original geometry
    if (recipe) await api.putRecipe(imageId, recipe)
    onApplied()
    onClose()
  }

  const handles: { mode: DragMode; style: React.CSSProperties; cursor: string }[] = [
    { mode: 'nw', style: { left: 0, top: 0 }, cursor: 'nwse-resize' },
    { mode: 'ne', style: { right: 0, top: 0 }, cursor: 'nesw-resize' },
    { mode: 'sw', style: { left: 0, bottom: 0 }, cursor: 'nesw-resize' },
    { mode: 'se', style: { right: 0, bottom: 0 }, cursor: 'nwse-resize' },
    { mode: 'n', style: { left: '50%', top: 0, transform: 'translateX(-50%)' }, cursor: 'ns-resize' },
    { mode: 's', style: { left: '50%', bottom: 0, transform: 'translateX(-50%)' }, cursor: 'ns-resize' },
    { mode: 'w', style: { left: 0, top: '50%', transform: 'translateY(-50%)' }, cursor: 'ew-resize' },
    { mode: 'e', style: { right: 0, top: '50%', transform: 'translateY(-50%)' }, cursor: 'ew-resize' },
  ]

  const pct = (v: number) => `${v * 100}%`

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-base-300">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-base-200 text-xs">
        <span className="font-bold">Crop &amp; Straighten</span>
        <div className="join">
          {ASPECTS.map((a) => (
            <button
              key={a.label}
              className={`btn btn-xs join-item ${aspect === a.ratio ? 'btn-primary' : ''}`}
              onClick={() => applyAspect(a.ratio)}
            >
              {a.label}
            </button>
          ))}
        </div>
        <span className="opacity-60 ml-2">Straighten</span>
        <input
          type="range"
          className="vr-slider w-36"
          min={-45}
          max={45}
          step={0.1}
          value={rotate}
          onChange={(e) => setRotateLive(Number(e.target.value))}
          onDoubleClick={() => setRotateLive(0)}
        />
        <span className="font-mono w-12">{rotate.toFixed(1)}°</span>
        <button className={`btn btn-xs ${flipH ? 'btn-primary' : 'btn-ghost'}`} title="Flip horizontal" onClick={() => toggleFlip('h')}>
          <FlipHorizontal2 size={13} />
        </button>
        <button className={`btn btn-xs ${flipV ? 'btn-primary' : 'btn-ghost'}`} title="Flip vertical" onClick={() => toggleFlip('v')}>
          <FlipVertical2 size={13} />
        </button>
        <button className="btn btn-xs btn-ghost" onClick={() => setCrop(FULL)}>
          Reset
        </button>
        <div className="flex-1" />
        <button className="btn btn-xs btn-ghost" onClick={cancel}>
          <X size={13} /> Cancel
        </button>
        <button className="btn btn-xs btn-primary" onClick={apply}>
          <Check size={13} /> Apply
        </button>
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center p-4">
        <div ref={wrap} className="relative inline-block max-h-full overflow-hidden">
          <img
            src={api.previewUrl(imageId, 2048, bust, false, true)}
            alt=""
            draggable={false}
            className="max-h-[calc(100vh-14rem)] max-w-full object-contain select-none"
          />
          {/* crop rect: everything outside is dimmed via the huge box-shadow */}
          <div
            className="absolute border border-white/90"
            style={{
              left: pct(crop.left),
              top: pct(crop.top),
              width: pct(crop.right - crop.left),
              height: pct(crop.bottom - crop.top),
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
              cursor: 'move',
              touchAction: 'none',
            }}
            onPointerDown={onPointerDown('move')}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* rule-of-thirds grid */}
            {[1, 2].map((i) => (
              <div key={`v${i}`} className="absolute top-0 bottom-0 w-px bg-white/30" style={{ left: pct(i / 3) }} />
            ))}
            {[1, 2].map((i) => (
              <div key={`h${i}`} className="absolute left-0 right-0 h-px bg-white/30" style={{ top: pct(i / 3) }} />
            ))}
            {handles.map((h) => (
              <div
                key={h.mode}
                className="absolute w-2.5 h-2.5 bg-white border border-black/40"
                style={{ ...h.style, cursor: h.cursor, touchAction: 'none' }}
                onPointerDown={onPointerDown(h.mode)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
