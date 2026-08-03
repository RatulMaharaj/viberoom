import { useCallback, useEffect, useRef, useState } from 'react'
import { Crop, Download, Maximize, Minimize } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { getSource, type Flag, type ImageMeta, type PhotoSource, type SourceUrl } from '../source'
import { useThumbnails } from '../local/useThumbnails'
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
  const [source, setSource] = useState<PhotoSource | null>(null)
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
  /** The rendered frame in the no-server build, where there is no `/preview`
   *  to point an <img> at and the blob has to be released by hand. */
  const [localFrame, setLocalFrame] = useState<SourceUrl | null>(null)

  const local = source?.kind === 'local'

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
    // Locally there is no server render to swap in and no `/source` endpoint
    // to feed the renderer, so this hook stays off entirely; `local/preview.ts`
    // drives the same GPU chain from the file itself instead.
    enabled: !local && !proof && !showBefore && !cropMode && !zoomed,
    commitTick,
  })

  const refreshAll = useCallback(() => {
    setBust(String(Date.now()))
    setPanelVersion((v) => v + 1)
    if (id) getSource().then((s) => s.getImage(id)).then(setImage)
  }, [id])

  const load = useCallback(() => {
    if (id) getSource().then((s) => s.getImage(id)).then(setImage)
  }, [id])

  useEffect(() => {
    getSource().then(setSource)
  }, [])

  useEffect(() => {
    load()
    setShowBefore(false)
  }, [load])

  // filmstrip honors the same filters as the Organize grid
  useEffect(() => {
    saveLastImage(id ?? null)
    getSource().then((s) => s.listImages(loadFilters())).then((r) => {
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

  // Empty in server mode, where the filmstrip keeps its plain thumbnail URLs.
  const stripThumbs = useThumbnails(source, siblings, local)

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

  // live refresh when an agent (or anything) edits sidecars on disk;
  // server-only, since the event stream is one of its endpoints
  useEffect(() => {
    if (local) return
    return onSidecarChange((ids) => {
      if (id && ids.includes(id)) refreshAll()
    })
  }, [id, local, refreshAll])

  /** Render the loupe frame locally. Re-runs on anything that changes which
   *  pixels are wanted; the previous blob is revoked as it goes. */
  useEffect(() => {
    if (!local || !id) return
    let stale = false
    getSource()
      .then((s) => s.preview(id, { size: zoomed ? 4096 : 2048, original: showBefore }))
      .then((frame) => (stale ? frame.release() : setLocalFrame(frame)))
      .catch(() => {})
    return () => {
      stale = true
    }
    // `bust` is in here because it is how the rest of the page says "the recipe
    // changed"; the blob itself is always fresh.
  }, [local, id, zoomed, showBefore, bust])

  // Revoking is tied to the frame's own lifetime rather than to the effect
  // above, so a frame is never released while it is still the one on screen.
  useEffect(() => () => localFrame?.release(), [localFrame])

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
    const write = (r: number) => getSource().then((s) => s.setRating(id, r))
    pushAction({ undo: () => write(prev), redo: () => write(rating) })
    write(rating).then(load)
  }
  const setFlag = (flag: Flag) => {
    if (!id || !image) return
    const prev = image.flag
    const write = (f: Flag) => getSource().then((s) => s.setFlag(id, f))
    pushAction({ undo: () => write(prev), redo: () => write(flag) })
    write(flag).then(load)
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
            title={local ? 'Crop needs the desktop app' : 'Crop & straighten (C)'}
            onClick={() => setCropMode((v) => !v)}
            disabled={!id || local}
          >
            <Crop size={14} />
          </button>
            <button className="btn btn-sm btn-ghost" title="Fullscreen (F)" onClick={toggleFullscreen}>
            <Maximize size={14} />
          </button>
          <button
            className="btn btn-sm btn-primary"
            title={local ? 'Export needs the desktop app' : undefined}
            onClick={() => setExportOpen(true)}
            disabled={!id || local}
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
              local
                ? (localFrame?.url ?? '')
                : proof
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
        {/* The one case where local and server disagree about what is on
            screen, so it is said out loud rather than shown quietly. */}
        {local && !showBefore && localFrame?.rendered === 'original' && image?.has_edits && (
          <span className="absolute top-3 right-3 badge badge-warning gap-1 font-mono">
            Original — these edits need the desktop app
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
      {/* The develop panel talks to the REST API directly — presets, LUTs,
          auto-adjust, soft proof, history. None of that has a browser
          implementation yet, and a panel whose every control 404s is worse
          than an honest gap. Ratings, flags and the rendered preview all work
          without it. */}
      {!fullscreen && id && local && (
        <div className="w-72 shrink-0 p-4 text-sm opacity-70 border-l border-base-300/30">
          <p className="font-medium mb-2">Read-only, for now</p>
          <p>
            Running with no server: browsing, ratings, flags and previews of
            existing edits work. Changing a recipe still needs the desktop app.
          </p>
        </div>
      )}
      {!fullscreen && id && !local && (
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
        <Filmstrip
          siblings={siblings}
          image={image}
          id={id}
          idx={idx}
          thumbSrcs={local ? stripThumbs : undefined}
          onPick={openImage}
        />
      )}
    </div>
  )
}
