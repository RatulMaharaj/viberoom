import { getSource } from './source'

const KEY = 'viberoom.lastImage'

export function loadLastImage(): string | null {
  return sessionStorage.getItem(KEY)
}

let timer: ReturnType<typeof setTimeout> | null = null
let pending: string | null = null

function flush(): void {
  if (!timer) return
  clearTimeout(timer)
  timer = null
  const id = pending
  // Only the server cares. This exists so an agent driving the REST API can
  // ask about "the image I'm looking at"; with no backend there is nobody to
  // tell, and a static host answers the PUT with a 501 on every arrow key.
  getSource()
    .then((s) => {
      if (s.kind !== 'server') return
      return fetch('/api/v1/session/current', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_id: id }),
        keepalive: true,
      })
    })
    .catch(() => {})
}

// a held arrow key steps the selection every few ms; only the last one matters
window.addEventListener('pagehide', flush)

export function saveLastImage(id: string | null): void {
  if (id) sessionStorage.setItem(KEY, id)
  // report to the backend so agents can target "the image I'm looking at"
  pending = id
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 250)
}
