import { useEffect, useState } from 'react'
import { api } from './api'

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
    api
      .nativePickerAvailable()
      .then((r) => setAvailable(r.available))
      .catch(() => setAvailable(false))
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
