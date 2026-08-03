import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { api } from '../api'
import { FolderPicker } from './FolderPicker'

/** Logo with the current library folder underneath. Clicking the folder
 * opens the picker; changing folder reloads into the Catalog. */
export function Brand() {
  const [libraryPath, setLibraryPath] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)

  useEffect(() => {
    api.getLibrary().then((r) => setLibraryPath(r.library))
  }, [])

  const openLibrary = async (path: string) => {
    await api.setLibrary(path)
    window.location.href = '/'
  }

  return (
    <div className="flex flex-col items-start leading-tight shrink-0">
      <span className="font-bold text-lg">Viberoom</span>
      <button
        className="flex items-center gap-1 text-xs opacity-70 hover:opacity-100"
        title={libraryPath ? `${libraryPath} — click to change folder` : 'Choose folder'}
        onClick={() => setShowPicker(true)}
      >
        <FolderOpen size={11} fill="#e8b339" stroke="#e8b339" />
        <span className="max-w-40 truncate">
          {libraryPath ? libraryPath.split('/').filter(Boolean).pop() : 'choose folder…'}
        </span>
      </button>
      {showPicker && (
        <FolderPicker
          onSelect={openLibrary}
          onClose={() => setShowPicker(false)}
          current={libraryPath}
        />
      )}
    </div>
  )
}
