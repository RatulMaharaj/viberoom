/** Global undo/redo stack for edit actions (recipe changes, ratings, flags).
 * Each entry knows how to undo and redo itself against the API; pages call
 * undo()/redo() from their Cmd/Ctrl+Z handlers and then refresh their state. */

interface Entry {
  undo: () => Promise<unknown>
  redo: () => Promise<unknown>
}

const undoStack: Entry[] = []
const redoStack: Entry[] = []
const MAX = 200

export function pushAction(entry: Entry): void {
  undoStack.push(entry)
  if (undoStack.length > MAX) undoStack.shift()
  redoStack.length = 0
}

export async function undo(): Promise<boolean> {
  const e = undoStack.pop()
  if (!e) return false
  await e.undo()
  redoStack.push(e)
  return true
}

export async function redo(): Promise<boolean> {
  const e = redoStack.pop()
  if (!e) return false
  await e.redo()
  undoStack.push(e)
  return true
}

/** Convenience: handle a keydown, returns true if it consumed the event.
 * Undo: Cmd/Ctrl+Z. Redo: Cmd/Ctrl+Shift+Z or Ctrl+Y. */
export async function handleUndoKey(e: KeyboardEvent): Promise<boolean> {
  if (!(e.metaKey || e.ctrlKey)) return false
  const k = e.key.toLowerCase()
  if (k === 'y') {
    e.preventDefault()
    return redo()
  }
  if (k === 'z') {
    e.preventDefault()
    return e.shiftKey ? redo() : undo()
  }
  return false
}
