import { useCallback, useEffect, useRef, useState } from 'react'
import { Crop, Download, Maximize, Minimize } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { unsupportedReason } from '../local/unsupported'
import { sourceFrame } from '../local/decode'
import { decodeBusy, regrantLibrary } from '../local'
import { getSource, type Flag, type ImageMeta, type PhotoSource, type SourceUrl } from '../source'
import { useThumbnails } from '../local/useThumbnails'
import { FlagBadge, RatingStars } from '../components/RatingStars'
import { Brand } from '../components/Brand'
import { CropTool } from '../components/CropTool'
import { ExportDialog } from '../components/ExportDialog'
import { EditPanel } from '../components/EditPanel'
import { Filmstrip } from '../components/Filmstrip'
import { GpuPreview } from '../components/GpuPreview'
import { LibraryPicker } from '../components/LibraryPicker'
import { ModuleTabs } from '../components/ModuleTabs'
import { ZoomableImage } from '../components/ZoomableImage'
import { createLiveRecipe } from '../gpu'
import { useGpuPreview } from '../hooks/useGpuPreview'
import { useLocalGpuPreview } from '../hooks/useLocalGpuPreview'
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
  /** Local mode, reloaded, folder permission lapsed — one click from working. */
  const [needsLibrary, setNeedsLibrary] = useState(false)

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
  /** The local frame, plus whether the *user* asked for the original. Kept
   *  beside the frame rather than inside SourceUrl: it is a fact about the
   *  request, not about the pixels. */
  const [localFrame, setLocalFrame] = useState<(SourceUrl & { asked: boolean }) | null>(null)
  /** Something to look at while the real one is decoded.
   *
   *  A RAW is 0.6-9 seconds to decode, and switching images pays that every
   *  time it is a photo the cache has not seen. The grid has already decoded
   *  the camera's embedded preview for its tile, so showing that immediately
   *  turns a multi-second blank into a soft image that sharpens. */
  const [fastFrame, setFastFrame] = useState<SourceUrl | null>(null)


  const local = source?.kind === 'local'

  useEffect(() => {
    if (!local || !id) return
    let stale = false
    getSource()
      .then((s) => s.preview(id, { size: 1600, fast: true }))
      .then((f) => (stale ? f.release() : setFastFrame(f)))
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [local, id])

  useEffect(() => () => fastFrame?.release(), [fastFrame])


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
    // `kind === 'server'` and not `!local`: source starts null while the probe
    // is in flight, so `!local` is true before we know anything — and this hook
    // would fire /source and /preview at a backend that is not there.
    enabled: source?.kind === 'server' && !proof && !showBefore && !cropMode && !zoomed,
    commitTick,
  })

  /** The same GPU chain, driven from the file instead of `/source`, and with
   *  none of the server/GPU arbitration above — locally the GPU frame is the
   *  only frame there has ever been. It draws while the sliders move; the
   *  still frame from `local/preview.ts` takes over once an edit settles, and
   *  is all there is for a recipe the shader cannot reproduce. */
  const localGpu = useLocalGpuPreview({
    imageId: id,
    size: GPU_PREVIEW_SIZE,
    live,
    // Zoomed is excluded for the same reason the size is fixed: the still
    // frame is re-rendered at 4096 there, and overlaying a 2048 canvas on it
    // would quietly drop the resolution the photographer zoomed in to judge.
    enabled: local && !showBefore && !cropMode && !zoomed,
  })

  const gpuMode = local ? localGpu.mode : gpu.mode

  const refreshAll = useCallback(() => {
    setBust(String(Date.now()))
    setPanelVersion((v) => v + 1)
    if (id) getSource().then((s) => s.getImage(id)).then(setImage).catch(() => {})
  }, [id])

  const load = useCallback(() => {
    if (id) getSource().then((s) => s.getImage(id)).then(setImage).catch(() => {})
  }, [id])

  /** `pick` chooses a folder afresh; otherwise re-grant the one already stored.
   *  Either way the index is rebuilt, so the page can just carry on. */
  const reconnect = useCallback(async (pick: boolean) => {
    const s = await getSource()
    if (pick) await s.openLibrary()
    else await regrantLibrary()
    if ((await s.getLibrary()).library) {
      setNeedsLibrary(false)
      load()
    }
  }, [load])


  useEffect(() => {
    getSource().then(async (s) => {
      setSource(s)
      // A reload lands here with no library: the handle survives in IndexedDB
      // but its permission does not, and re-granting needs a click the browser
      // will only accept from a real gesture. Asking here beats bouncing to
      // the catalog, which threw away the photo you were looking at.
      if (s.kind === 'local') setNeedsLibrary(!(await s.getLibrary()).library)
    })
  }, [navigate])

  useEffect(() => {
    load()
    setShowBefore(false)
  }, [load])

  // filmstrip honors the same filters as the Organize grid
  useEffect(() => {
    saveLastImage(id ?? null)
    getSource().then((s) => s.listImages(loadFilters())).catch(() => ({ images: [] as ImageMeta[] })).then((r) => {
      setSiblings(r.images)
      if (!id && r.images.length) {
        const last = loadLastImage()
        const target = last && r.images.some((im) => im.id === last) ? last : r.images[0].id
        navigate(`/edit/${target}`, { replace: true })
      }
    })
  }, [id, navigate])

  const idx = id ? siblings.findIndex((im) => im.id === id) : -1

  /**
   * Decode the neighbours while this one is on screen.
   *
   * Arrow-keying through a folder is the common case and it was paying a full
   * RAW decode — 0.6 to 9 seconds — at every step. The work cannot be made
   * faster, but it can be done early: by the time the key is pressed the frame
   * is usually already in `frameCache`, and the next photo appears at once.
   *
   * Deliberately after a delay and one at a time. Scrubbing through a filmstrip
   * fires this on every image passed through, and starting a decode for each
   * would fill the worker pool with work that is already stale.
   */
  useEffect(() => {
    if (!local || idx < 0) return
    const ahead = [siblings[idx + 1], siblings[idx - 1]].filter(Boolean)
    if (!ahead.length) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const s = await getSource()
      for (const im of ahead) {
        if (cancelled) return
        // Stand down while anything is decoding for real. On a reload the
        // filmstrip wants forty-odd thumbnails, and reading ahead is worth
        // nothing next to the tiles someone is waiting to see — each RAW
        // decode is a worker with its own wasm heap.
        if (decodeBusy()) return
        // Same size the loupe asks for, so this warms the entry it will want
        // rather than one next to it.
        await s
          .getFile(im.id)
          .then((f) => f && sourceFrame(f, zoomed ? 4096 : 2048))
          .catch(() => {})
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [local, idx, siblings, zoomed])
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
    // `!source` as well as `local`: source is null while the probe is in
    // flight, so `local` is false before anything is known — and opening the
    // stream then means an EventSource pointed at a static host, which
    // answers with HTML and logs a MIME-type error on every load.
    if (!source || local) return
    return onSidecarChange((ids) => {
      if (id && ids.includes(id)) refreshAll()
    })
  }, [id, source, local, refreshAll])

  /** Render the loupe frame locally. Re-runs on anything that changes which
   *  pixels are wanted; the previous blob is revoked as it goes. */
  useEffect(() => {
    if (!local || !id) return
    let stale = false
    getSource()
      .then((s) => s.preview(id, { size: zoomed ? 4096 : 2048, original: showBefore }))
      // Remember whether the original was *asked for*. `rendered: 'original'`
      // answers two different questions — "you wanted the untouched file" and
      // "your edits are beyond what the browser can draw" — and only the
      // second one is worth telling anyone about.
      .then((frame) => (stale ? frame.release() : setLocalFrame({ ...frame, asked: showBefore })))
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

  if (needsLibrary) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="opacity-70 text-sm max-w-sm">
            Reconnect your photo folder to carry on. The browser asks again after
            a reload, and only a click can answer it.
          </p>
          <LibraryPicker
            onOpen={() => reconnect(true)}
            onReconnect={() => reconnect(false)}
          />
        </div>
      </div>
    )
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
            title={local ? 'Export — rendered here, written to a folder you pick' : undefined}
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
        {/* Decoding a RAW and rendering it takes a moment, and there is no
            server frame to show meanwhile. Rendering the loupe with an empty
            src made the browser resolve it to the page, fail, and draw its
            broken-image glyph with the filename underneath — a failure where
            the truth was "not yet". */}
        {id && !source && <div className="absolute inset-0 m-8 skeleton rounded-box" />}
        {/* Blurred on purpose: it is a thumbnail standing in for a photo, and
            pretending otherwise would read as a bad render rather than a
            pending one. */}
        {id && source && local && !localFrame && fastFrame && (
          <img
            src={fastFrame.url}
            alt=""
            className="max-h-full max-w-full object-contain blur-[2px] opacity-90"
          />
        )}
        {id && source && local && !localFrame && !fastFrame && (
          <div className="absolute inset-0 m-8 skeleton rounded-box" />
        )}
        {/* Not until the source is known. Rendering earlier meant falling
            through to the server's preview URL, which in a PWA is a request to
            a backend that does not exist. The skeleton above covers the gap. */}
        {/* Not while the local frame is still being decoded: its src would be
            empty, which the browser resolves to the page and draws as a broken
            image — on top of the stand-in above. */}
        {id && source && !(local && !localFrame) && (
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
            // ...and locally, neither is the CSS delta honest when the frame
            // underneath is the untouched original rather than the last render.
            filter={
              gpuMode === 'gpu' || (local && localFrame?.rendered === 'original') ? '' : liveFilter
            }
            hideImage={gpuMode === 'gpu'}
            // Two canvases rather than one shared ref: only ever one of the
            // hooks is active, but a WebGL context cannot be handed from one
            // to the other on the same element.
            overlay={(transform) => (
              <>
                <GpuPreview
                  canvasRef={gpu.canvasRef}
                  style={transform}
                  visible={!local && gpu.mode === 'gpu'}
                />
                <GpuPreview
                  canvasRef={localGpu.canvasRef}
                  style={transform}
                  visible={local && localGpu.mode === 'gpu'}
                />
              </>
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
        {local && image && unsupportedReason(image.filename) && (
          <span className="absolute top-3 left-3 badge badge-warning gap-1 font-mono">
            Desktop only — {unsupportedReason(image.filename)}
          </span>
        )}
        {local && !showBefore && !localFrame?.asked && gpuMode !== 'gpu'
          && localFrame?.rendered === 'original' && image?.has_edits && (
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
      {/* The sliders write the recipe, which both sources can do — the server
          over REST, the browser into the sidecar. The tools inside the panel
          that are genuinely server-side compute disable themselves. */}
      {!fullscreen && id && (
        <EditPanel
          imageId={id}
          local={local}
          // The histogram reads whatever frame is on screen. With no server
          // there is no `/preview` to point it at, so it gets the same blob
          // the loupe is showing.
          previewSrc={local ? (localFrame?.url ?? '') : api.previewUrl(id, 1024, bust)}
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
