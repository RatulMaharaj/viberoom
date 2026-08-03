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

  async function run(pick: boolean) {
    setRows([]); setTiles([]); setBusy(true)
    try {
      push('File System Access available', fileSystemAccessSupported(), navigator.userAgent.slice(0, 60))
      push('WebGL2 preview available', gpuEnabled(), 'renders the develop preview; no server fallback exists here')

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
      push('EXIF backfilled', withExif.length > 0,
           `${withExif.length}/${found.length} files in ${metaMs} ms`)

      const dated = await LocalSource.listImages({ sort: 'taken_at', order: 'desc', limit: 3 })
      push('sorted by capture time', true,
           dated.images.map((m) => m.filename).join(', ') || '(none)')

      const [preview, previewMs] = await timed(() => LocalSource.preview(first.id, { size: 1600 }))
      setTiles((x) => [...x, { label: `preview — ${preview.rendered}`, url: preview.url }])
      // 'gpu' means the shader drew the recipe; 'original' means it could not
      // and the untouched frame is what you are looking at.
      push('rendered a preview', preview.rendered === 'gpu',
           `${preview.rendered} in ${previewMs} ms`)
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
          then put back.
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
