import { useEffect, useRef, useState } from 'react'
import { ChevronRight, FileImage, Pencil, RotateCcw, Wand2 } from 'lucide-react'
import { api } from '../api'
import { pushAction } from '../undo'
import { DevelopExtras } from './DevelopExtras'
import { Histogram } from './Histogram'

interface SliderDef {
  label: string
  path: string[] // location in the recipe, e.g. ['tone', 'exposure']
  min: number
  max: number
  step: number
  def: number
  /** colored rail hinting at the axis: temp, tint, dark-to-light, saturation */
  rail?: 'temp' | 'tint' | 'luma' | 'sat'
}

/** Groups marked collapsed start folded — there are far more controls than
 *  fit on screen, and most shots never touch HSL or optics. */

const GROUPS: { title: string; sliders: SliderDef[]; collapsed?: boolean }[] = [
  {
    title: 'White Balance',
    sliders: [
      { label: 'Temp', path: ['whiteBalance', 'temp'], min: 2000, max: 20000, step: 50, def: 5500, rail: 'temp' },
      { label: 'Tint', path: ['whiteBalance', 'tint'], min: -150, max: 150, step: 1, def: 0, rail: 'tint' },
    ],
  },
  {
    title: 'Tone',
    sliders: [
      { label: 'Exposure', path: ['tone', 'exposure'], min: -5, max: 5, step: 0.05, def: 0, rail: 'luma' },
      { label: 'Contrast', path: ['tone', 'contrast'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Highlights', path: ['tone', 'highlights'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
      { label: 'Shadows', path: ['tone', 'shadows'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
      { label: 'Whites', path: ['tone', 'whites'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
      { label: 'Blacks', path: ['tone', 'blacks'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
    ],
  },
  {
    title: 'Presence',
    sliders: [
      { label: 'Texture', path: ['tone', 'texture'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Clarity', path: ['tone', 'clarity'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Dehaze', path: ['tone', 'dehaze'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Vibrance', path: ['color', 'vibrance'], min: -100, max: 100, step: 1, def: 0, rail: 'sat' },
      { label: 'Saturation', path: ['color', 'saturation'], min: -100, max: 100, step: 1, def: 0, rail: 'sat' },
    ],
  },
  {
    title: 'Detail',
    sliders: [
      { label: 'Sharpening', path: ['detail', 'sharpening', 'amount'], min: 0, max: 150, step: 1, def: 0 },
      { label: 'Radius', path: ['detail', 'sharpening', 'radius'], min: 0.5, max: 3, step: 0.1, def: 1 },
      { label: 'Detail', path: ['detail', 'sharpening', 'detail'], min: 0, max: 100, step: 1, def: 25 },
      { label: 'NR Luminance', path: ['detail', 'noiseReduction', 'luminance'], min: 0, max: 100, step: 1, def: 0 },
      { label: 'NR Color', path: ['detail', 'noiseReduction', 'color'], min: 0, max: 100, step: 1, def: 0 },
    ],
  },
  {
    title: 'Grading — Shadows',
    collapsed: true,
    sliders: [
      { label: 'Hue', path: ['color', 'grading', 'shadows', 'hue'], min: 0, max: 360, step: 1, def: 0 },
      { label: 'Saturation', path: ['color', 'grading', 'shadows', 'saturation'], min: 0, max: 100, step: 1, def: 0, rail: 'sat' },
      { label: 'Luminance', path: ['color', 'grading', 'shadows', 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
    ],
  },
  {
    title: 'Grading — Midtones',
    collapsed: true,
    sliders: [
      { label: 'Hue', path: ['color', 'grading', 'midtones', 'hue'], min: 0, max: 360, step: 1, def: 0 },
      { label: 'Saturation', path: ['color', 'grading', 'midtones', 'saturation'], min: 0, max: 100, step: 1, def: 0, rail: 'sat' },
      { label: 'Luminance', path: ['color', 'grading', 'midtones', 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
    ],
  },
  {
    title: 'Grading — Highlights',
    collapsed: true,
    sliders: [
      { label: 'Hue', path: ['color', 'grading', 'highlights', 'hue'], min: 0, max: 360, step: 1, def: 0 },
      { label: 'Saturation', path: ['color', 'grading', 'highlights', 'saturation'], min: 0, max: 100, step: 1, def: 0, rail: 'sat' },
      { label: 'Luminance', path: ['color', 'grading', 'highlights', 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
    ],
  },
  {
    title: 'Optics',
    collapsed: true,
    sliders: [
      { label: 'Distortion', path: ['lens', 'distortion'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Vignetting', path: ['lens', 'vignette'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'CA Red/Cyan', path: ['lens', 'caRed'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'CA Blue/Yellow', path: ['lens', 'caBlue'], min: -100, max: 100, step: 1, def: 0 },
    ],
  },
  {
    title: 'Geometry',
    collapsed: true,
    sliders: [
      { label: 'Rotate', path: ['geometry', 'rotate'], min: -45, max: 45, step: 0.1, def: 0 },
      { label: 'Vertical', path: ['geometry', 'perspective', 'vertical'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Horizontal', path: ['geometry', 'perspective', 'horizontal'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Scale', path: ['geometry', 'perspective', 'scale'], min: 50, max: 150, step: 1, def: 100 },
    ],
  },
  {
    title: 'Effects',
    collapsed: true,
    sliders: [
      { label: 'Vignette', path: ['effects', 'vignette', 'amount'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Midpoint', path: ['effects', 'vignette', 'midpoint'], min: 0, max: 100, step: 1, def: 50 },
      { label: 'Feather', path: ['effects', 'vignette', 'feather'], min: 0, max: 100, step: 1, def: 50 },
      { label: 'Roundness', path: ['effects', 'vignette', 'roundness'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Grain', path: ['effects', 'grain', 'amount'], min: 0, max: 100, step: 1, def: 0 },
      { label: 'Grain Size', path: ['effects', 'grain', 'size'], min: 0, max: 100, step: 1, def: 25 },
    ],
  },
  {
    title: 'HSL — Red',
    collapsed: true,
    sliders: [
      { label: 'Hue', path: ['color', 'hsl', 'red', 'hue'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Saturation', path: ['color', 'hsl', 'red', 'saturation'], min: -100, max: 100, step: 1, def: 0, rail: 'sat' },
      { label: 'Luminance', path: ['color', 'hsl', 'red', 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
    ],
  },
  {
    title: 'HSL — Orange',
    collapsed: true,
    sliders: [
      { label: 'Hue', path: ['color', 'hsl', 'orange', 'hue'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Saturation', path: ['color', 'hsl', 'orange', 'saturation'], min: -100, max: 100, step: 1, def: 0, rail: 'sat' },
      { label: 'Luminance', path: ['color', 'hsl', 'orange', 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
    ],
  },
  {
    title: 'HSL — Yellow',
    collapsed: true,
    sliders: [
      { label: 'Hue', path: ['color', 'hsl', 'yellow', 'hue'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Saturation', path: ['color', 'hsl', 'yellow', 'saturation'], min: -100, max: 100, step: 1, def: 0, rail: 'sat' },
      { label: 'Luminance', path: ['color', 'hsl', 'yellow', 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
    ],
  },
  {
    title: 'HSL — Green',
    collapsed: true,
    sliders: [
      { label: 'Hue', path: ['color', 'hsl', 'green', 'hue'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Saturation', path: ['color', 'hsl', 'green', 'saturation'], min: -100, max: 100, step: 1, def: 0, rail: 'sat' },
      { label: 'Luminance', path: ['color', 'hsl', 'green', 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
    ],
  },
  {
    title: 'HSL — Aqua',
    collapsed: true,
    sliders: [
      { label: 'Hue', path: ['color', 'hsl', 'aqua', 'hue'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Saturation', path: ['color', 'hsl', 'aqua', 'saturation'], min: -100, max: 100, step: 1, def: 0, rail: 'sat' },
      { label: 'Luminance', path: ['color', 'hsl', 'aqua', 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
    ],
  },
  {
    title: 'HSL — Blue',
    collapsed: true,
    sliders: [
      { label: 'Hue', path: ['color', 'hsl', 'blue', 'hue'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Saturation', path: ['color', 'hsl', 'blue', 'saturation'], min: -100, max: 100, step: 1, def: 0, rail: 'sat' },
      { label: 'Luminance', path: ['color', 'hsl', 'blue', 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
    ],
  },
  {
    title: 'HSL — Purple',
    collapsed: true,
    sliders: [
      { label: 'Hue', path: ['color', 'hsl', 'purple', 'hue'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Saturation', path: ['color', 'hsl', 'purple', 'saturation'], min: -100, max: 100, step: 1, def: 0, rail: 'sat' },
      { label: 'Luminance', path: ['color', 'hsl', 'purple', 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
    ],
  },
  {
    title: 'HSL — Magenta',
    collapsed: true,
    sliders: [
      { label: 'Hue', path: ['color', 'hsl', 'magenta', 'hue'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Saturation', path: ['color', 'hsl', 'magenta', 'saturation'], min: -100, max: 100, step: 1, def: 0, rail: 'sat' },
      { label: 'Luminance', path: ['color', 'hsl', 'magenta', 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
    ],
  },
]

/** Does a folded group hold a non-default value? Drives the dot marker so
 *  edits can't hide inside a collapsed section. */
const groupTouched = (recipe: any, g: { sliders: SliderDef[] }) =>
  g.sliders.some((s) => {
    const v = getAt(recipe, s.path)
    return v != null && v !== s.def
  })

const getAt = (obj: any, path: string[]) => path.reduce((o, k) => o?.[k], obj)
const patchFor = (path: string[], value: number | null): object =>
  path.reduceRight<any>((v, k) => ({ [k]: v }), value)

/** CSS-filter approximation of the DIFFERENCE between the current recipe and
 * the last server-rendered one — instant feedback while dragging, replaced by
 * the accurate render when it arrives. Covers exposure/contrast/sat/vibrance. */
function liveDeltaFilter(cur: any, base: any): string {
  const parts: string[] = []
  const dev = (cur?.tone?.exposure ?? 0) - (base?.tone?.exposure ?? 0)
  if (Math.abs(dev) > 1e-3) parts.push(`brightness(${Math.pow(2, dev).toFixed(3)})`)
  const dc = (cur?.tone?.contrast ?? 0) - (base?.tone?.contrast ?? 0)
  if (Math.abs(dc) > 0.5) parts.push(`contrast(${(1 + (dc / 100) * 0.5).toFixed(3)})`)
  const sat = (r: any) => 1 + (r?.color?.saturation ?? 0) / 100 + (r?.color?.vibrance ?? 0) / 200
  const ds = sat(cur) / sat(base)
  if (Math.abs(ds - 1) > 1e-3) parts.push(`saturate(${Math.max(0, ds).toFixed(3)})`)
  return parts.join(' ')
}

export function EditPanel({
  onProof,
  imageId,
  previewSrc,
  isRaw,
  hasEdits,
  version = 0,
  renderTick = 0,
  onRecipeChange,
  onLiveFilter,
}: {
  imageId: string
  previewSrc: string
  isRaw: boolean
  hasEdits: boolean
  /** bump to force a recipe refetch (e.g. after undo/redo) */
  version?: number
  /** bumped by the parent each time a fresh preview render finishes loading */
  renderTick?: number
  onRecipeChange: () => void
  /** instant CSS-filter feedback while dragging (cleared when render lands) */
  onLiveFilter?: (filter: string) => void
  onProof: (space: string | null) => void
}) {
  const [folded, setFolded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(GROUPS.filter((g) => g.collapsed).map((g) => [g.title, true])),
  )
  const [versionTick, setVersionTick] = useState(0)
  const [recipe, setRecipeState] = useState<Record<string, any> | null>(null)
  const recipeRef = useRef<Record<string, any> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaved = useRef<Record<string, any> | null>(null)
  // recipe of the render currently on screen — the CSS live filter is always
  // the delta between the slider state and THIS, so approximation and pixels
  // never fight each other
  const displayed = useRef<Record<string, any> | null>(null)

  const setRecipe = (r: Record<string, any>) => {
    recipeRef.current = r
    setRecipeState(r)
  }

  useEffect(() => {
    api.getRecipe(imageId).then((r) => {
      setRecipe(r)
      lastSaved.current = r
      displayed.current = r
      onLiveFilter?.('')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId, version, versionTick])

  // a fresh server render finished loading: it reflects lastSaved, so the
  // approximation only needs to cover edits made since then (usually none)
  useEffect(() => {
    if (renderTick === 0) return
    displayed.current = lastSaved.current
    onLiveFilter?.(liveDeltaFilter(recipeRef.current, displayed.current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderTick])

  const record = (id: string, prev: Record<string, any>, next: Record<string, any>) =>
    pushAction({
      undo: () => api.putRecipe(id, prev),
      redo: () => api.putRecipe(id, next),
    })

  const commit = (patch: object) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      timer.current = null
      const prev = lastSaved.current
      const updated = await api.patchRecipe(imageId, patch)
      if (prev) record(imageId, prev, updated)
      lastSaved.current = updated
      // trigger a render only if no newer edit is already pending — while
      // dragging, intermediate states are covered by the CSS approximation
      if (!timer.current) onRecipeChange()
    }, 300)
  }

  const setValue = (def: SliderDef, value: number) => {
    const next = structuredClone(recipeRef.current ?? {})
    let o: any = next
    for (const k of def.path.slice(0, -1)) o = o[k] ?? (o[k] = {})
    o[def.path[def.path.length - 1]] = value
    setRecipe(next)
    onLiveFilter?.(liveDeltaFilter(next, displayed.current))
    commit(patchFor(def.path, value))
  }

  const reset = async () => {
    const prev = lastSaved.current
    const updated = await api.resetRecipe(imageId)
    if (prev) record(imageId, prev, updated)
    lastSaved.current = updated
    setRecipe(updated)
    onRecipeChange()
  }

  const auto = async () => {
    const prev = lastSaved.current
    const updated = await api.autoAdjust(imageId)
    if (prev) record(imageId, prev, updated)
    lastSaved.current = updated
    setRecipe(updated)
    onRecipeChange()
  }

  if (!recipe) return <div className="w-72 shrink-0 bg-base-200 p-4">…</div>

  const asShot = recipe.whiteBalance?.temp == null

  return (
    <aside className="w-72 shrink-0 bg-base-200 overflow-y-auto">
      <div className="px-4 pt-3">
        <Histogram src={previewSrc} />
        <div className="flex gap-1.5 mt-2">
          <span className={`badge badge-sm gap-1 ${isRaw ? 'badge-warning badge-outline' : 'badge-ghost'}`}>
            <FileImage size={10} /> {isRaw ? 'RAW' : 'JPEG'}
          </span>
          {hasEdits && (
            <span className="badge badge-sm badge-info badge-outline gap-1">
              <Pencil size={10} /> Edited
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between px-4 pt-3">
        <h2 className="font-bold text-sm">Develop</h2>
        <div className="flex gap-1">
          <button className="btn btn-xs btn-ghost" title="Computational auto-adjust" onClick={auto}>
            <Wand2 size={12} /> Auto
          </button>
          <button className="btn btn-xs btn-ghost" title="Reset all edits" onClick={reset}>
            <RotateCcw size={12} /> Reset
          </button>
        </div>
      </div>
      {GROUPS.map((g) => (
        <div key={g.title} className="px-4 py-2 border-b border-base-300/30 last:border-0">
          <button
            className="w-full flex items-center gap-1 text-xs font-bold opacity-60 uppercase tracking-wide mb-1 hover:opacity-100"
            onClick={() => setFolded((f) => ({ ...f, [g.title]: !f[g.title] }))}
          >
            <ChevronRight
              size={11}
              className={`transition-transform ${folded[g.title] ? '' : 'rotate-90'}`}
            />
            {g.title}
            {folded[g.title] && groupTouched(recipe, g) && (
              <span className="badge badge-xs badge-primary ml-auto">•</span>
            )}
          </button>
          {!folded[g.title] && g.sliders.map((s) => {
            const isTemp = s.label === 'Temp'
            const raw = getAt(recipe, s.path)
            const value = raw ?? s.def
            const disabled = isTemp && asShot
            return (
              <div key={s.label} className="mb-1.5">
                <div className="flex justify-between text-xs">
                  <button
                    className="hover:underline"
                    title="Double-click to reset"
                    onDoubleClick={() => setValue(s, s.def)}
                  >
                    {s.label}
                  </button>
                  <span className="font-mono opacity-70">
                    {disabled ? 'as shot' : s.step < 1 ? value.toFixed(2) : Math.round(value)}
                  </span>
                </div>
                <input
                  type="range"
                  className={`vr-slider ${s.rail ? `vr-slider-${s.rail}` : ''}`}
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={value}
                  disabled={disabled}
                  onChange={(e) => setValue(s, Number(e.target.value))}
                  onDoubleClick={() => setValue(s, s.def)}
                />
                {isTemp && (
                  <label className="label cursor-pointer justify-start gap-2 py-0">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-xs"
                      checked={asShot}
                      onChange={(e) => {
                        if (e.target.checked) {
                          const next = structuredClone(recipeRef.current ?? {})
                          next.whiteBalance = { ...next.whiteBalance, temp: null }
                          setRecipe(next)
                          commit({ whiteBalance: { temp: null } })
                        } else {
                          setValue(s, s.def)
                        }
                      }}
                    />
                    <span className="text-xs opacity-60">As shot</span>
                  </label>
                )}
              </div>
            )
          })}
        </div>
      ))}

      <DevelopExtras
        imageId={imageId}
        recipe={recipe}
        onChanged={() => {
          onRecipeChange()
          setVersionTick((v) => v + 1)
        }}
        onProof={onProof}
      />
      <p className="px-4 pb-3 text-[10px] opacity-40">
        Edits are non-destructive — stored in the .vibe.json sidecar, shared with agents.
      </p>
    </aside>
  )
}
