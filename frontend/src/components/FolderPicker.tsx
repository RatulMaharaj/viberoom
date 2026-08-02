import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { api } from '../api'

interface NodeProps {
  path: string
  name: string
  depth: number
  selected: string | null
  onSelect: (path: string) => void
}

function TreeNode({ path, name, depth, selected, onSelect }: NodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<string[] | null>(null)
  const [failed, setFailed] = useState(false)

  const toggle = async () => {
    if (!expanded && children === null) {
      try {
        const r = await api.browseFs(path)
        setChildren(r.dirs)
      } catch {
        setChildren([])
        setFailed(true)
      }
    }
    setExpanded((v) => !v)
  }

  const isSelected = selected === path
  const isLeaf = children !== null && children.length === 0

  return (
    <>
      <div
        className={`flex items-center gap-1 py-0.5 pr-2 rounded cursor-pointer text-sm font-mono whitespace-nowrap ${
          isSelected ? 'bg-primary/25' : 'hover:bg-base-300/40'
        }`}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={() => onSelect(path)}
        onDoubleClick={toggle}
        title={path}
      >
        <button
          className="p-0.5 opacity-60 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
        >
          {isLeaf ? (
            <span className="inline-block w-3.5" />
          ) : expanded ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
        </button>
        {expanded ? (
          <FolderOpen size={14} fill="#e8b339" stroke="#e8b339" className="shrink-0" />
        ) : (
          <Folder size={14} fill="#e8b339" stroke="#e8b339" className="shrink-0" />
        )}
        <span className="truncate">{name}</span>
        {failed && <span className="text-error text-xs">no access</span>}
      </div>
      {expanded &&
        children?.map((c) => (
          <TreeNode
            key={c}
            path={c}
            name={c.split('/').filter(Boolean).pop() ?? c}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
    </>
  )
}

export function FolderPicker({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const [roots, setRoots] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .browseFs()
      .then((r) => setRoots(r.dirs))
      .catch((e) => setError(String(e)))
  }, [])

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-lg">
        <h3 className="font-bold mb-2">Choose a folder</h3>
        <div className="font-mono text-xs opacity-70 break-all mb-2 min-h-4">{selected ?? ' '}</div>
        {error && <div className="alert alert-error text-xs p-2 mb-2">{error}</div>}
        <div className="bg-base-200 rounded-box max-h-96 overflow-y-auto overflow-x-auto py-1">
          {roots.map((r) => (
            <TreeNode
              key={r}
              path={r}
              name={r}
              depth={0}
              selected={selected}
              onSelect={setSelected}
            />
          ))}
        </div>
        <p className="text-xs opacity-50 mt-1">Click to select · double-click or chevron to expand</p>
        <div className="modal-action">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!selected}
            onClick={() => selected && onSelect(selected)}
          >
            Use this folder
          </button>
        </div>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </dialog>
  )
}
