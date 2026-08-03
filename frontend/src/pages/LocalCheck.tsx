/** A throwaway diagnostic for the no-server path.
 *
 * Picking a folder needs a real click in a real browser, so none of the File
 * System Access work can be verified from a test runner. This page exercises
 * it end to end — pick, walk, read a sidecar, write one back, decode a
 * thumbnail — and reports what happened, so the unverifiable parts get checked
 * by a human once instead of guessed at forever.
 *
 * Delete once the library page runs on the seam for real.
 */
import { useEffect, useState } from 'react'
import { LocalSource } from '../local'
import { fileSystemAccessSupported, libraryNeedsPermission, pickLibrary, regrantLibrary } from '../local/handles'
import { loadSidecar, saveSidecar } from '../local/sidecar'
import { walkLibrary } from '../local/scan'

type Row = { label: string; ok: boolean | null; detail: string }

export function LocalCheck() {
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [needsPerm, setNeedsPerm] = useState(false)
  const [thumb, setThumb] = useState<string | null>(null)

  useEffect(() => { libraryNeedsPermission().then(setNeedsPerm).catch(() => {}) }, [])

  const push = (label: string, ok: boolean | null, detail: unknown) =>
    setRows((r) => [...r, { label, ok, detail: String(detail) }])

  async function run(pick: boolean) {
    setRows([]); setThumb(null); setBusy(true)
    try {
      push('File System Access available', fileSystemAccessSupported(), navigator.userAgent.slice(0, 60))

      const dir = pick ? await pickLibrary() : await regrantLibrary()
      if (!dir) { push('folder handle', false, 'none stored — choose a folder'); return }
      push('folder opened', true, dir.name)

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

      const listed = await LocalSource.listImages({})
      push('LocalSource.listImages', listed.images.length === found.length,
           `${listed.images.length} rows, total=${listed.total}`)

      const nonRaw = found.find((f) => !f.isRaw)
      if (nonRaw) {
        const t = await LocalSource.thumbnail(nonRaw.id)
        setThumb(t?.url ?? null)
        push('decoded a thumbnail', !!t?.url, nonRaw.filename)
      } else {
        push('decoded a thumbnail', null, 'no JPEG/PNG present — RAW decode is not wired up yet')
      }
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
          Runs the no-server path against a folder you choose. Nothing is uploaded;
          the only write is a rating on the first photo's sidecar, set and then put back.
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

      {thumb && <img src={thumb} alt="decoded thumbnail" className="rounded border w-48" />}
    </div>
  )
}
