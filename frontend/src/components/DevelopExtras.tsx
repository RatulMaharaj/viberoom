import { useCallback, useEffect, useState } from 'react'
import {
  Camera,
  Check,
  Copy,
  History,
  Layers,
  Sparkles,
  Tags,
  Trash2,
  Upload,
} from 'lucide-react'
import { api, type HistoryEntry, type Iptc } from '../api'

/** The Develop-side tools that aren't sliders: edit history, snapshots,
 *  virtual copies, masks, LUTs, metadata, ML enhance and soft proofing.
 *  Everything here was previously reachable only via the API. */

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-base-300/30 last:border-0">
      <button
        className="w-full flex items-center gap-1.5 px-4 py-2 text-xs font-bold opacity-60 uppercase tracking-wide hover:opacity-100"
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        {title}
      </button>
      {open && <div className="px-4 pb-3 text-xs space-y-2">{children}</div>}
    </div>
  )
}

const MASK_TYPES: { label: string; make: () => Record<string, any> }[] = [
  // `type` is the discriminator; for AI masks it doubles as the subject.
  { label: 'Subject (AI)', make: () => ({ type: 'subject' }) },
  { label: 'Sky (AI)', make: () => ({ type: 'sky' }) },
  { label: 'Background (AI)', make: () => ({ type: 'background' }) },
  // Gradients need geometry, in normalized 0-1 image coordinates.
  { label: 'Linear gradient', make: () => ({ type: 'linear', start: [0.5, 0.2], end: [0.5, 0.8] }) },
  {
    label: 'Radial gradient',
    make: () => ({ type: 'radial', center: [0.5, 0.5], radiusX: 0.35, radiusY: 0.35, feather: 50 }),
  },
  { label: 'Luminance range', make: () => ({ type: 'luminance', lumMin: 0, lumMax: 50, feather: 25 }) },
  { label: 'Colour range', make: () => ({ type: 'color', hue: 30, range: 30 }) },
]

const LOCAL_ADJ = [
  ['exposure', -5, 5, 0.05],
  ['contrast', -100, 100, 1],
  ['highlights', -100, 100, 1],
  ['shadows', -100, 100, 1],
  ['temp', -100, 100, 1],
  ['tint', -100, 100, 1],
  ['saturation', -100, 100, 1],
  ['clarity', -100, 100, 1],
  ['dehaze', -100, 100, 1],
  ['sharpness', -100, 100, 1],
] as const

export function DevelopExtras({
  imageId,
  recipe,
  onChanged,
  onProof,
}: {
  imageId: string
  recipe: Record<string, any> | null
  onChanged: () => void
  onProof: (space: string | null) => void
}) {
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [luts, setLuts] = useState<string[]>([])
  const [presets, setPresets] = useState<string[]>([])
  const [iptc, setIptc] = useState<Iptc>({})
  const [keywords, setKeywords] = useState('')
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  const masks: any[] = recipe?.masks ?? []
  const snapshots: Record<string, any> = recipe?.__snapshots ?? {}

  const refresh = useCallback(() => {
    api.getHistory(imageId).then((r) => setHistory(r.history ?? [])).catch(() => setHistory([]))
    api.getIptc(imageId).then(setIptc).catch(() => setIptc({}))
    api.getImage(imageId).then((im: any) => setKeywords((im.keywords ?? []).join(', '))).catch(() => {})
  }, [imageId])

  useEffect(refresh, [refresh])
  useEffect(() => {
    api.listLuts().then((r) => setLuts(r.luts ?? [])).catch(() => setLuts([]))
    api.listPresets().then((r) => setPresets(r.presets ?? [])).catch(() => setPresets([]))
  }, [])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setNote('')
    try {
      await fn()
      onChanged()
      refresh()
    } catch (e) {
      setNote(String(e))
    } finally {
      setBusy('')
    }
  }

  const patchMasks = (next: any[]) => run('masks', () => api.patchRecipe(imageId, { masks: next }))

  return (
    <div className="text-xs">
      {note && <p className="px-4 py-1 text-error break-all">{note}</p>}

      <Section title="History & snapshots" icon={<History size={12} />}>
        <div className="space-y-1">
          {history.length === 0 && <p className="opacity-50">No history yet.</p>}
          {history.map((h, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="flex-1 truncate opacity-70">{h.label ?? `step ${i}`}</span>
              <button
                className="btn btn-xs btn-ghost"
                onClick={() => run('history', () => api.restoreHistory(imageId, i))}
              >
                Restore
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-1">
          <input id="snap" className="input input-xs input-bordered flex-1" placeholder="Snapshot name" />
          <button
            className="btn btn-xs"
            onClick={() => {
              const el = document.getElementById('snap') as HTMLInputElement
              if (el?.value) run('snap', () => api.saveSnapshot(imageId, el.value))
            }}
          >
            Save
          </button>
        </div>
        {Object.keys(snapshots).map((name) => (
          <div key={name} className="flex items-center gap-2">
            <span className="flex-1 truncate font-mono">{name}</span>
            <button
              className="btn btn-xs btn-ghost"
              onClick={() => run('snap', () => api.restoreSnapshot(imageId, name))}
            >
              Restore
            </button>
            <button
              className="btn btn-xs btn-ghost text-error"
              onClick={() => run('snap', () => api.deleteSnapshot(imageId, name))}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </Section>

      <Section title="Virtual copies" icon={<Copy size={12} />}>
        <div className="flex gap-1">
          <input id="variant" className="input input-xs input-bordered flex-1" placeholder="Variant name" />
          <button
            className="btn btn-xs"
            onClick={() => {
              const el = document.getElementById('variant') as HTMLInputElement
              if (el?.value) run('variant', () => api.saveVariant(imageId, el.value))
            }}
          >
            Create
          </button>
        </div>
        <p className="opacity-50">
          A variant stores this recipe under a name; promote makes it the master.
        </p>
      </Section>

      <Section title={`Masks (${masks.length})`} icon={<Layers size={12} />}>
        <div className="flex flex-wrap gap-1">
          {MASK_TYPES.map((m) => (
            <button
              key={m.label}
              className="btn btn-xs"
              disabled={!!busy}
              onClick={() =>
                patchMasks([
                  ...masks,
                  { name: m.label, opacity: 100, invert: false, adjustments: {}, ...m.make() },
                ])
              }
            >
              + {m.label}
            </button>
          ))}
        </div>
        {masks.map((m, i) => (
          <div key={i} className="border border-base-300/50 rounded p-2 space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex-1 font-mono truncate">{m.name ?? m.type}</span>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs"
                  checked={!!m.invert}
                  onChange={(e) => {
                    const next = structuredClone(masks)
                    next[i].invert = e.target.checked
                    patchMasks(next)
                  }}
                />
                invert
              </label>
              <button
                className="btn btn-xs btn-ghost text-error"
                onClick={() => patchMasks(masks.filter((_, j) => j !== i))}
              >
                <Trash2 size={11} />
              </button>
            </div>
            {LOCAL_ADJ.map(([key, min, max, step]) => (
              <div key={key} className="flex items-center gap-2">
                <span className="w-20 opacity-60">{key}</span>
                <input
                  type="range"
                  className="vr-slider flex-1"
                  min={min}
                  max={max}
                  step={step}
                  value={m.adjustments?.[key] ?? 0}
                  onChange={(e) => {
                    const next = structuredClone(masks)
                    next[i].adjustments = { ...(next[i].adjustments ?? {}), [key]: Number(e.target.value) }
                    patchMasks(next)
                  }}
                />
                <span className="w-8 text-right font-mono opacity-70">
                  {m.adjustments?.[key] ?? 0}
                </span>
              </div>
            ))}
          </div>
        ))}
      </Section>

      <Section title="LUT & presets" icon={<Sparkles size={12} />}>
        <label className="flex items-center gap-2">
          <span className="w-16 opacity-60">LUT</span>
          <select
            className="select select-xs select-bordered flex-1"
            value={recipe?.color?.lut?.name ?? ''}
            onChange={(e) =>
              run('lut', () =>
                api.patchRecipe(imageId, {
                  color: { lut: e.target.value ? { name: e.target.value, strength: 100 } : null },
                }),
              )
            }
          >
            <option value="">None</option>
            {luts.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {recipe?.color?.lut?.name && (
          <div className="flex items-center gap-2">
            <span className="w-16 opacity-60">Strength</span>
            <input
              type="range"
              className="vr-slider flex-1"
              min={0}
              max={100}
              value={recipe.color.lut.strength ?? 100}
              onChange={(e) =>
                run('lut', () =>
                  api.patchRecipe(imageId, { color: { lut: { strength: Number(e.target.value) } } }),
                )
              }
            />
          </div>
        )}
        <label className="flex items-center gap-2">
          <span className="w-16 opacity-60">Preset</span>
          <select
            className="select select-xs select-bordered flex-1"
            defaultValue=""
            onChange={(e) =>
              e.target.value && run('preset', () => api.applyPreset(e.target.value, [imageId]))
            }
          >
            <option value="">Apply…</option>
            {presets.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-1">
          <input id="preset-name" className="input input-xs input-bordered flex-1" placeholder="Save as preset" />
          <button
            className="btn btn-xs"
            onClick={() => {
              const el = document.getElementById('preset-name') as HTMLInputElement
              if (el?.value && recipe)
                run('preset', () =>
                  api.savePreset(el.value, recipe).then(() =>
                    api.listPresets().then((r) => setPresets(r.presets ?? [])),
                  ),
                )
            }}
          >
            Save
          </button>
        </div>
      </Section>

      <Section title="Metadata" icon={<Tags size={12} />}>
        {(['title', 'caption', 'creator', 'copyright'] as const).map((f) => (
          <label key={f} className="flex items-center gap-2">
            <span className="w-16 opacity-60 capitalize">{f}</span>
            <input
              className="input input-xs input-bordered flex-1"
              value={iptc[f] ?? ''}
              onChange={(e) => setIptc((p) => ({ ...p, [f]: e.target.value }))}
              onBlur={() => run('iptc', () => api.setIptc(imageId, iptc))}
            />
          </label>
        ))}
        <label className="flex items-center gap-2">
          <span className="w-16 opacity-60">Keywords</span>
          <input
            className="input input-xs input-bordered flex-1"
            value={keywords}
            placeholder="comma, separated"
            onChange={(e) => setKeywords(e.target.value)}
            onBlur={() =>
              run('kw', () =>
                api.setKeywords(
                  imageId,
                  keywords.split(',').map((k) => k.trim()).filter(Boolean),
                ),
              )
            }
          />
        </label>
        <button className="btn btn-xs w-full" onClick={() => run('xmp', () => api.writeXmp(imageId))}>
          <Upload size={11} /> Write .xmp sidecar
        </button>
      </Section>

      <Section title="Enhance & proof" icon={<Camera size={12} />}>
        <button
          className="btn btn-xs w-full"
          disabled={busy === 'enhance'}
          onClick={() => run('enhance', () => api.enhance(imageId))}
        >
          {busy === 'enhance' ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <>
              <Sparkles size={11} /> ML enhance
            </>
          )}
        </button>
        <label className="flex items-center gap-2">
          <span className="w-16 opacity-60">Soft proof</span>
          <select
            className="select select-xs select-bordered flex-1"
            defaultValue=""
            onChange={(e) => onProof(e.target.value || null)}
          >
            <option value="">Off</option>
            <option value="srgb">sRGB</option>
            <option value="display-p3">Display P3</option>
            <option value="adobe-rgb">Adobe RGB</option>
            <option value="prophoto">ProPhoto</option>
          </select>
        </label>
        <p className="opacity-50">Proofing shows out-of-gamut areas for the chosen space.</p>
      </Section>

      {busy && (
        <p className="px-4 py-1 opacity-60 flex items-center gap-1">
          <Check size={11} /> {busy}…
        </p>
      )}
    </div>
  )
}
