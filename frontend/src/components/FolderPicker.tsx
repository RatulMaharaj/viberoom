import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { api } from '../api'

interface NodeProps {
  path: string
  name: string
  depth: number
  selected: string | null
  onSelect: (path: string) => void
  /** Folder to reveal on open: this node expands if it's an ancestor of it. */
  reveal?: string | null
}

/** Is `dir` an ancestor of `target` (or the target itself)? */
const onPathTo = (dir: string, target: string) =>
  target === dir || target.startsWith(dir.endsWith('/') ? dir : `${dir}/`)

function TreeNode({ path, name, depth, selected, onSelect, reveal }: NodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<string[] | null>(null)
  const [failed, setFailed] = useState(false)
  const row = useRef<HTMLDivElement>(null)

  const load = async () => {
    if (children !== null) return children
    try {
      const r = await api.browseFs(path)
      setChildren(r.dirs)
      return r.dirs
    } catch {
      setChildren([])
      setFailed(true)
      return []
    }
  }

  const toggle = async () => {
    if (!expanded) await load()
    setExpanded((v) => !v)
  }

  // Walk open along the ancestor chain. Each node on the path expands and
  // loads its children, which mounts the next node down, and so on.
  useEffect(() => {
    if (!reveal) return
    if (path !== reveal && onPathTo(path, reveal)) {
      load().then(() => setExpanded(true))
    }
    if (path === reveal) row.current?.scrollIntoView({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, path])

  const isSelected = selected === path
  const isLeaf = children !== null && children.length === 0

  return (
    <>
      <div
        ref={row}
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
            reveal={reveal}
          />
        ))}
    </>
  )
}

export function FolderPicker({
  onSelect,
  onClose,
  current,
}: {
  onSelect: (path: string) => void
  onClose: () => void
  /** The library folder currently open, revealed and preselected on mount. */
  current?: string | null
}) {
  const [roots, setRoots] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(current ?? null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .browseFs()
      .then((r) => {
        const dirs = r.dirs
        // A library outside every listed root (e.g. under /private) would be
        // unreachable in the tree. Add its top-level ancestor as a root so the
        // chain expands down to it with its siblings visible for context.
        if (current && !dirs.some((d) => onPathTo(d, current))) {
          const top = `/${current.split('/').filter(Boolean)[0] ?? ''}`
          setRoots([top, ...dirs])
        } else {
          setRoots(dirs)
        }
      })
      .catch((e) => setError(String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

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
              reveal={current}
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
