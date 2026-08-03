import { useEffect, useState } from 'react'
import { Download, FolderOpen, Save, Trash2 } from 'lucide-react'
import { api } from '../api'
import { useFolderChooser } from '../folderChooser'
import { FolderPicker } from './FolderPicker'

/** Full export panel: format, quality, bit depth, resize, colour space,
 *  output sharpening, watermark, variant and filename template — plus export
 *  presets. Drives /images/{id}/export for one image and /batch/export for
 *  several, so the same form serves both. */

export interface ExportSettings {
  format: 'jpeg' | 'png' | 'tiff'
  quality: number
  bit_depth: 8 | 16
  max_dimension: number | null
  color_space: 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto'
  output_sharpen: 'screen' | 'matte' | 'glossy' | null
  variant: string | null
  dest_dir: string | null
  filename: string | null
  watermark: {
    text: string | null
    image: string | null
    position: string
    opacity: number
    scale: number
  } | null
}

const DEFAULTS: ExportSettings = {
  format: 'jpeg',
  quality: 90,
  bit_depth: 8,
  max_dimension: null,
  color_space: 'srgb',
  output_sharpen: null,
  variant: null,
  dest_dir: null,
  filename: null,
  watermark: null,
}

const SPACES = [
  ['srgb', 'sRGB'],
  ['display-p3', 'Display P3'],
  ['adobe-rgb', 'Adobe RGB'],
  ['prophoto', 'ProPhoto'],
] as const

const POSITIONS = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
  'center',
  'bottom-center',
]

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-28 shrink-0 opacity-60">{label}</span>
      {children}
    </label>
  )
}

export function ExportDialog({
  imageIds,
  onClose,
}: {
  /** one id exports directly; several go through /batch/export */
  imageIds: string[]
  onClose: () => void
}) {
  const [s, setS] = useState<ExportSettings>(DEFAULTS)
  const [presets, setPresets] = useState<Record<string, any>>({})
  const [presetName, setPresetName] = useState('')
  const [busy, setBusy] = useState(false)
  const [pickingDir, setPickingDir] = useState(false)
  const { available: nativePicker, choose } = useFolderChooser()
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const many = imageIds.length > 1
  const set = <K extends keyof ExportSettings>(k: K, v: ExportSettings[K]) =>
    setS((p) => ({ ...p, [k]: v }))

  useEffect(() => {
    api
      .listExportPresets()
      .then((r) => setPresets(r.presets ?? {}))
      .catch(() => setPresets({}))
  }, [])

  // The API only supports 16-bit for PNG; don't let the form build a request
  // it will reject.
  useEffect(() => {
    if (s.format !== 'png' && s.bit_depth === 16) set('bit_depth', 8)
  }, [s.format, s.bit_depth])

  const body = () => {
    const b: Record<string, any> = {
      format: s.format,
      quality: s.quality,
      bit_depth: s.bit_depth,
      color_space: s.color_space,
    }
    if (s.max_dimension) b.max_dimension = s.max_dimension
    if (s.output_sharpen) b.output_sharpen = s.output_sharpen
    if (s.variant) b.variant = s.variant
    if (s.dest_dir) b.dest_dir = s.dest_dir
    if (s.watermark && (s.watermark.text || s.watermark.image)) b.watermark = s.watermark
    return b
  }

  const doExport = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      if (many) {
        const b: Record<string, any> = { ...body(), image_ids: imageIds }
        if (s.filename) b.filename = s.filename
        const r: any = await api.batchExport(b)
        setResult(
          r.count != null
            ? `Exported ${r.count} image${r.count === 1 ? '' : 's'}`
            : JSON.stringify(r).slice(0, 200),
        )
      } else {
        const r = await api.exportImage(imageIds[0], body())
        setResult(r.path)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const chooseDir = async () => {
    if (!nativePicker) {
      setPickingDir(true)
      return
    }
    const picked = await choose(s.dest_dir)
    if (picked) set('dest_dir', picked)
  }

  const applyPreset = (name: string) => {
    const p = presets[name]
    if (p) setS({ ...DEFAULTS, ...p })
  }

  const savePreset = async () => {
    if (!presetName) return
    await api.putExportPreset(presetName, body())
    setPresets(await api.listExportPresets().then((r) => r.presets ?? {}))
    setPresetName('')
  }

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-xl">
        <h3 className="font-bold flex items-center gap-2">
          <Download size={16} />
          Export {many ? `${imageIds.length} images` : 'image'}
        </h3>

        <div className="mt-3 space-y-2 text-xs">
          <Row label="Preset">
            <select
              className="select select-xs select-bordered flex-1"
              defaultValue=""
              onChange={(e) => e.target.value && applyPreset(e.target.value)}
            >
              <option value="">Custom…</option>
              {Object.keys(presets).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            {Object.keys(presets).length > 0 && (
              <button
                className="btn btn-xs btn-ghost text-error"
                title="Delete the selected preset"
                onClick={async (e) => {
                  const sel = (e.currentTarget.parentElement?.querySelector('select') as HTMLSelectElement)
                    ?.value
                  if (sel) {
                    await api.deleteExportPreset(sel)
                    setPresets(await api.listExportPresets().then((r) => r.presets ?? {}))
                  }
                }}
              >
                <Trash2 size={11} />
              </button>
            )}
          </Row>

          <Row label="Format">
            <div className="join">
              {(['jpeg', 'png', 'tiff'] as const).map((f) => (
                <button
                  key={f}
                  className={`btn btn-xs join-item ${s.format === f ? 'btn-primary' : ''}`}
                  onClick={() => set('format', f)}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </Row>

          {s.format === 'jpeg' && (
            <Row label="Quality">
              <input
                type="range"
                className="vr-slider flex-1"
                min={1}
                max={100}
                value={s.quality}
                onChange={(e) => set('quality', Number(e.target.value))}
              />
              <span className="w-8 text-right font-mono">{s.quality}</span>
            </Row>
          )}

          {s.format === 'png' && (
            <Row label="Bit depth">
              <div className="join">
                {([8, 16] as const).map((d) => (
                  <button
                    key={d}
                    className={`btn btn-xs join-item ${s.bit_depth === d ? 'btn-primary' : ''}`}
                    onClick={() => set('bit_depth', d)}
                  >
                    {d}-bit
                  </button>
                ))}
              </div>
            </Row>
          )}

          <Row label="Colour space">
            <select
              className="select select-xs select-bordered flex-1"
              value={s.color_space}
              onChange={(e) => set('color_space', e.target.value as ExportSettings['color_space'])}
            >
              {SPACES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Resize">
            <input
              type="number"
              className="input input-xs input-bordered flex-1"
              placeholder="full size"
              value={s.max_dimension ?? ''}
              onChange={(e) => set('max_dimension', e.target.value ? Number(e.target.value) : null)}
            />
            <span className="opacity-50">px long edge</span>
          </Row>

          <Row label="Sharpen for">
            <select
              className="select select-xs select-bordered flex-1"
              value={s.output_sharpen ?? ''}
              onChange={(e) =>
                set('output_sharpen', (e.target.value || null) as ExportSettings['output_sharpen'])
              }
            >
              <option value="">None</option>
              <option value="screen">Screen</option>
              <option value="matte">Matte paper</option>
              <option value="glossy">Glossy paper</option>
            </select>
          </Row>

          <Row label="Variant">
            <input
              className="input input-xs input-bordered flex-1"
              placeholder="master"
              value={s.variant ?? ''}
              onChange={(e) => set('variant', e.target.value || null)}
            />
          </Row>

          <Row label="Watermark">
            <input
              type="checkbox"
              className="checkbox checkbox-xs"
              checked={!!s.watermark}
              onChange={(e) =>
                set(
                  'watermark',
                  e.target.checked
                    ? { text: '', image: null, position: 'bottom-right', opacity: 60, scale: 20 }
                    : null,
                )
              }
            />
          </Row>

          {s.watermark && (
            <div className="ml-28 space-y-1.5 border-l border-base-300/50 pl-2">
              <Row label="Text">
                <input
                  className="input input-xs input-bordered flex-1"
                  value={s.watermark.text ?? ''}
                  onChange={(e) => set('watermark', { ...s.watermark!, text: e.target.value })}
                />
              </Row>
              <Row label="PNG overlay">
                <input
                  className="input input-xs input-bordered flex-1"
                  placeholder="/path/to/logo.png"
                  value={s.watermark.image ?? ''}
                  onChange={(e) =>
                    set('watermark', { ...s.watermark!, image: e.target.value || null })
                  }
                />
              </Row>
              <Row label="Position">
                <select
                  className="select select-xs select-bordered flex-1"
                  value={s.watermark.position}
                  onChange={(e) => set('watermark', { ...s.watermark!, position: e.target.value })}
                >
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Opacity">
                <input
                  type="range"
                  className="vr-slider flex-1"
                  min={0}
                  max={100}
                  value={s.watermark.opacity}
                  onChange={(e) =>
                    set('watermark', { ...s.watermark!, opacity: Number(e.target.value) })
                  }
                />
                <span className="w-8 text-right font-mono">{s.watermark.opacity}</span>
              </Row>
              <Row label="Scale">
                <input
                  type="range"
                  className="vr-slider flex-1"
                  min={1}
                  max={100}
                  value={s.watermark.scale}
                  onChange={(e) =>
                    set('watermark', { ...s.watermark!, scale: Number(e.target.value) })
                  }
                />
                <span className="w-8 text-right font-mono">{s.watermark.scale}</span>
              </Row>
            </div>
          )}

          <Row label="Output folder">
            <button className="btn btn-xs flex-1 justify-start font-mono" onClick={chooseDir}>
              <FolderOpen size={12} />
              <span className="truncate">{s.dest_dir ?? '<library>/exports'}</span>
            </button>
            {nativePicker && (
              <button
                className="btn btn-xs btn-ghost"
                title="Browse with the in-app tree instead"
                onClick={() => setPickingDir(true)}
              >
                Tree
              </button>
            )}
            {s.dest_dir && (
              <button className="btn btn-xs btn-ghost" onClick={() => set('dest_dir', null)}>
                Reset
              </button>
            )}
          </Row>

          {many && (
            <Row label="Filename">
              <input
                className="input input-xs input-bordered flex-1"
                placeholder="{name}{ext}"
                value={s.filename ?? ''}
                onChange={(e) => set('filename', e.target.value || null)}
              />
            </Row>
          )}
          {many && (
            <p className="opacity-50 ml-28">
              Tokens: {'{name} {seq} {rating} {date} {ext}'} — may contain “/” to nest
              folders. Include {'{ext}'}, or the files get no extension.
            </p>
          )}

          <div className="flex items-center gap-1 pt-1">
            <span className="w-28 shrink-0 opacity-60">Save as preset</span>
            <input
              className="input input-xs input-bordered flex-1"
              placeholder="preset name"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <button className="btn btn-xs" disabled={!presetName} onClick={savePreset}>
              <Save size={11} />
            </button>
          </div>
        </div>

        {error && <div className="alert alert-error text-xs p-2 mt-2 break-all">{error}</div>}
        {result && <div className="alert alert-success text-xs p-2 mt-2 break-all">{result}</div>}

        <div className="modal-action">
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-sm btn-primary" onClick={doExport} disabled={busy}>
            {busy ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <>
                <Download size={13} /> Export{many ? ` ${imageIds.length}` : ''}
              </>
            )}
          </button>
        </div>
      </div>
      {pickingDir && (
        <FolderPicker
          title="Export to"
          confirmLabel="Export here"
          current={s.dest_dir}
          onClose={() => setPickingDir(false)}
          onSelect={(p) => {
            set('dest_dir', p)
            setPickingDir(false)
          }}
        />
      )}
      <div className="modal-backdrop" onClick={onClose} />
    </dialog>
  )
}
