import { useEffect, useState } from 'react'
import { api } from './api'
import { getSource } from './source'

/** Native OS folder dialog, when the server can offer one.
 *
 * The browser can never hand us an absolute path — `showDirectoryPicker()`
 * returns an opaque handle — so the dialog is opened server-side and only
 * makes sense while the server shares a desktop with you. Callers fall back
 * to the in-app tree picker when `available` is false.
 */
export function useFolderChooser() {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    let alive = true
    // Ask the source first. With no backend this endpoint answers with the app
    // shell rather than a 404, so probing it unconditionally means a failed
    // JSON parse on every load of the PWA — noise that looks like a fault.
    getSource()
      .then((s) => {
        if (!alive || s.kind !== 'server') return
        return api
          .nativePickerAvailable()
          .then((r) => alive && setAvailable(r.available))
      })
      .catch(() => alive && setAvailable(false))
    return () => {
      alive = false
    }
  }, [])

  /** Returns the chosen path, or null if cancelled or unavailable. */
  const choose = async (start?: string | null): Promise<string | null> => {
    if (!available) return null
    try {
      const r = await api.nativePicker(start)
      return r.cancelled ? null : r.path
    } catch {
      return null
    }
  }

  return { available, choose }
}
