const KEY = 'viberoom.lastImage'

export function loadLastImage(): string | null {
  return sessionStorage.getItem(KEY)
}

export function saveLastImage(id: string | null): void {
  if (id) sessionStorage.setItem(KEY, id)
  // report to the backend so agents can target "the image I'm looking at"
  fetch('/api/v1/session/current', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_id: id }),
  }).catch(() => {})
}
