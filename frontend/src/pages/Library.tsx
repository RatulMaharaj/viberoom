import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, FolderOpen, RefreshCw } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api, type Filters, type Flag, type ImageMeta } from '../api'
import { FlagBadge, RatingStars } from '../components/RatingStars'
import { FolderPicker } from '../components/FolderPicker'
import { ModuleTabs } from '../components/ModuleTabs'
import { loadFilters, saveFilters } from '../filters'

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
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [exts, setExts] = useState<string[]>([])
  const navigate = useNavigate()

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
    patchLocal(id, { rating })
    api.setRating(id, rating)
  }
  const setFlag = (id: string, flag: Flag) => {
    patchLocal(id, { flag })
    api.setFlag(id, flag)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
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
  }, [selected, images])

  if (!libraryPath) {
    return (
      <div className="hero min-h-screen">
        <div className="hero-content flex-col">
          <h1 className="text-4xl font-bold">viberoom</h1>
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
          <button className="btn btn-ghost btn-sm" onClick={() => setShowPicker(true)}>
            <FolderOpen size={14} /> Browse folders…
          </button>
          {error && <div className="alert alert-error text-sm">{error}</div>}
          {showPicker && (
            <FolderPicker onSelect={openLibrary} onClose={() => setShowPicker(false)} />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      <div className="navbar bg-base-200 sticky top-0 z-10 gap-2 px-4">
        <span className="font-bold text-lg">viberoom</span>
        <button
          className="btn btn-sm btn-ghost gap-1.5 font-normal"
          title={`${libraryPath} — click to change folder`}
          onClick={() => setShowPicker(true)}
        >
          <FolderOpen size={14} className="opacity-60" />
          <span className="max-w-40 truncate">
            {libraryPath.split('/').filter(Boolean).pop()}
          </span>
        </button>
        {showPicker && (
          <FolderPicker onSelect={openLibrary} onClose={() => setShowPicker(false)} />
        )}
        <ModuleTabs active="organize" imageId={selected ?? undefined} />
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
        <div className="join">
          <select
            className="select select-sm select-bordered join-item"
            value={filters.sort}
            onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as Filters['sort'] }))}
          >
            <option value="filename">Name</option>
            <option value="mtime">Date</option>
            <option value="rating">Rating</option>
          </select>
          <button
            className="btn btn-sm join-item"
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
      </div>

      <div className="p-4 grid gap-4 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
        {images.map((im) => (
          <div
            key={im.id}
            className={`card bg-base-200 shadow cursor-pointer transition overflow-hidden ${
              selected === im.id ? 'outline-2 outline-primary' : ''
            }`}
            onClick={() => setSelected(im.id)}
            onDoubleClick={() => navigate(`/edit/${im.id}`)}
          >
            <figure className="aspect-[3/2] bg-base-300">
              <img
                src={api.thumbnailUrl(im.id)}
                alt={im.filename}
                loading="lazy"
                className="object-cover w-full h-full"
              />
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
      <div className="fixed bottom-2 right-4 text-xs opacity-40 font-mono">
        ←→ select · 0-5 rate · P pick · X reject · U unflag · E/Enter loupe
      </div>
    </div>
  )
}
