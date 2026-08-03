/** A throwaway diagnostic for the no-server path.
 *
 * Picking a folder, decoding a RAW and rendering on the GPU all need a real
 * browser with real hardware, so none of it can be verified from a test
 * runner. This page exercises the lot end to end — pick, walk, read and write
 * a sidecar, thumbnail a JPEG and a RAW, read EXIF, render a preview — and
 * reports what happened and how long it took, so the unverifiable parts get
 * checked by a human once instead of guessed at forever.
 *
 * The timings are the point as much as the ticks are: a RAW thumbnail that
 * takes four seconds is "working" and still unusable in a grid.
 */
import { useEffect, useState } from 'react'
import { LocalSource, metadataReady } from '../local'
import { fileSystemAccessSupported, libraryNeedsPermission, regrantLibrary, restoreLibrary } from '../local/handles'
import { loadSidecar, saveSidecar } from '../local/sidecar'
import { walkLibrary } from '../local/scan'
import { gpuEnabled } from '../gpu'

type Row = { label: string; ok: boolean | null; detail: string }

/** Render a frame whose top half is bright and bottom half dark, present it,
 *  and read back which half ended up on top. Returns [ok, detail]. */
async function checkOrientation(): Promise<[boolean | null, string]> {
  const { GpuRenderer } = await import('../gpu/renderer')
  const { encodeRgb9e5 } = await import('../gpu/encode')
  const W = 8, H = 8
  const rgb = new Float32Array(W * H * 3)
  for (let y = 0; y < H; y++) {
    const v = y < H / 2 ? 0.9 : 0.05 // bright on top, in source order
    for (let x = 0; x < W; x++) rgb.set([v, v, v], (y * W + x) * 3)
  }

  const canvas = document.createElement('canvas')
  let renderer: InstanceType<typeof GpuRenderer> | null = null
  try {
    renderer = new GpuRenderer(canvas)
    renderer.setSource({ width: W, height: H, format: 'rgb9e5', data: encodeRgb9e5(rgb, W, H) })
    renderer.render({})

    const flat = document.createElement('canvas')
    flat.width = canvas.width; flat.height = canvas.height
    const ctx = flat.getContext('2d')!
    ctx.drawImage(canvas, 0, 0)
    const top = ctx.getImageData(0, 0, 1, 1).data[0]
    const bottom = ctx.getImageData(0, flat.height - 1, 1, 1).data[0]
    if (top === bottom) return [null, `inconclusive — top and bottom both ${top}`]
    return [top > bottom, top > bottom
      ? `correct (top ${top}, bottom ${bottom})`
      : `MIRRORED — the image is upside down (top ${top}, bottom ${bottom})`]
  } catch (e) {
    return [null, `could not run: ${e instanceof Error ? e.message : e}`]
  } finally {
    renderer?.dispose()
  }
}

/** The export path, as far as it can be driven without a folder-picker gesture.
 *
 *  Writing files needs `showDirectoryPicker`, which needs a click and a folder,
 *  so that half stays unverifiable here. Everything up to it does not: the
 *  filename template, the PIL-compatible resize arithmetic, the memory cap, the
 *  refusal rule, and — the expensive one — a genuine multi-megapixel GPU render
 *  encoded to a JPEG. Returns rows plus the encoded frame to look at. */
async function checkExport(): Promise<{ rows: Row[]; tile?: { label: string; url: string } }> {
  const rows: Row[] = []
  const add = (label: string, ok: boolean | null, detail: unknown) =>
    rows.push({ label, ok, detail: String(detail) })
  const {
    EXPORT_PIXEL_CAP, cappedSize, exportRefusal, fitWithin, releaseExportRenderer, renderExport,
    renderFilename,
  } = await import('../local')

  try {
    const name = renderFilename('web/{seq}-{name}{ext}', {
      name: 'DSC_0042', seq: 7, rating: 3, date: '2024-05-01', ext: '.jpg',
    })
    const dated = renderFilename('{date}/{rating}star/{name}{ext}', {
      name: 'a', seq: 1, rating: 5, date: null, ext: '.png',
    })
    let refusedDots = false
    try {
      renderFilename('../{name}{ext}', { name: 'a', seq: 1, rating: 0, date: null, ext: '.jpg' })
    } catch { refusedDots = true }
    add('filename template', name === 'web/0007-DSC_0042.jpg' &&
      dated === 'undated/5star/a.png' && refusedDots,
      `${name} | ${dated} | '..' refused: ${refusedDots}`)
  } catch (e) {
    add('filename template', false, e)
  }

  // PIL's thumbnail() on 6000x4000 into a 2000 box gives 2000x1333, and never
  // upscales. Both are things a resized export gets wrong quietly if wrong.
  const fitted = fitWithin(6000, 4000, 2000)
  const tall = fitWithin(1000, 3000, 2000)
  const big = fitWithin(800, 600, 2000)
  add('resize maths matches PIL',
    fitted[0] === 2000 && fitted[1] === 1333 && tall[1] === 2000 && big[0] === 800,
    `6000x4000→${fitted.join('x')}  1000x3000→${tall.join('x')}  800x600→${big.join('x')} (no upscale)`)

  const capped = cappedSize(8192, 5464, 16384)
  add('memory cap', capped[0] * capped[1] <= EXPORT_PIXEL_CAP,
    `45 MP → ${capped.join('x')} (${(capped[0] * capped[1] / 1e6).toFixed(1)} MP), ` +
    `cap ${(EXPORT_PIXEL_CAP / 1e6).toFixed(0)} MP; a bigger file is downscaled and the export says so`)

  // The correctness rule: a recipe the shader cannot draw must be named and
  // refused, not exported with the edit missing.
  const refusedGrain = exportRefusal({ effects: { grain: { amount: 40, size: 25 } } })
  const refusedMask = exportRefusal({ masks: [{ type: 'subject', adjustments: { exposure: 1 } }] })
  const allowed = exportRefusal({ tone: { exposure: 0.5, contrast: 20 } })
  add('refuses what it cannot draw', !!refusedGrain && !!refusedMask && allowed === null,
    `grain: ${refusedGrain} | AI mask: ${refusedMask} | plain tone recipe: ${allowed ?? 'exported'}`)

  // A real render at a size no preview ever asks for, through the same code an
  // export uses. 6 MP rather than 24: this is a diagnostic, and the cap above
  // is what the full-size case relies on anyway.
  try {
    const W = 3000, H = 2000
    const data = new Float32Array(W * H * 3)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3
        data[i] = x / W
        data[i + 1] = y / H
        data[i + 2] = 0.5
      }
    }
    const t0 = performance.now()
    const out = await renderExport(
      { width: W, height: H, data },
      { tone: { exposure: 0.3, contrast: 25 }, effects: { vignette: { amount: -40 } } },
      { format: 'jpeg', quality: 90, maxDimension: 2000 },
    )
    const ms = Math.round(performance.now() - t0)
    add('full-size render + JPEG encode',
      out.width === 2000 && out.height === 1333 && out.blob.size > 0,
      `${W}x${H} → ${out.width}x${out.height}, ${(out.blob.size / 1024).toFixed(0)} kB in ${ms} ms`)
    return { rows, tile: { label: 'export render', url: URL.createObjectURL(out.blob) } }
  } catch (e) {
    add('full-size render + JPEG encode', false, e instanceof Error ? e.message : e)
  } finally {
    // Full-resolution render targets are hundreds of megabytes; a diagnostic
    // must not leave them allocated.
    releaseExportRenderer()
  }
  return { rows }
}

export function LocalCheck() {
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [needsPerm, setNeedsPerm] = useState(false)
  const [tiles, setTiles] = useState<{ label: string; url: string }[]>([])

  useEffect(() => { libraryNeedsPermission().then(setNeedsPerm).catch(() => {}) }, [])

  const push = (label: string, ok: boolean | null, detail: unknown) =>
    setRows((r) => [...r, { label, ok, detail: String(detail) }])

  /** Time an async step, so "works" and "works fast enough" stay separable. */
  async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
    const t0 = performance.now()
    return [await work(), Math.round(performance.now() - t0)]
  }

  /** The export checks on their own — no folder, no picker, one click. */
  async function runExport() {
    setRows([]); setTiles([]); setBusy(true)
    try {
      const { rows: r, tile } = await checkExport()
      setRows(r)
      if (tile) setTiles([tile])
    } catch (e) {
      push('failed', false, e instanceof Error ? `${e.name}: ${e.message}` : e)
    } finally {
      setBusy(false)
    }
  }

  async function run(pick: boolean) {
    setRows([]); setTiles([]); setBusy(true)
    try {
      push('File System Access available', fileSystemAccessSupported(), navigator.userAgent.slice(0, 60))
      push('WebGL2 preview available', gpuEnabled(), 'renders the develop preview; no server fallback exists here')

      // Absent is a normal answer, not a fault: it needs Chrome 146+ with
      // chrome://flags/#enable-webmcp-testing on, and the app works without it.
      const { webmcpToolCount, webmcpToolNames } = await import('../webmcp')
      const tools = webmcpToolCount()
      push('WebMCP tools registered', tools > 0 ? true : null,
           'modelContext' in navigator
             ? `${tools} tools: ${webmcpToolNames().join(', ')}`
             : 'navigator.modelContext absent — needs Chrome 146+ with #enable-webmcp-testing')

      // Go through LocalSource, not pickLibrary: LocalSource keeps its own
      // root handle and file index, and picking the folder behind its back
      // grants access to a library it has never been told about.
      if (pick) {
        const opened = await LocalSource.openLibrary()
        push('folder opened', !!opened.library, `${opened.library} (${opened.total} images)`)
      } else {
        const regranted = await regrantLibrary()
        if (!regranted) { push('folder handle', false, 'none stored — choose a folder'); return }
        const lib = await LocalSource.getLibrary()
        push('folder reconnected', !!lib.library, String(lib.library))
      }

      const dir = await restoreLibrary()
      if (!dir) { push('folder handle', false, 'no handle after opening'); return }

      const t0 = performance.now()
      const found = await walkLibrary(dir)
      push('walked the folder', found.length > 0,
           `${found.length} images in ${Math.round(performance.now() - t0)} ms`)
      if (!found.length) return

      const byExt = found.reduce<Record<string, number>>((a, f) => {
        const e = f.ext
        a[e] = (a[e] ?? 0) + 1; return a
      }, {})
      push('formats seen', true, Object.entries(byExt).map(([e, n]) => `${e}×${n}`).join('  '))

      const first = found[0]
      push('image id', true, `${first.id}  (${first.relPath})`)

      // Reading a sidecar that may not exist must yield defaults, not throw.
      const sc = await loadSidecar(first)
      push('read sidecar', true, `rating=${sc.rating} flag=${sc.flag} keys=${Object.keys(sc).length}`)

      // Round-trip a harmless field so write permission is genuinely proven.
      const original = sc.rating
      await saveSidecar(first, { ...sc, rating: original === 5 ? 4 : 5 })
      const after = await loadSidecar(first)
      await saveSidecar(first, { ...sc, rating: original })
      const restored = await loadSidecar(first)
      push('wrote sidecar and restored it',
           after.rating !== original && restored.rating === original,
           `${original} → ${after.rating} → ${restored.rating}`)

      // Opening the library is what starts the metadata backfill, so this also
      // proves the grid does not wait on it.
      const [listed, listMs] = await timed(() => LocalSource.listImages({}))
      push('LocalSource.listImages', listed.images.length === found.length,
           `${listed.images.length} rows, total=${listed.total}, ${listMs} ms — no EXIF wait`)

      for (const [label, file] of [
        ['JPEG/PNG', found.find((f) => !f.isRaw)],
        ['RAW', found.find((f) => f.isRaw)],
      ] as const) {
        if (!file) {
          push(`${label} thumbnail`, null, `no ${label} file in this folder`)
          continue
        }
        const [t, ms] = await timed(() => LocalSource.thumbnail(file.id))
        setTiles((x) => [...x, { label: `${label} — ${file.filename}`, url: t.url }])
        // A RAW over ~300 ms means the embedded preview was missed and LibRaw
        // decoded the whole frame — working, but not at grid speed.
        push(`${label} thumbnail`, !!t.url, `${file.filename} in ${ms} ms`)
      }

      // The backfill runs in the background; this waits for it on purpose.
      const [, metaMs] = await timed(metadataReady)
      const withExif = (await LocalSource.listImages({ limit: 10000 })).images
        .filter((m) => Object.keys(m.exif).length > 0)
      // Only cameras write EXIF. A folder of generated PNGs yielding none is
      // the right answer, not a failure — so this only counts as a test when
      // there is something present that ought to carry tags.
      const shouldHaveExif = found.some((f) => f.isRaw || /^\.jpe?g$/i.test(f.ext))
      push('EXIF backfilled', shouldHaveExif ? withExif.length > 0 : null,
           shouldHaveExif
             ? `${withExif.length}/${found.length} files in ${metaMs} ms`
             : `no RAW or JPEG here — PNGs carry no EXIF, so none is correct`)

      const dated = await LocalSource.listImages({ sort: 'taken_at', order: 'desc', limit: 3 })
      push('sorted by capture time', true,
           dated.images.map((m) => m.filename).join(', ') || '(none)')

      // Is the presented canvas the right way up? texImage2D puts source row 0
      // at texel row 0, but the default framebuffer's origin is bottom-left, so
      // unless something compensates, the top of the image lands at the bottom
      // of the canvas. Nothing in the shader chain flips it, and a 1x1 smoke
      // test cannot see it — so draw a frame whose halves differ and look.
      push('canvas is the right way up', ...(await checkOrientation()))

      const [preview, previewMs] = await timed(() => LocalSource.preview(first.id, { size: 1600 }))
      setTiles((x) => [...x, { label: `preview — ${preview.rendered}`, url: preview.url }])
      // 'gpu' means the shader drew the recipe; 'original' means it could not
      // and the untouched frame is what you are looking at.
      push('rendered a preview', preview.rendered === 'gpu',
           `${preview.rendered} in ${previewMs} ms`)

      // Export, minus the one step that needs a folder: everything below runs
      // the real code paths, and only `showDirectoryPicker` + `createWritable`
      // are left for a human with a destination in mind.
      const { rows: exportRows, tile } = await checkExport()
      setRows((r) => [...r, ...exportRows])
      if (tile) setTiles((x) => [...x, tile])
    } catch (e) {
      push('failed', false, e instanceof Error ? `${e.name}: ${e.message}` : e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-8 max-w-3xl mx-auto flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Local filesystem check</h1>
        <p className="text-sm opacity-70">
          Runs the no-server path against a folder you choose: walk, sidecars, RAW and
          JPEG thumbnails, the EXIF backfill, and a GPU-rendered preview. Nothing is
          uploaded; the only write is a rating on the first photo's sidecar, set and
          then put back. “Check export” needs no folder at all: it runs the filename
          template, the resize and memory arithmetic, the refusal rule, and a real
          multi-megapixel render encoded to JPEG — everything an export does except
          picking a destination and writing the file.
        </p>
      </div>

      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(true)}>
          Choose a folder
        </button>
        {needsPerm && (
          <button className="btn btn-sm" disabled={busy} onClick={() => run(false)}>
            Reconnect last folder
          </button>
        )}
        <button className="btn btn-sm" disabled={busy} onClick={runExport}>
          Check export (no folder)
        </button>
      </div>

      {rows.length > 0 && (
        <table className="table table-sm">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="w-8">{r.ok === null ? '–' : r.ok ? '✓' : '✗'}</td>
                <td className="font-medium whitespace-nowrap">{r.label}</td>
                <td className="font-mono text-xs opacity-70">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tiles.length > 0 && (
        <div className="flex flex-wrap gap-4">
          {tiles.map((t) => (
            <figure key={t.label} className="flex flex-col gap-1">
              <img src={t.url} alt={t.label} className="rounded border w-64" />
              <figcaption className="font-mono text-xs opacity-70">{t.label}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  )
}
