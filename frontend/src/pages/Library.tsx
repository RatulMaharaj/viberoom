import { useCallback, useEffect, useState } from 'react'
import { Boxes, ArrowDown, ArrowUp, CheckSquare, Download, FolderOpen, RefreshCw, Square } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api, type Filters, type Flag, type ImageMeta } from '../api'
import { FlagBadge, RatingStars } from '../components/RatingStars'
import { Brand } from '../components/Brand'
import { useFolderChooser } from '../folderChooser'
import { ExportDialog } from '../components/ExportDialog'
import { OrganizePanel } from '../components/OrganizePanel'
import { FolderPicker } from '../components/FolderPicker'
import { ModuleTabs } from '../components/ModuleTabs'
import { exifLine } from '../exif'
import { loadFilters, saveFilters } from '../filters'
import { onSidecarChange } from '../events'
import { loadLastImage, saveLastImage } from '../selection'
import { handleUndoKey, pushAction } from '../undo'

export function Library() {
  const [libraryPath, setLibraryPath] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [images, setImages] = useState<ImageMeta[]>([])
  const [filters, setFiltersState] = useState<Filters>(loadFilters)
  const setFilters = (update: (f: Filters) => Filters) =>
    setFiltersState((f) => {
      const next = update(f)
      saveFilters(next)
      return next
    })
  const [selected, setSelectedState] = useState<string | null>(loadLastImage)
  const setSelected = (id: string | null) => {
    setSelectedState(id)
    saveLastImage(id)
  }
  const [error, setError] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [exts, setExts] = useState<string[]>([])
  const navigate = useNavigate()
  const [multi, setMulti] = useState<string[]>([])
  const [idFilter, setIdFilter] = useState<string[] | null>(null)
  const [organize, setOrganize] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const { available: nativePicker, choose } = useFolderChooser()

  const refresh = useCallback(() => {
    api
      .listImages(filters)
      .then((r) => setImages(r.images))
      .catch(() => setImages([]))
  }, [filters])

  useEffect(() => {
    api.getLibrary().then((r) => {
      setLibraryPath(r.library)
      if (r.library) {
        refresh()
        api.listExts().then((x) => setExts(x.exts))
      }
    })
  }, [refresh])

  // live refresh when agents edit sidecars on disk
  useEffect(() => onSidecarChange(() => refresh()), [refresh])

  const openLibrary = async (path: string) => {
    setError(null)
    setShowPicker(false)
    try {
      const r = await api.setLibrary(path)
      setLibraryPath(r.library)
      refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  const patchLocal = (id: string, patch: Partial<ImageMeta>) =>
    setImages((imgs) => imgs.map((im) => (im.id === id ? { ...im, ...patch } : im)))

  const setRating = (id: string, rating: number) => {
    const prev = images.find((im) => im.id === id)?.rating ?? 0
    pushAction({
      undo: () => api.setRating(id, prev),
      redo: () => api.setRating(id, rating),
    })
    patchLocal(id, { rating })
    api.setRating(id, rating)
  }
  const setFlag = (id: string, flag: Flag) => {
    const prev = images.find((im) => im.id === id)?.flag ?? null
    pushAction({
      undo: () => api.setFlag(id, prev),
      redo: () => api.setFlag(id, flag),
    })
    patchLocal(id, { flag })
    api.setFlag(id, flag)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.metaKey || e.ctrlKey) {
        handleUndoKey(e).then((consumed) => consumed && refresh())
        return
      }
      // arrow keys move the selection like Lightroom's grid
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        const idx = selected ? images.findIndex((im) => im.id === selected) : -1
        const next = images[idx + (e.key === 'ArrowRight' ? 1 : -1)] ?? images[idx < 0 ? 0 : idx]
        if (next) setSelected(next.id)
        return
      }
      if (!selected) return
      if (e.key >= '0' && e.key <= '5') setRating(selected, Number(e.key))
      else if (e.key.toLowerCase() === 'p') setFlag(selected, 'pick')
      else if (e.key.toLowerCase() === 'x') setFlag(selected, 'reject')
      else if (e.key.toLowerCase() === 'u') setFlag(selected, null)
      else if (e.key === 'Enter' || e.key.toLowerCase() === 'e') navigate(`/edit/${selected}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, images, refresh])

  if (!libraryPath) {
    return (
      <div className="hero min-h-screen">
        <div className="hero-content flex-col">
          <h1 className="font-brand text-4xl font-bold tracking-tight">Viberoom</h1>
          <p className="opacity-70">Point at a local folder of photos to get started.</p>
          <div className="join w-full max-w-xl">
            <input
              className="input input-bordered join-item flex-1 font-mono"
              placeholder="/path/to/photos"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && openLibrary(pathInput)}
            />
            <button className="btn btn-primary join-item" onClick={() => openLibrary(pathInput)}>
              Open
            </button>
          </div>
          <div className="flex gap-2">
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                if (!nativePicker) return setShowPicker(true)
                const picked = await choose(null)
                if (picked) openLibrary(picked)
              }}
            >
              <FolderOpen size={14} fill="#e8b339" stroke="#e8b339" /> Browse folders…
            </button>
            {nativePicker && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowPicker(true)}>
                Use the in-app tree
              </button>
            )}
          </div>
          {error && <div className="alert alert-error text-sm">{error}</div>}
          {showPicker && (
            <FolderPicker
              onSelect={openLibrary}
              onClose={() => setShowPicker(false)}
              current={libraryPath}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      <div className="navbar bg-base-200 sticky top-0 z-10 gap-2 px-4">
        <Brand />
        <div className="flex-1" />
        <select
          className="select select-sm select-bordered"
          value={filters.rating_gte ?? 0}
          onChange={(e) =>
            setFilters((f) => ({ ...f, rating_gte: Number(e.target.value) || undefined }))
          }
        >
          <option value={0}>All ratings</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              ≥ {'★'.repeat(n)}
            </option>
          ))}
        </select>
        <select
          className="select select-sm select-bordered"
          value={filters.flag ?? ''}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              flag: (e.target.value || undefined) as Filters['flag'],
            }))
          }
        >
          <option value="">All flags</option>
          <option value="pick">Picks</option>
          <option value="reject">Rejects</option>
          <option value="none">Unflagged</option>
        </select>
        <select
          className="select select-sm select-bordered"
          value={filters.ext ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, ext: e.target.value || undefined }))}
        >
          <option value="">All types</option>
          {exts.map((x) => (
            <option key={x} value={x}>
              {x.slice(1).toUpperCase()}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <select
            className="select select-sm select-bordered w-28"
            value={filters.sort}
            onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as Filters['sort'] }))}
          >
            <option value="filename">Name</option>
            <option value="mtime">Date</option>
            <option value="rating">Rating</option>
          </select>
          <button
            className="btn btn-sm btn-square"
            title={filters.order === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
            onClick={() =>
              setFilters((f) => ({ ...f, order: f.order === 'asc' ? 'desc' : 'asc' }))
            }
          >
            {filters.order === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
          </button>
        </div>
        <button className="btn btn-sm" onClick={() => api.scan().then(refresh)}>
          <RefreshCw size={14} /> Rescan
        </button>
        <button
          className="btn btn-sm"
          title={multi.length ? 'Clear selection' : 'Select all shown'}
          onClick={() => {
            const shown = images.filter((im) => !idFilter || idFilter.includes(im.id))
            setMulti(multi.length ? [] : shown.map((im) => im.id))
          }}
        >
          {multi.length ? <Square size={14} /> : <CheckSquare size={14} />}
          {multi.length ? `${multi.length} selected` : 'Select all'}
        </button>
        <button
          className="btn btn-sm btn-primary"
          title="Export the selection (or the current image)"
          disabled={!multi.length && !selected}
          onClick={() => setExportOpen(true)}
        >
          <Download size={14} /> Export…
        </button>
        <button
          className={`btn btn-sm ${organize ? 'btn-primary' : ''}`}
          title="Collections, stacks, merge, import, faces, map, tether"
          onClick={() => setOrganize((v) => !v)}
        >
          <Boxes size={14} /> Organize
        </button>
        <div className="divider divider-horizontal mx-0" />
        <ModuleTabs active="catalog" imageId={selected ?? undefined} />
      </div>

      <div className="flex">
      <div className="flex-1 p-4 grid gap-4 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] content-start">
        {images.filter((im) => !idFilter || idFilter.includes(im.id)).map((im) => (
          <div
            key={im.id}
            className={`card bg-base-200 shadow cursor-pointer transition overflow-hidden ${
              selected === im.id ? 'outline-2 outline-primary' : multi.includes(im.id) ? 'outline-2 outline-secondary' : ''
            }`}
            onClick={(e) => {
              setSelected(im.id)
              // cmd/ctrl or shift extends the multi-selection used by the
              // Organize panel (stacks, merge, collections)
              setMulti((m) =>
                e.metaKey || e.ctrlKey || e.shiftKey
                  ? m.includes(im.id)
                    ? m.filter((x) => x !== im.id)
                    : [...m, im.id]
                  : [im.id],
              )
            }}
            onDoubleClick={() => navigate(`/edit/${im.id}`)}
          >
            <figure className="aspect-[3/2] bg-base-300 relative group">
              <img
                src={api.thumbnailUrl(im.id)}
                alt={im.filename}
                loading="lazy"
                className="object-cover w-full h-full"
              />
              {exifLine(im.exif) && (
                <div className="absolute inset-x-0 bottom-0 bg-black/70 text-[10px] font-mono text-white/90 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {exifLine(im.exif)}
                </div>
              )}
            </figure>
            <div className="card-body p-3 gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs truncate">{im.filename}</span>
                <div className="flex gap-1 shrink-0">
                  {im.is_raw && <span className="badge badge-xs badge-neutral">RAW</span>}
                  {im.has_edits && <span className="badge badge-xs badge-info">edited</span>}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <RatingStars rating={im.rating} onChange={(r) => setRating(im.id, r)} size="xs" />
                <FlagBadge flag={im.flag} onChange={(f) => setFlag(im.id, f)} />
              </div>
            </div>
          </div>
        ))}
        {images.length === 0 && (
          <p className="opacity-60 col-span-full text-center py-16">No images match.</p>
        )}
      </div>
      {exportOpen && (
        <ExportDialog
          imageIds={multi.length ? multi : selected ? [selected] : []}
          onClose={() => setExportOpen(false)}
        />
      )}
      {organize && (
        <OrganizePanel
          selection={multi}
          onRefresh={refresh}
          onPickCollection={setIdFilter}
        />
      )}
      </div>
      <div className="fixed bottom-2 right-4 text-xs font-mono text-base-content/60 bg-base-200/80 backdrop-blur rounded-full px-3 py-1.5 shadow">
        ←→ select · ⌘-click multi · 0-5 rate · P pick · X reject · U unflag · E/Enter loupe
      </div>
    </div>
  )
}
