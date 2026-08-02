import { useEffect, useState } from 'react'
import { ArrowUp, Folder } from 'lucide-react'
import { api } from '../api'

export function FolderPicker({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const [current, setCurrent] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [dirs, setDirs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = (path?: string) => {
    setError(null)
    api
      .browseFs(path)
      .then((r) => {
        setCurrent(r.path)
        setParent(r.parent)
        setDirs(r.dirs)
      })
      .catch((e) => setError(String(e)))
  }

  useEffect(() => load(), [])

  const name = (p: string) => p.split('/').filter(Boolean).pop() ?? p

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-lg">
        <h3 className="font-bold mb-2">Choose a folder</h3>
        <div className="font-mono text-xs opacity-70 break-all mb-2">
          {current ?? 'Locations'}
        </div>
        {error && <div className="alert alert-error text-xs p-2 mb-2">{error}</div>}
        <ul className="menu bg-base-200 rounded-box max-h-80 overflow-y-auto flex-nowrap w-full">
          {(current || parent) && (
            <li>
              <button onClick={() => (parent ? load(parent) : load())}>
                <ArrowUp size={14} /> ..
              </button>
            </li>
          )}
          {dirs.map((d) => (
            <li key={d}>
              <button className="font-mono text-sm" onClick={() => load(d)}>
                <Folder size={14} /> {current ? name(d) : d}
              </button>
            </li>
          ))}
          {dirs.length === 0 && <li className="p-2 text-xs opacity-50">No subfolders</li>}
        </ul>
        <div className="modal-action">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!current}
            onClick={() => current && onSelect(current)}
          >
            Use this folder
          </button>
        </div>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </dialog>
  )
}
