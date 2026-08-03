import { useEffect, useState } from 'react'
import { FolderOpen, Link2 } from 'lucide-react'
import {
  fileSystemAccessSupported,
  libraryNeedsPermission,
  regrantLibrary,
} from '../local'

/** Folder chooser for the server-less build.
 *
 *  Two states, and the second one is the whole reason this component exists: a
 *  directory handle stored in IndexedDB comes back after a reload with its
 *  permission revoked, and re-granting it needs a real click. So a returning
 *  user gets "Reconnect", not a silent empty library.
 */
export function LibraryPicker({ onOpen }: { onOpen: () => Promise<unknown> }) {
  const [needsPermission, setNeedsPermission] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = fileSystemAccessSupported()

  useEffect(() => {
    libraryNeedsPermission().then(setNeedsPermission)
  }, [])

  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      // Cancelling the picker is a choice, not a failure worth an alert.
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(String(e))
    }
  }

  if (!supported) {
    return (
      <div className="alert alert-warning text-sm max-w-xl">
        This build reads photos straight off your disk, which needs the File System
        Access API — Chrome or another Chromium browser.
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {needsPermission ? (
        <>
          <p className="opacity-70">
            Your library is remembered, but the browser needs permission again.
          </p>
          <button
            className="btn btn-primary"
            onClick={() =>
              run(async () => {
                if (!(await regrantLibrary())) throw new Error('Permission denied')
                setNeedsPermission(false)
                await onOpen()
              })
            }
          >
            <Link2 size={14} /> Reconnect library
          </button>
        </>
      ) : (
        <button className="btn btn-primary" onClick={() => run(onOpen)}>
          <FolderOpen size={14} fill="#e8b339" stroke="#e8b339" /> Choose a photo folder…
        </button>
      )}
      {error && <div className="alert alert-error text-sm">{error}</div>}
    </div>
  )
}
