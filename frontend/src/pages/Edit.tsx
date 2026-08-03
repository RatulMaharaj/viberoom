import { useCallback, useEffect, useRef, useState } from 'react'
import { Crop, Download, Maximize, Minimize } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type Flag, type ImageMeta } from '../api'
import { FlagBadge, RatingStars } from '../components/RatingStars'
import { Brand } from '../components/Brand'
import { CropTool } from '../components/CropTool'
import { ExportDialog } from '../components/ExportDialog'
import { EditPanel } from '../components/EditPanel'
import { Filmstrip } from '../components/Filmstrip'
import { GpuPreview } from '../components/GpuPreview'
import { ModuleTabs } from '../components/ModuleTabs'
import { ZoomableImage } from '../components/ZoomableImage'
import { createLiveRecipe } from '../gpu'
import { useGpuPreview } from '../hooks/useGpuPreview'
import { loadFilters } from '../filters'
import { onSidecarChange } from '../events'
import { loadLastImage, saveLastImage } from '../selection'
import { handleUndoKey, pushAction } from '../undo'

/** Long edge of the frame the client-side renderer works on. */
const GPU_PREVIEW_SIZE = 2048

export function Edit() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [image, setImage] = useState<ImageMeta | null>(null)
  const [siblings, setSiblings] = useState<ImageMeta[]>([])
  const [bust, setBust] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const [showBefore, setShowBefore] = useState(false)
  const [panelVersion, setPanelVersion] = useState(0)
  const [liveFilter, setLiveFilter] = useState('')
  const [renderTick, setRenderTick] = useState(0)
  const [cropMode, setCropMode] = useState(false)
  const [proof, setProof] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [commitTick, setCommitTick] = useState(0)

  /** Slider state on its way to the GPU. A plain mutable box, not state — see
   *  gpu/live.ts for why that matters at pointer-move rates. */
  const live = useRef(createLiveRecipe()).current

  const gpu = useGpuPreview({
    imageId: id,
    // Fixed, and deliberately not the zoomed size: a 4096 px source frame is
    // ~47 MB of texture, which is not a trade worth making for a preview.
    size: GPU_PREVIEW_SIZE,
    live,
    // Soft proof, before/after and the crop tool all show something the
    // stage-1 chain cannot reproduce, and zoomed-in means the photographer is
    // judging real pixels, so the server render is the only honest answer.
    enabled: !proof && !showBefore && !cropMode && !zoomed,
    commitTick,
  })

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
    setShowBefore(false)
  }, [load])

  // filmstrip honors the same filters as the Organize grid
  useEffect(() => {
    saveLastImage(id ?? null)
    api.listImages(loadFilters()).then((r) => {
      setSiblings(r.images)
      if (!id && r.images.length) {
        const last = loadLastImage()
        const target = last && r.images.some((im) => im.id === last) ? last : r.images[0].id
        navigate(`/edit/${target}`, { replace: true })
      }
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

  const openImage = useCallback((next: string) => navigate(`/edit/${next}`), [navigate])

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

  // live refresh when an agent (or anything) edits sidecars on disk
  useEffect(
    () =>
      onSidecarChange((ids) => {
        if (id && ids.includes(id)) refreshAll()
      }),
    [id, refreshAll],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        handleUndoKey(e).then((consumed) => consumed && refreshAll())
        return
      }
      if (cropMode) {
        if (e.key === 'Escape' || e.key.toLowerCase() === 'c') setCropMode(false)
        return
      }
      if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key.toLowerCase() === 'f') toggleFullscreen()
      else if (e.key === '\\' || e.key === '|') setShowBefore((v) => !v)
      else if (e.key.toLowerCase() === 'c') setCropMode(true)
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
  }, [go, id, image, load, navigate, toggleFullscreen, refreshAll, cropMode])

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

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {!fullscreen && (
        <div className="navbar bg-base-200 gap-2 px-4 min-h-12">
          <Brand showFolder={false} />
          <div className="flex-1" />
          {image && (
            <>
              <RatingStars rating={image.rating} onChange={setRating} size="sm" />
              <FlagBadge flag={image.flag} onChange={setFlag} />
            </>
          )}
          <button
            className={`btn btn-sm ${cropMode ? 'btn-primary' : 'btn-ghost'}`}
            title="Crop & straighten (C)"
            onClick={() => setCropMode((v) => !v)}
            disabled={!id}
          >
            <Crop size={14} />
          </button>
            <button className="btn btn-sm btn-ghost" title="Fullscreen (F)" onClick={toggleFullscreen}>
            <Maximize size={14} />
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => setExportOpen(true)}
            disabled={!id}
          >
            <Download size={14} /> Export…
          </button>
          <div className="divider divider-horizontal mx-0" />
          <ModuleTabs active="develop" imageId={id} />
        </div>
      )}


      <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-h-0 relative flex items-center justify-center bg-base-300">
        {id && (
          <ZoomableImage
            resetKey={id}
            src={
              proof
                ? api.proofUrl(id, proof, true, zoomed ? 4096 : 2048, bust)
                : (gpu.serverSrc ?? api.previewUrl(id, zoomed ? 4096 : 2048, bust, showBefore))
            }
            alt={image?.filename ?? ''}
            // The GPU frame is the real chain, not an approximation, so the
            // CSS delta must not be layered on top of it as well.
            filter={gpu.mode === 'gpu' ? '' : liveFilter}
            hideImage={gpu.mode === 'gpu'}
            overlay={(transform) => (
              <GpuPreview
                canvasRef={gpu.canvasRef}
                style={transform}
                visible={gpu.mode === 'gpu'}
              />
            )}
            onZoomChange={setZoomed}
            onLoaded={() => setRenderTick((t) => t + 1)}
          />
        )}
        {proof && (
          <span className="absolute top-3 right-3 badge badge-warning gap-1 font-mono">
            Soft proof — {proof}
          </span>
        )}
        {showBefore && (
          <span className="absolute top-3 left-3 badge badge-neutral gap-1 font-mono">
            Before — \ to toggle
          </span>
        )}
        {!id && <p className="opacity-60">No images match the current filters.</p>}
        {cropMode && id && (
          <CropTool
            imageId={id}
            onClose={() => setCropMode(false)}
            onApplied={refreshAll}
          />
        )}
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
          renderTick={renderTick}
          live={live}
          onCommitted={() => setCommitTick((t) => t + 1)}
          onLiveFilter={setLiveFilter}
          onProof={setProof}
          onRecipeChange={() => {
            setBust(String(Date.now()))
            load()
          }}
        />
      )}
      </div>

      {exportOpen && id && (
        <ExportDialog imageIds={[id]} onClose={() => setExportOpen(false)} />
      )}

      {!fullscreen && (
        <Filmstrip siblings={siblings} image={image} id={id} idx={idx} onPick={openImage} />
      )}
    </div>
  )
}
