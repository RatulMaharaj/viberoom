import { useEffect, useState } from 'react'
import { api } from './api'
import { useSourceMode } from './stores/source'

/** Native OS folder dialog, when the server can offer one.
 *
 * The browser can never hand us an absolute path — `showDirectoryPicker()`
 * returns an opaque handle — so the dialog is opened server-side and only
 * makes sense while the server shares a desktop with you. Callers fall back
 * to the in-app tree picker when `available` is false.
 */
export function useFolderChooser() {
  const mode = useSourceMode()
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    // Only once we know there is a server. With no backend this endpoint
    // answers with the app shell rather than a 404, so probing it means a
    // failed JSON parse on every load of the PWA — noise that looks like a
    // fault.
    if (mode !== 'server') return
    let alive = true
    api
      .nativePickerAvailable()
      .then((r) => alive && setAvailable(r.available))
      .catch(() => alive && setAvailable(false))
    return () => {
      alive = false
    }
  }, [mode])

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
