import { useCallback, useEffect, useState } from 'react'
import { Download, Maximize, Minimize } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type Flag, type ImageMeta } from '../api'
import { FlagBadge, RatingStars } from '../components/RatingStars'
import { Brand } from '../components/Brand'
import { EditPanel } from '../components/EditPanel'
import { ModuleTabs } from '../components/ModuleTabs'
import { ZoomableImage } from '../components/ZoomableImage'
import { cameraLine, exifLine } from '../exif'
import { loadFilters } from '../filters'
import { handleUndoKey, pushAction } from '../undo'

export function Edit() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [image, setImage] = useState<ImageMeta | null>(null)
  const [siblings, setSiblings] = useState<ImageMeta[]>([])
  const [bust, setBust] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const [hovered, setHovered] = useState<ImageMeta | null>(null)
  const [showBefore, setShowBefore] = useState(false)
  const [panelVersion, setPanelVersion] = useState(0)

  const refreshAll = useCallback(() => {
    setBust(String(Date.now()))
    setPanelVersion((v) => v + 1)
    if (id) api.getImage(id).then(setImage)
  }, [id])

  const load = useCallback(() => {
    if (id) api.getImage(id).then(setImage)
  }, [id])

  useEffect(() => {
    load()
    setExportPath(null)
    setShowBefore(false)
  }, [load])

  // filmstrip honors the same filters as the Organize grid
  useEffect(() => {
    api.listImages(loadFilters()).then((r) => {
      setSiblings(r.images)
      if (!id && r.images.length) navigate(`/edit/${r.images[0].id}`, { replace: true })
    })
  }, [id, navigate])

  const idx = id ? siblings.findIndex((im) => im.id === id) : -1
  const go = useCallback(
    (delta: number) => {
      const next = siblings[idx + delta]
      if (next) navigate(`/edit/${next.id}`)
    },
    [idx, siblings, navigate],
  )

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      document.documentElement.requestFullscreen().catch(() => setFullscreen((v) => !v))
    }
  }, [])

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        handleUndoKey(e).then((consumed) => consumed && refreshAll())
        return
      }
      if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key.toLowerCase() === 'f') toggleFullscreen()
      else if (e.key === '\\' || e.key === '|') setShowBefore((v) => !v)
      else if (e.key === 'Escape' || e.key.toLowerCase() === 'g') {
        // browser handles exiting native fullscreen on Esc itself
        if (!document.fullscreenElement) navigate('/')
      } else if (id && e.key >= '0' && e.key <= '5') setRating(Number(e.key))
      else if (id && e.key.toLowerCase() === 'p') setFlag('pick')
      else if (id && e.key.toLowerCase() === 'x') setFlag('reject')
      else if (id && e.key.toLowerCase() === 'u') setFlag(null)
      else if (id && e.key.toLowerCase() === 'r') {
        setBust(String(Date.now()))
        load()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, id, image, load, navigate, toggleFullscreen, refreshAll])

  const setRating = (rating: number) => {
    if (!id || !image) return
    const prev = image.rating
    pushAction({
      undo: () => api.setRating(id, prev),
      redo: () => api.setRating(id, rating),
    })
    api.setRating(id, rating).then(load)
  }
  const setFlag = (flag: Flag) => {
    if (!id || !image) return
    const prev = image.flag
    pushAction({
      undo: () => api.setFlag(id, prev),
      redo: () => api.setFlag(id, flag),
    })
    api.setFlag(id, flag).then(load)
  }

  const doExport = async () => {
    if (!id) return
    setExporting(true)
    setExportPath(null)
    try {
      const r = await api.exportImage(id, { quality: 90 })
      setExportPath(r.path)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {!fullscreen && (
        <div className="navbar bg-base-200 gap-2 px-4 min-h-12">
          <Brand />
          <span className="font-mono text-sm truncate">{image?.filename}</span>
          <div className="flex-1" />
          {image && (
            <>
              <RatingStars rating={image.rating} onChange={setRating} size="sm" />
              <FlagBadge flag={image.flag} onChange={setFlag} />
            </>
          )}
          <button className="btn btn-sm btn-ghost" title="Fullscreen (F)" onClick={toggleFullscreen}>
            <Maximize size={14} />
          </button>
          <button className="btn btn-sm btn-primary" onClick={doExport} disabled={exporting || !id}>
            {exporting ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <>
                <Download size={14} /> Export JPEG
              </>
            )}
          </button>
          <div className="divider divider-horizontal mx-0" />
          <ModuleTabs active="develop" imageId={id} />
        </div>
      )}

      {exportPath && !fullscreen && (
        <div className="alert alert-success text-xs py-1 rounded-none gap-1.5">
          <Download size={14} />
          Exported <span className="font-mono" title={exportPath}>{exportPath.split('/').pop()}</span>
          <span className="opacity-60">in {exportPath.split('/').slice(-2, -1)[0]}/</span>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-h-0 relative flex items-center justify-center bg-base-300">
        {id && (
          <ZoomableImage
            resetKey={id}
            src={api.previewUrl(id, zoomed ? 4096 : 2048, bust, showBefore)}
            alt={image?.filename ?? ''}
            onZoomChange={setZoomed}
          />
        )}
        {showBefore && (
          <span className="absolute top-3 left-3 badge badge-neutral gap-1 font-mono">
            Before — \ to toggle
          </span>
        )}
        {!id && <p className="opacity-60">No images match the current filters.</p>}
        {fullscreen && image && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-base-100/80 rounded-full px-4 py-1.5 backdrop-blur">
            <span className="font-mono text-xs">{image.filename}</span>
            <RatingStars rating={image.rating} onChange={setRating} size="xs" />
            <FlagBadge flag={image.flag} onChange={setFlag} />
            <button className="btn btn-xs btn-ghost" title="Exit fullscreen (F)" onClick={toggleFullscreen}>
              <Minimize size={12} />
            </button>
          </div>
        )}
      </div>
      {!fullscreen && id && (
        <EditPanel
          imageId={id}
          previewSrc={api.previewUrl(id, 1024, bust)}
          isRaw={image?.is_raw ?? false}
          hasEdits={image?.has_edits ?? false}
          version={panelVersion}
          onRecipeChange={() => {
            setBust(String(Date.now()))
            load()
          }}
        />
      )}
      </div>

      {!fullscreen && (
        <>
          <div className="h-7 shrink-0 bg-base-100 border-t border-base-300/30 flex items-center gap-3 px-3 text-xs">
            {(() => {
              const info = hovered ?? image
              if (!info) return null
              return (
                <>
                  <span className="font-mono font-bold">{info.filename}</span>
                  <span className="opacity-70 font-mono">{exifLine(info.exif)}</span>
                  <span className="opacity-40 truncate">{cameraLine(info.exif)}</span>
                  <div className="flex-1" />
                  {info.rating > 0 && (
                    <span className="text-amber-400">{'★'.repeat(info.rating)}</span>
                  )}
                  {info.flag && (
                    <span className={info.flag === 'pick' ? 'text-success' : 'text-error'}>
                      {info.flag}
                    </span>
                  )}
                  <span className="opacity-50 font-mono">
                    {(hovered ? siblings.findIndex((s) => s.id === hovered.id) : idx) + 1} / {siblings.length}
                  </span>
                </>
              )
            })()}
          </div>
          <div className="h-24 shrink-0 bg-base-200 flex gap-1 items-center overflow-x-auto px-2">
            {siblings.map((im) => (
              <img
                key={im.id}
                src={api.thumbnailUrl(im.id)}
                alt={im.filename}
                loading="lazy"
                onClick={() => navigate(`/edit/${im.id}`)}
                onMouseEnter={() => setHovered(im)}
                onMouseLeave={() => setHovered(null)}
                className={`h-20 w-auto object-cover rounded cursor-pointer ${
                  im.id === id ? 'ring-2 ring-primary' : 'opacity-70 hover:opacity-100'
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
