import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { api } from '../api'
import { getSource } from '../source'
import { useFolderChooser } from '../folderChooser'
import { FolderPicker } from './FolderPicker'

/** Logo, optionally with the current library folder underneath. Clicking the
 * folder opens the picker; changing folder reloads into the Catalog.
 * Switching library is a Catalog-level action, so Develop hides it. */
export function Brand({ showFolder = true }: { showFolder?: boolean }) {
  const [libraryPath, setLibraryPath] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [local, setLocal] = useState(false)
  const { available: nativePicker, choose } = useFolderChooser()

  useEffect(() => {
    // Through the seam, not the API: with no backend `api.getLibrary()`
    // resolves to the app shell, and this had no catch — an unhandled
    // rejection on every load of the PWA.
    getSource()
      .then(async (s) => {
        setLocal(s.kind !== 'server')
        setLibraryPath((await s.getLibrary()).library)
      })
      .catch(() => {})
  }, [])

  const openLibrary = async (path: string) => {
    await api.setLibrary(path)
    window.location.href = '/'
  }

  /** Switch library. With no server there is no path to hand over and no
   *  server-side dialog to open — the browser's own picker is the only thing
   *  that can see the disk, and it needs to be called from the click. */
  const chooseFolder = async () => {
    if (local) {
      const s = await getSource()
      const opened = await s.openLibrary()
      if (opened.library) window.location.href = '/'
      return
    }
    if (!nativePicker) return setShowPicker(true)
    const picked = await choose(libraryPath)
    if (picked) openLibrary(picked)
  }

  return (
    <div className="flex items-center gap-2 leading-tight shrink-0">
      <span className="flex items-center gap-1.5">
        <img src="/favicon.png" alt="" className="w-5 h-5" />
        <span className="font-brand font-bold text-lg tracking-tight">Viberoom</span>
      </span>
      {showFolder && (
      <button
        className="flex items-center gap-1 text-xs opacity-70 hover:opacity-100 border-l border-base-content/20 pl-2"
        title={libraryPath ? `${libraryPath} — click to change folder` : 'Choose folder'}
        onClick={chooseFolder}
      >
        <FolderOpen size={11} fill="#e8b339" stroke="#e8b339" />
        <span className="max-w-40 truncate">
          {libraryPath ? libraryPath.split('/').filter(Boolean).pop() : 'choose folder…'}
        </span>
      </button>
      )}
      {showFolder && showPicker && !local && (
        <FolderPicker
          onSelect={openLibrary}
          onClose={() => setShowPicker(false)}
          current={libraryPath}
        />
      )}
    </div>
  )
}
