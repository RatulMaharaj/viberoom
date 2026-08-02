/** Live sidecar-change events from the backend (agent/manual edits on disk).
 * Subscribe with a callback receiving the affected image ids. */

type Listener = (imageIds: string[]) => void

let source: EventSource | null = null
const listeners = new Set<Listener>()

function ensureSource() {
  if (source) return
  source = new EventSource('/api/v1/events')
  source.addEventListener('sidecar', (e) => {
    try {
      const ids = JSON.parse((e as MessageEvent).data) as string[]
      listeners.forEach((l) => l(ids))
    } catch {
      // ignore malformed events
    }
  })
  // EventSource auto-reconnects on error; nothing to do
}

export function onSidecarChange(listener: Listener): () => void {
  listeners.add(listener)
  ensureSource()
  return () => {
    listeners.delete(listener)
  }
}
