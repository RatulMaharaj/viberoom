import { useEffect, useState } from 'react'
import { Download, FolderOpen, Save, Trash2 } from 'lucide-react'
import { api } from '../api'
import { useFolderChooser } from '../folderChooser'
import type { ExportProgress, ExportReport, ExportSettings } from '../source'
import { useSource, useSourceMode } from '../stores/source'
import { FolderPicker } from './FolderPicker'

/** Full export panel: format, quality, bit depth, resize, colour space,
 *  output sharpening, watermark, variant and filename template — plus export
 *  presets. One form, two back ends: with a server it drives
 *  /images/{id}/export and /batch/export, and with none it drives the
 *  browser's own exporter (full-res GPU render, encode, File System Access).
 *
 *  The browser cannot do all of it. 16-bit PNG, TIFF, ICC profiles and
 *  wide-gamut spaces, watermarks, output sharpening, variants and export
 *  presets are server-side, and in local mode each control is disabled with
 *  the reason on it — the same treatment Crop and Auto already get. Disabled
 *  and explained beats enabled and quietly ignored, because the thing at the
 *  end of this dialog is a file someone keeps.
 */

export type { ExportSettings } from '../source'

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

/** Why a control is off in local mode. Spelled out per control so the tooltip
 *  says what is missing, not just that something is. */
const NO_SERVER = {
  tiff: 'TIFF has no browser encoder — needs the desktop app',
  depth: '16-bit PNG has no browser encoder — needs the desktop app',
  space: 'Colour profiles are embedded by the desktop app; the browser writes sRGB',
  sharpen: 'Output sharpening runs on the server — needs the desktop app',
  watermark: 'Watermarks are composited on the server — needs the desktop app',
  variant: 'Variants live in the server catalog — needs the desktop app',
  preset: 'Export presets are stored by the desktop app',
}

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
  /** one id exports directly; several go through the batch path */
  imageIds: string[]
  onClose: () => void
}) {
  const [s, setS] = useState<ExportSettings>(DEFAULTS)
  const source = useSource()
  const mode = useSourceMode()
  const [presets, setPresets] = useState<Record<string, any>>({})
  const [presetName, setPresetName] = useState('')
  const [busy, setBusy] = useState(false)
  const [pickingDir, setPickingDir] = useState(false)
  const { available: nativePicker, choose } = useFolderChooser()
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [report, setReport] = useState<ExportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [localDest, setLocalDest] = useState<string | null>(null)

  const many = imageIds.length > 1
  const local = mode === 'local'
  const set = <K extends keyof ExportSettings>(k: K, v: ExportSettings[K]) =>
    setS((p) => ({ ...p, [k]: v }))

  useEffect(() => {
    if (!source) return
    setLocalDest(source.exportDestinationName?.() ?? null)
    // Presets are a server-side store; asking a static host for them just
    // produces a confusing error in the console.
    if (source.kind === 'server') {
      api.listExportPresets().then((r) => setPresets(r.presets ?? {})).catch(() => setPresets({}))
    }
  }, [source])

  // Only PNG supports 16-bit, on either back end; don't let the form build a
  // request the exporter will reject.
  useEffect(() => {
    if (s.format !== 'png' && s.bit_depth === 16) set('bit_depth', 8)
  }, [s.format, s.bit_depth])

  // TIFF has no browser encoder, so a local session that somehow lands on it
  // (an old preset, a stale state) comes back to JPEG rather than failing.
  useEffect(() => {
    if (local && (s.format === 'tiff' || s.bit_depth === 16)) {
      setS((p) => ({ ...p, format: p.format === 'tiff' ? 'jpeg' : p.format, bit_depth: 8 }))
    }
  }, [local, s.format, s.bit_depth])

  const doExport = async () => {
    if (!source) return
    setBusy(true)
    setError(null)
    setReport(null)
    setProgress(null)
    try {
      const r = await source.exportImages(imageIds, s, setProgress)
      setReport(r)
      setLocalDest(source.exportDestinationName?.() ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const chooseDir = async () => {
    if (local) {
      // Must run straight off this click: the browser only opens a directory
      // picker inside a user gesture.
      const picked = await source?.chooseExportDestination?.()
      if (picked) setLocalDest(picked)
      return
    }
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
    // Nulls are stripped rather than stored: a preset is merged *under* the
    // request's explicit fields, and a stored null would read as "no resize"
    // rather than "no opinion".
    const settings = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null))
    await api.putExportPreset(presetName, settings)
    setPresets(await api.listExportPresets().then((r) => r.presets ?? {}))
    setPresetName('')
  }

  const failures = report?.results.filter((r) => !r.ok) ?? []
  const notes = report?.results.filter((r) => r.ok && r.note) ?? []

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-xl">
        <h3 className="font-bold flex items-center gap-2">
          <Download size={16} />
          Export {many ? `${imageIds.length} images` : 'image'}
        </h3>

        {local && (
          <p className="text-xs opacity-60 mt-1">
            Rendered here in the browser: JPEG and 8-bit PNG, sRGB, resized and named
            below. Everything greyed out needs the desktop app.
          </p>
        )}

        <div className="mt-3 space-y-2 text-xs">
          <Row label="Preset">
            <select
              className="select select-xs select-bordered flex-1"
              defaultValue=""
              disabled={local}
              title={local ? NO_SERVER.preset : undefined}
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
                  disabled={local && f === 'tiff'}
                  title={local && f === 'tiff' ? NO_SERVER.tiff : undefined}
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
                    disabled={local && d === 16}
                    title={local && d === 16 ? NO_SERVER.depth : undefined}
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
              disabled={local}
              title={local ? NO_SERVER.space : undefined}
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
              disabled={local}
              title={local ? NO_SERVER.sharpen : undefined}
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
              disabled={local}
              title={local ? NO_SERVER.variant : undefined}
              onChange={(e) => set('variant', e.target.value || null)}
            />
          </Row>

          <Row label="Watermark">
            <input
              type="checkbox"
              className="checkbox checkbox-xs"
              checked={!!s.watermark}
              disabled={local}
              title={local ? NO_SERVER.watermark : undefined}
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
              <span className="truncate">
                {local ? localDest ?? 'choose a folder…' : s.dest_dir ?? '<library>/exports'}
              </span>
            </button>
            {!local && nativePicker && (
              <button
                className="btn btn-xs btn-ghost"
                title="Browse with the in-app tree instead"
                onClick={() => setPickingDir(true)}
              >
                Tree
              </button>
            )}
            {!local && s.dest_dir && (
              <button className="btn btn-xs btn-ghost" onClick={() => set('dest_dir', null)}>
                Reset
              </button>
            )}
          </Row>
          {local && (
            <p className="opacity-50 ml-28">
              Asked for once per session; exporting without choosing one prompts.
            </p>
          )}

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
              disabled={local}
              title={local ? NO_SERVER.preset : undefined}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <button
              className="btn btn-xs"
              disabled={!presetName || local}
              title={local ? NO_SERVER.preset : undefined}
              onClick={savePreset}
            >
              <Save size={11} />
            </button>
          </div>
        </div>

        {progress && (
          <div className="mt-3 text-xs">
            <div className="flex justify-between">
              <span className="truncate">
                {progress.stage === 'write' ? 'Writing' : 'Rendering'} {progress.filename}
              </span>
              <span className="font-mono opacity-60">
                {progress.index}/{progress.total}
              </span>
            </div>
            <progress
              className="progress progress-primary w-full"
              value={progress.index - (progress.stage === 'done' ? 0 : 1)}
              max={progress.total}
            />
          </div>
        )}

        {error && <div className="alert alert-error text-xs p-2 mt-2 break-all">{error}</div>}

        {report && (
          <div className="mt-2 space-y-1 text-xs">
            <div className={`alert p-2 break-all ${failures.length ? 'alert-warning' : 'alert-success'}`}>
              {/* A single export names the file it wrote — that is what the
                  server dialog always showed, and it is the useful answer. */}
              {report.written === 1 && report.results.length === 1 && report.results[0].path
                ? `Exported ${report.results[0].path}`
                : `Exported ${report.written} of ${report.results.length}` +
                  (report.destination ? ` to ${report.destination}` : '') +
                  (failures.length ? ` — ${failures.length} refused` : '')}
            </div>
            {/* Refusals are named one by one. "3 refused" tells a photographer
                nothing; which three and why is the whole point. */}
            {failures.map((f) => (
              <div key={f.id} className="break-all opacity-80">
                <span className="font-mono">{f.filename}</span>: {f.error}
              </div>
            ))}
            {notes.map((n) => (
              <div key={n.id} className="break-all opacity-60">
                <span className="font-mono">{n.filename}</span>: {n.note}
              </div>
            ))}
          </div>
        )}

        <div className="modal-action">
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={doExport}
            disabled={busy || !source || imageIds.length === 0}
          >
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
