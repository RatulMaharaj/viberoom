import { useEffect, useRef, useState } from 'react'
import { FileImage, Pencil, RotateCcw, Wand2 } from 'lucide-react'
import { api } from '../api'
import { pushAction } from '../undo'
import { Histogram } from './Histogram'

interface SliderDef {
  label: string
  path: string[] // location in the recipe, e.g. ['tone', 'exposure']
  min: number
  max: number
  step: number
  def: number
}

const GROUPS: { title: string; sliders: SliderDef[] }[] = [
  {
    title: 'White Balance',
    sliders: [
      { label: 'Temp', path: ['whiteBalance', 'temp'], min: 2000, max: 20000, step: 50, def: 5500 },
      { label: 'Tint', path: ['whiteBalance', 'tint'], min: -150, max: 150, step: 1, def: 0 },
    ],
  },
  {
    title: 'Tone',
    sliders: [
      { label: 'Exposure', path: ['tone', 'exposure'], min: -5, max: 5, step: 0.05, def: 0 },
      { label: 'Contrast', path: ['tone', 'contrast'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Highlights', path: ['tone', 'highlights'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Shadows', path: ['tone', 'shadows'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Whites', path: ['tone', 'whites'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Blacks', path: ['tone', 'blacks'], min: -100, max: 100, step: 1, def: 0 },
    ],
  },
  {
    title: 'Presence',
    sliders: [
      { label: 'Vibrance', path: ['color', 'vibrance'], min: -100, max: 100, step: 1, def: 0 },
      { label: 'Saturation', path: ['color', 'saturation'], min: -100, max: 100, step: 1, def: 0 },
    ],
  },
  {
    title: 'Detail',
    sliders: [
      { label: 'Sharpening', path: ['detail', 'sharpening', 'amount'], min: 0, max: 150, step: 1, def: 0 },
      { label: 'NR Luminance', path: ['detail', 'noiseReduction', 'luminance'], min: 0, max: 100, step: 1, def: 0 },
      { label: 'NR Color', path: ['detail', 'noiseReduction', 'color'], min: 0, max: 100, step: 1, def: 0 },
    ],
  },
]

const getAt = (obj: any, path: string[]) => path.reduce((o, k) => o?.[k], obj)
const patchFor = (path: string[], value: number | null): object =>
  path.reduceRight<any>((v, k) => ({ [k]: v }), value)

export function EditPanel({
  imageId,
  previewSrc,
  isRaw,
  hasEdits,
  version = 0,
  onRecipeChange,
}: {
  imageId: string
  previewSrc: string
  isRaw: boolean
  hasEdits: boolean
  /** bump to force a recipe refetch (e.g. after undo/redo) */
  version?: number
  onRecipeChange: () => void
}) {
  const [recipe, setRecipe] = useState<Record<string, any> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaved = useRef<Record<string, any> | null>(null)

  useEffect(() => {
    api.getRecipe(imageId).then((r) => {
      setRecipe(r)
      lastSaved.current = r
    })
  }, [imageId, version])

  const record = (id: string, prev: Record<string, any>, next: Record<string, any>) =>
    pushAction({
      undo: () => api.putRecipe(id, prev),
      redo: () => api.putRecipe(id, next),
    })

  const commit = (patch: object) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const prev = lastSaved.current
      const updated = await api.patchRecipe(imageId, patch)
      if (prev) record(imageId, prev, updated)
      lastSaved.current = updated
      setRecipe(updated)
      onRecipeChange()
    }, 250)
  }

  const setValue = (def: SliderDef, value: number) => {
    setRecipe((r) => {
      const next = structuredClone(r ?? {})
      let o: any = next
      for (const k of def.path.slice(0, -1)) o = o[k] ?? (o[k] = {})
      o[def.path[def.path.length - 1]] = value
      return next
    })
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
          <h3 className="text-xs font-bold opacity-60 uppercase tracking-wide mb-1">{g.title}</h3>
          {g.sliders.map((s) => {
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
                  className="range range-xs range-primary w-full"
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
                          setRecipe((r) => {
                            const next = structuredClone(r ?? {})
                            next.whiteBalance = { ...next.whiteBalance, temp: null }
                            return next
                          })
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
      <p className="px-4 pb-3 text-[10px] opacity-40">
        Edits are non-destructive — stored in the .vibe.json sidecar, shared with agents.
      </p>
    </aside>
  )
}
