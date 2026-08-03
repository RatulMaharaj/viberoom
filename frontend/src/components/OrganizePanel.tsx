import { useCallback, useEffect, useState } from 'react'
import {
  Copy,
  FolderPlus,
  Images,
  Layers,
  MapPin,
  Plug,
  ScanFace,
  Trash2,
  Users,
} from 'lucide-react'
import { api, type MapPoint } from '../api'

/** Library-side organisation tools: collections, stacks, duplicates, import,
 *  HDR/pano merge, faces, GPS map, tethered capture and catalog roots.
 *  These map 1:1 onto endpoints that previously had no interface at all. */

function Section({
  title,
  icon,
  children,
  defaultOpen = false,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-base-300/30 last:border-0">
      <button
        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-bold opacity-60 uppercase tracking-wide hover:opacity-100"
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        {title}
      </button>
      {open && <div className="px-3 pb-3 text-xs space-y-2">{children}</div>}
    </div>
  )
}

export function OrganizePanel({
  selection,
  onRefresh,
  onPickCollection,
}: {
  /** ids currently multi-selected in the grid */
  selection: string[]
  onRefresh: () => void
  onPickCollection: (ids: string[] | null) => void
}) {
  const [collections, setCollections] = useState<Record<string, string[]>>({})
  const [dupes, setDupes] = useState<string[][]>([])
  const [points, setPoints] = useState<MapPoint[]>([])
  const [roots, setRoots] = useState<string[]>([])
  const [tether, setTether] = useState<Record<string, any> | null>(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  const refresh = useCallback(() => {
    api.listCollections().then((r) => setCollections(r.collections ?? {})).catch(() => {})
    api.listRoots().then((r) => setRoots(r.roots ?? [])).catch(() => {})
  }, [])
  useEffect(refresh, [refresh])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setNote('')
    try {
      const out: any = await fn()
      if (out?.path) setNote(`Wrote ${out.path}`)
      else if (typeof out?.count === 'number') setNote(`${out.count} affected`)
      onRefresh()
      refresh()
    } catch (e) {
      setNote(String(e))
    } finally {
      setBusy('')
    }
  }

  const need = (n: number) => selection.length >= n

  return (
    <div className="w-72 shrink-0 border-l border-base-300/40 bg-base-100 overflow-y-auto">
      <div className="px-3 py-2 border-b border-base-300/40 flex items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wide">Organize</span>
        <span className="ml-auto opacity-50 text-xs">{selection.length} selected</span>
      </div>
      {note && <p className="px-3 py-1 text-xs text-warning break-all">{note}</p>}

      <Section title="Collections" icon={<Images size={12} />} defaultOpen>
        <div className="flex gap-1">
          <input id="coll" className="input input-xs input-bordered flex-1" placeholder="New collection" />
          <button
            className="btn btn-xs"
            onClick={() => {
              const el = document.getElementById('coll') as HTMLInputElement
              if (el?.value) run('collection', () => api.putCollection(el.value))
            }}
          >
            <FolderPlus size={11} />
          </button>
        </div>
        {Object.entries(collections).map(([name, ids]) => (
          <div key={name} className="flex items-center gap-1">
            <button
              className="flex-1 text-left truncate hover:underline"
              onClick={() => onPickCollection(ids)}
              title="Filter the grid to this collection"
            >
              {name} <span className="opacity-50">({ids.length})</span>
            </button>
            <button
              className="btn btn-xs btn-ghost"
              disabled={!need(1)}
              title="Add selected"
              onClick={() => run('collection', () => api.editCollection(name, { add: selection }))}
            >
              +
            </button>
            <button
              className="btn btn-xs btn-ghost"
              disabled={!need(1)}
              title="Remove selected"
              onClick={() => run('collection', () => api.editCollection(name, { remove: selection }))}
            >
              −
            </button>
            <button
              className="btn btn-xs btn-ghost text-error"
              onClick={() => run('collection', () => api.deleteCollection(name))}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
        {Object.keys(collections).length > 0 && (
          <button className="btn btn-xs btn-ghost w-full" onClick={() => onPickCollection(null)}>
            Clear collection filter
          </button>
        )}
      </Section>

      <Section title="Stacks" icon={<Layers size={12} />}>
        <button
          className="btn btn-xs w-full"
          disabled={!need(2)}
          onClick={() => run('stack', () => api.createStack(selection))}
        >
          Stack {selection.length} selected
        </button>
        <button className="btn btn-xs w-full" onClick={() => run('stack', () => api.autoStack())}>
          Auto-stack by time
        </button>
      </Section>

      <Section title="Duplicates" icon={<Copy size={12} />}>
        <button
          className="btn btn-xs w-full"
          onClick={() => run('dupes', () => api.duplicates().then((r) => setDupes(r.groups ?? [])))}
        >
          Find duplicates
        </button>
        {dupes.map((g, i) => (
          <button
            key={i}
            className="block w-full text-left truncate hover:underline opacity-70"
            onClick={() => onPickCollection(g)}
          >
            Group {i + 1} — {g.length} images
          </button>
        ))}
      </Section>

      <Section title="Merge" icon={<Images size={12} />}>
        <button
          className="btn btn-xs w-full"
          disabled={!need(2) || !!busy}
          onClick={() => run('hdr', () => api.mergeHdr(selection))}
        >
          Merge to HDR ({selection.length})
        </button>
        <button
          className="btn btn-xs w-full"
          disabled={!need(2) || !!busy}
          onClick={() => run('pano', () => api.mergePano(selection))}
        >
          Merge to panorama ({selection.length})
        </button>
      </Section>

      <Section title="Import" icon={<FolderPlus size={12} />}>
        <input id="imp-src" className="input input-xs input-bordered w-full" placeholder="/path/to/card" />
        <label className="flex items-center gap-1">
          <input id="imp-move" type="checkbox" className="checkbox checkbox-xs" /> move (not copy)
        </label>
        <label className="flex items-center gap-1">
          <input id="imp-dedupe" type="checkbox" className="checkbox checkbox-xs" defaultChecked /> skip duplicates
        </label>
        <button
          className="btn btn-xs w-full"
          onClick={() => {
            const src = (document.getElementById('imp-src') as HTMLInputElement)?.value
            if (!src) return
            run('import', () =>
              api.importPhotos({
                source: src,
                move: (document.getElementById('imp-move') as HTMLInputElement)?.checked,
                dedupe: (document.getElementById('imp-dedupe') as HTMLInputElement)?.checked,
              }),
            )
          }}
        >
          Import
        </button>
      </Section>

      <Section title="People" icon={<Users size={12} />}>
        <button className="btn btn-xs w-full" onClick={() => run('faces', () => api.facesSetup())}>
          <ScanFace size={11} /> Set up face detection
        </button>
        <button className="btn btn-xs w-full" onClick={() => run('faces', () => api.facesScan())}>
          Scan library for faces
        </button>
      </Section>

      <Section title="Map" icon={<MapPin size={12} />}>
        <button
          className="btn btn-xs w-full"
          onClick={() => run('map', () => api.mapPoints().then((r) => setPoints(r.points ?? [])))}
        >
          Load GPS points
        </button>
        {points.length > 0 && (
          <>
            <p className="opacity-60">{points.length} geotagged</p>
            <div className="relative h-32 bg-base-300 rounded overflow-hidden">
              {points.map((pt) => (
                <span
                  key={pt.id}
                  title={`${pt.filename ?? pt.id} — ${pt.lat.toFixed(3)}, ${pt.lon.toFixed(3)}`}
                  className="absolute w-1.5 h-1.5 rounded-full bg-primary"
                  style={{
                    left: `${((pt.lon + 180) / 360) * 100}%`,
                    top: `${((90 - pt.lat) / 180) * 100}%`,
                  }}
                />
              ))}
            </div>
            <p className="opacity-40">Equirectangular sketch — hover a dot for coordinates.</p>
          </>
        )}
      </Section>

      <Section title="Tether" icon={<Plug size={12} />}>
        <button
          className="btn btn-xs w-full"
          onClick={() => run('tether', () => api.tetherStatus().then(setTether))}
        >
          Check camera
        </button>
        {tether && <p className="font-mono opacity-60 break-all">{JSON.stringify(tether)}</p>}
        <button className="btn btn-xs w-full" onClick={() => run('tether', () => api.tetherCapture())}>
          Capture now
        </button>
      </Section>

      <Section title="Catalog roots" icon={<FolderPlus size={12} />}>
        {roots.map((r) => (
          <div key={r} className="flex items-center gap-1">
            <span className="flex-1 truncate font-mono opacity-70" title={r}>
              {r}
            </span>
            <button
              className="btn btn-xs btn-ghost text-error"
              onClick={() => run('roots', () => api.removeRoot(r))}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
        <div className="flex gap-1">
          <input id="root" className="input input-xs input-bordered flex-1" placeholder="/another/folder" />
          <button
            className="btn btn-xs"
            onClick={() => {
              const el = document.getElementById('root') as HTMLInputElement
              if (el?.value) run('roots', () => api.addRoot(el.value))
            }}
          >
            Add
          </button>
        </div>
      </Section>

      {busy && <p className="px-3 py-2 text-xs opacity-60">{busy}…</p>}
    </div>
  )
}
