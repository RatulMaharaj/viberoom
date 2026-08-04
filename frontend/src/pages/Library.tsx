import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Boxes, ArrowDown, ArrowUp, CheckSquare, Download, FolderOpen, RefreshCw, Square } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { getSource, type Filters, type Flag, type ImageMeta } from '../source'
import { useSource, useSourceMode } from '../stores/source'
import { Brand } from '../components/Brand'
import { ImageCard } from '../components/ImageCard'
import { useFolderChooser } from '../folderChooser'
import { ExportDialog } from '../components/ExportDialog'
import { OrganizePanel } from '../components/OrganizePanel'
import { FolderPicker } from '../components/FolderPicker'
import { LibraryPicker } from '../components/LibraryPicker'
import { ModuleTabs } from '../components/ModuleTabs'
import { useThumbnails } from '../local/useThumbnails'
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
  const setSelected = useCallback((id: string | null) => {
    setSelectedState(id)
    saveLastImage(id)
  }, [])
  const [error, setError] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [exts, setExts] = useState<string[]>([])
  const navigate = useNavigate()
  const [multi, setMulti] = useState<string[]>([])
  const [idFilter, setIdFilter] = useState<string[] | null>(null)
  const [organize, setOrganize] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const { available: nativePicker, choose } = useFolderChooser()

  // sets, not arrays: the grid tests membership once per card per render
  const idFilterSet = useMemo(() => (idFilter ? new Set(idFilter) : null), [idFilter])
  const multiSet = useMemo(() => new Set(multi), [multi])
  const shown = useMemo(
    () => (idFilterSet ? images.filter((im) => idFilterSet.has(im.id)) : images),
    [images, idFilterSet],
  )

  const source = useSource()
  const mode = useSourceMode()
  // Local thumbnails are decoded blobs with a lifetime; server ones are URLs.
  // Only the local build pays for the hook. Safe to collapse to a boolean:
  // while the mode is unknown there is no source to decode from either.
  const local = mode === 'local'

  const refresh = useCallback(() => {
    getSource()
      .then((s) => s.listImages(filters))
      .then((r) => setImages(r.images))
      .catch(() => setImages([]))
  }, [filters])

  useEffect(() => {
    if (!source) return
    source.getLibrary().then((r) => {
      setLibraryPath(r.library)
      if (r.library) {
        refresh()
        source.listExts().then(setExts)
      }
    })
  }, [source, refresh])

  // Live refresh when agents edit sidecars on disk. Server-only: the event
  // stream is an endpoint, and locally nothing else is writing the folder.
  useEffect(
    () => (mode === 'server' ? onSidecarChange(() => refresh()) : undefined),
    [mode, refresh],
  )

  // Locally, EXIF lands after the grid has already painted — see the backfill
  // in local/index.ts. Re-listing is how it reaches the cards.
  useEffect(() => source?.subscribe?.(refresh), [source, refresh])

  /** Open a library and show it. `mode` is 'restore' only in the no-server
   *  build, where the folder is already chosen and permission has just been
   *  re-granted — prompting for it again would be nonsense. */
  const openLibrary = async (path?: string, mode: 'open' | 'restore' = 'open') => {
    setError(null)
    setShowPicker(false)
    const s = await getSource()
    try {
      const r = mode === 'restore' ? await s.getLibrary() : await s.openLibrary(path)
      setLibraryPath(r.library)
      s.listExts().then(setExts)
      refresh()
    } catch (e) {
      // The browser's picker throws AbortError when the user closes it, which
      // is a decision, not an error worth showing.
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(String(e))
    }
  }

  const patchLocal = (id: string, patch: Partial<ImageMeta>) =>
    setImages((imgs) => imgs.map((im) => (im.id === id ? { ...im, ...patch } : im)))

  // the card handlers and the keydown listener must stay identity-stable, so
  // they read the live images/selection through refs instead of closing over them
  const imagesRef = useRef(images)
  imagesRef.current = images
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const setRating = useCallback((id: string, rating: number) => {
    const prev = imagesRef.current.find((im) => im.id === id)?.rating ?? 0
    const write = (r: number) => getSource().then((s) => s.setRating(id, r))
    pushAction({ undo: () => write(prev), redo: () => write(rating) })
    patchLocal(id, { rating })
    write(rating)
  }, [])
  const setFlag = useCallback((id: string, flag: Flag) => {
    const prev = imagesRef.current.find((im) => im.id === id)?.flag ?? null
    const write = (f: Flag) => getSource().then((s) => s.setFlag(id, f))
    pushAction({ undo: () => write(prev), redo: () => write(flag) })
    patchLocal(id, { flag })
    write(flag)
  }, [])

  // Empty in server mode, where ImageCard keeps its plain thumbnail URL.
  const thumbs = useThumbnails(source, shown, local)

  const openImage = useCallback((id: string) => navigate(`/edit/${id}`), [navigate])
  const onCardClick = useCallback(
    (id: string, e: MouseEvent) => {
      setSelected(id)
      // cmd/ctrl or shift extends the multi-selection used by the
      // Organize panel (stacks, merge, collections)
      const extend = e.metaKey || e.ctrlKey || e.shiftKey
      setMulti((m) =>
        extend ? (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]) : [id],
      )
    },
    [setSelected],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const images = imagesRef.current
      const selected = selectedRef.current
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
  }, [navigate, refresh, setFlag, setRating, setSelected])

  if (!libraryPath) {
    return (
      <div className="hero min-h-screen">
        <div className="hero-content flex-col">
          <h1 className="font-brand text-4xl font-bold tracking-tight">Viberoom</h1>
          <p className="opacity-70">Point at a local folder of photos to get started.</p>
          {/* No server means no path to type: the browser will only open a
              folder the user points at, from inside a real click. */}
          {local ? (
            <LibraryPicker
              onOpen={() => openLibrary()}
              onReconnect={() => openLibrary(undefined, 'restore')}
            />
          ) : (
          <>
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
          </>
          )}
          {error && <div className="alert alert-error text-sm">{error}</div>}
          {/* Server-mode only. It browses the *server's* disk over the API, so
              with no backend it has nothing to list — and asking anyway is how
              a static host's "here's the app shell" reply for /api/v1/fs ends
              up parsed as JSON. The browser's own picker is what local mode
              uses, and it is the same native dialog. */}
          {showPicker && !local && (
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
        <button
          className="btn btn-sm"
          onClick={() => getSource().then((s) => s.scan()).then(refresh)}
        >
          <RefreshCw size={14} /> Rescan
        </button>
        <button
          className="btn btn-sm"
          title={multi.length ? 'Clear selection' : 'Select all shown'}
          onClick={() => {
            setMulti(multi.length ? [] : shown.map((im) => im.id))
          }}
        >
          {multi.length ? <Square size={14} /> : <CheckSquare size={14} />}
          {multi.length ? `${multi.length} selected` : 'Select all'}
        </button>
        {/* Organize needs the server's catalog and says so rather than failing
            on click. Export no longer does: the browser renders and writes the
            files itself, and the options it cannot do are disabled inside the
            dialog. */}
        <button
          className="btn btn-sm btn-primary"
          title={
            local
              ? 'Export the selection — rendered here, written to a folder you pick'
              : 'Export the selection (or the current image)'
          }
          disabled={!multi.length && !selected}
          onClick={() => setExportOpen(true)}
        >
          <Download size={14} /> Export…
        </button>
        <button
          className={`btn btn-sm ${organize ? 'btn-primary' : ''}`}
          title={
            local
              ? 'Collections, stacks and the rest need the desktop app'
              : 'Collections, stacks, merge, import, faces, map, tether'
          }
          disabled={local}
          onClick={() => setOrganize((v) => !v)}
        >
          <Boxes size={14} /> Organize
        </button>
        <div className="divider divider-horizontal mx-0" />
        <ModuleTabs active="catalog" imageId={selected ?? undefined} />
      </div>

      <div className="flex">
      <div className="flex-1 p-4 grid gap-4 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] content-start">
        {shown.map((im) => (
          <ImageCard
            key={im.id}
            image={im}
            selected={selected === im.id}
            multi={multiSet.has(im.id)}
            thumbSrc={thumbs[im.id]}
            local={local}
            onClick={onCardClick}
            onOpen={openImage}
            onRate={setRating}
            onFlag={setFlag}
          />
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
