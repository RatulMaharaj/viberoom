import { useEffect, useRef, useState } from 'react'
import { ChevronRight, FileImage, Pencil, RotateCcw, Wand2 } from 'lucide-react'
import { api } from '../api'
import { HSL_CHANNEL_ORDER, HSL_HUE_RANGE, HUE_CENTERS, publish, setAt, type LiveRecipe } from '../gpu'
import { pushAction } from '../undo'
import { DevelopExtras, useDebouncedCommit } from './DevelopExtras'
import { Histogram } from './Histogram'

interface SliderDef {
  label: string
  path: string[] // location in the recipe, e.g. ['tone', 'exposure']
  min: number
  max: number
  step: number
  def: number
  /** colored rail hinting at the axis: temp, tint, dark-to-light, saturation, hue */
  rail?: 'temp' | 'tint' | 'luma' | 'sat' | 'hue'
  /** For `rail: 'hue'`: the slice of the color wheel this slider covers. Absent
   *  means the whole wheel (an absolute 0-360 hue); a center+range means a
   *  relative shift around one band, as the HSL mixer sliders do. */
  hueSpan?: { center: number; range: number }
}

/** CSS gradient painting a hue rail with the hues it actually reaches. */
const hueRail = (span?: { center: number; range: number }): string => {
  const stops = span
    ? [0, 0.25, 0.5, 0.75, 1].map((t) => span.center + (t * 2 - 1) * span.range)
    : [0, 60, 120, 180, 240, 300, 360]
  return `linear-gradient(to right, ${stops.map((h) => `hsl(${h} 85% 55%)`).join(', ')})`
}

/** A band a swatch row can select. `hue` colors the swatch; `swatch` overrides
 *  it for bands that aren't a hue (the tonal grading bands). */
interface Channel {
  key: string
  label: string
  hue?: number
  swatch?: string
}

const swatchColor = (c: Channel) => c.swatch ?? `hsl(${c.hue ?? 0} 85% 55%)`

// Band centers come from gpu/constants, which is also what the shader is built
// from — one copy of a number that has to agree with engine/ops/color.py.
const HSL_CHANNELS: Channel[] = HSL_CHANNEL_ORDER.map((key) => ({
  key,
  label: key[0].toUpperCase() + key.slice(1),
  hue: HUE_CENTERS[key],
}))

const hslSliders = (c: Channel): SliderDef[] => [
  { label: 'Hue', path: ['color', 'hsl', c.key, 'hue'], min: -100, max: 100, step: 1, def: 0, rail: 'hue', hueSpan: { center: c.hue ?? 0, range: HSL_HUE_RANGE } },
  { label: 'Saturation', path: ['color', 'hsl', c.key, 'saturation'], min: -100, max: 100, step: 1, def: 0, rail: 'sat' },
  { label: 'Luminance', path: ['color', 'hsl', c.key, 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
]

/** Grading bands are tonal, not chromatic, so the swatches are a dark/mid/light
 *  ramp rather than colors. */
const GRADING_BANDS: Channel[] = [
  { key: 'shadows', label: 'Shadows', swatch: '#2b2b2b' },
  { key: 'midtones', label: 'Midtones', swatch: '#8a8a8a' },
  { key: 'highlights', label: 'Highlights', swatch: '#e8e8e8' },
]

const gradingSliders = (c: Channel): SliderDef[] => [
  { label: 'Hue', path: ['color', 'grading', c.key, 'hue'], min: 0, max: 360, step: 1, def: 0, rail: 'hue' },
  { label: 'Saturation', path: ['color', 'grading', c.key, 'saturation'], min: 0, max: 100, step: 1, def: 0, rail: 'sat' },
  { label: 'Luminance', path: ['color', 'grading', c.key, 'luminance'], min: -100, max: 100, step: 1, def: 0, rail: 'luma' },
]

interface Group {
  title: string
  collapsed?: boolean
  /** Shown as-is, or below the band sliders when `channels` is set. */
  sliders?: SliderDef[]
  /** When set, a swatch row picks which band `bandSliders` addresses, instead
   *  of giving every band its own collapsible section. */
  channels?: Channel[]
  bandSliders?: (c: Channel) => SliderDef[]
}

/** Groups marked collapsed start folded — there are far more controls than
 *  fit on screen, and most shots never touch the mixer or optics. */

const GROUPS: Group[] = [
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
    title: 'Color Grading',
    collapsed: true,
    channels: GRADING_BANDS,
    bandSliders: gradingSliders,
    // blending and balance act across all three bands, so they sit below the
    // band picker rather than being repeated inside each one
    sliders: [
      { label: 'Blending', path: ['color', 'grading', 'blending'], min: 0, max: 100, step: 1, def: 50 },
      { label: 'Balance', path: ['color', 'grading', 'balance'], min: -100, max: 100, step: 1, def: 0 },
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
    title: 'Color Mixer',
    collapsed: true,
    channels: HSL_CHANNELS,
    bandSliders: hslSliders,
  },
]

const bandSlidersOf = (g: Group, c: Channel): SliderDef[] => g.bandSliders?.(c) ?? []

/** The sliders currently on screen for a group — for a channel group that is
 *  the selected band's sliders, followed by any shared ones. */
const visibleSliders = (g: Group, channel: string): SliderDef[] => {
  const shared = g.sliders ?? []
  if (!g.channels) return shared
  const c = g.channels.find((x) => x.key === channel) ?? g.channels[0]
  return [...bandSlidersOf(g, c), ...shared]
}

/** Every slider a group owns, including bands not currently selected. */
const allSliders = (g: Group): SliderDef[] => [
  ...(g.channels?.flatMap((c) => bandSlidersOf(g, c)) ?? []),
  ...(g.sliders ?? []),
]

const touched = (recipe: any, sliders: SliderDef[]) =>
  sliders.some((s) => {
    const v = getAt(recipe, s.path)
    return v != null && v !== s.def
  })

/** Does a folded group hold a non-default value? Drives the dot marker so
 *  edits can't hide inside a collapsed section — or, for the mixer, inside an
 *  unselected band. */
const groupTouched = (recipe: any, g: Group) => touched(recipe, allSliders(g))

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
  live,
  onCommitted,
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
  /** Slider state, published synchronously for the GPU renderer to poll. This
   *  is not React state on purpose — see gpu/live.ts. */
  live?: LiveRecipe
  /** fires once an edit has actually been persisted */
  onCommitted?: () => void
  onProof: (space: string | null) => void
}) {
  const [folded, setFolded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(GROUPS.filter((g) => g.collapsed).map((g) => [g.title, true])),
  )
  /** selected band per channel-group, keyed by group title */
  const [channel, setChannel] = useState<Record<string, string>>({})
  const [versionTick, setVersionTick] = useState(0)
  const [recipe, setRecipeState] = useState<Record<string, any> | null>(null)
  const recipeRef = useRef<Record<string, any> | null>(null)
  const debounced = useDebouncedCommit()
  const lastSaved = useRef<Record<string, any> | null>(null)
  // recipe of the render currently on screen — the CSS live filter is always
  // the delta between the slider state and THIS, so approximation and pixels
  // never fight each other
  const displayed = useRef<Record<string, any> | null>(null)

  /** Publishes to the render loop *before* touching state, on purpose: the
   *  GPU sees the new value in this tick regardless of when React chooses to
   *  commit, so the preview never trails the slider by a frame. */
  const setRecipe = (r: Record<string, any>) => {
    recipeRef.current = r
    if (live) publish(live, r)
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

  // Persistence only. While dragging, the preview comes from the GPU (or the
  // CSS approximation where the GPU cannot help), so intermediate states never
  // need to reach the server.
  const commit = (patch: object) => {
    debounced(
      async () => {
        const prev = lastSaved.current
        const updated = await api.patchRecipe(imageId, patch)
        if (prev) record(imageId, prev, updated)
        lastSaved.current = updated
      },
      () => {
        onRecipeChange()
        onCommitted?.()
      },
    )
  }

  const setValue = (def: SliderDef, value: number) => {
    // Path copy rather than a structuredClone of the whole recipe: this runs
    // on every pointer-move tick, and all but one of a few hundred fields are
    // unchanged.
    const next = setAt(recipeRef.current ?? {}, def.path, value)
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
    onCommitted?.()
  }

  const auto = async () => {
    const prev = lastSaved.current
    const updated = await api.autoAdjust(imageId)
    if (prev) record(imageId, prev, updated)
    lastSaved.current = updated
    setRecipe(updated)
    onRecipeChange()
    onCommitted?.()
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
      {GROUPS.map((g) => {
        const active = channel[g.title] ?? g.channels?.[0].key ?? ''
        return (
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
          {!folded[g.title] && g.channels && (
            <div className="mb-2">
              {/* many bands stay square to fit the row; a few would look like
                  giant tiles, so they get a shorter bar instead */}
              <div
                className="grid gap-1"
                style={{ gridTemplateColumns: `repeat(${g.channels.length}, minmax(0, 1fr))` }}
              >
                {g.channels.map((c) => {
                  const isActive = c.key === active
                  const edited = touched(recipe, bandSlidersOf(g, c))
                  return (
                    <button
                      key={c.key}
                      type="button"
                      title={c.label}
                      aria-label={c.label}
                      aria-pressed={isActive}
                      className={`relative rounded-md border border-base-content/15 transition ${
                        g.channels!.length > 4 ? 'aspect-square' : 'h-7'
                      } ${
                        isActive
                          ? 'ring-2 ring-primary ring-offset-1 ring-offset-base-200'
                          : 'opacity-70 hover:opacity-100'
                      }`}
                      style={{ background: swatchColor(c) }}
                      onClick={() => setChannel((m) => ({ ...m, [g.title]: c.key }))}
                    >
                      {/* a band with edits stays visible even when unselected */}
                      {edited && (
                        <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-base-content ring-1 ring-base-200" />
                      )}
                    </button>
                  )
                })}
              </div>
              <div className="text-xs opacity-60 mt-1">
                {g.channels.find((c) => c.key === active)?.label}
              </div>
            </div>
          )}
          {!folded[g.title] && visibleSliders(g, active).map((s) => {
            const isTemp = s.label === 'Temp'
            const raw = getAt(recipe, s.path)
            const value = raw ?? s.def
            const disabled = isTemp && asShot
            return (
              <div key={s.path.join('.')} className="mb-1.5">
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
                  style={
                    s.rail === 'hue'
                      ? ({ '--vr-rail': hueRail(s.hueSpan) } as React.CSSProperties)
                      : undefined
                  }
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
                          setRecipe(setAt(recipeRef.current ?? {}, ['whiteBalance', 'temp'], null))
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
        )
      })}

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
