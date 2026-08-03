/** Choosing a library folder, and — the part that is easy to get wrong —
 *  getting it back after a reload.
 *
 *  A `FileSystemDirectoryHandle` survives being stored in IndexedDB, but the
 *  *permission* on it does not: on a fresh page load the handle is valid and
 *  every read throws. So restoring is always two steps, query then request,
 *  and the request half needs a user gesture. `restoreLibrary()` therefore
 *  only queries; `regrantLibrary()` is the one you call from a click.
 */

import { idbDelete, idbGet, idbSet } from './idb'

const HANDLE_KEY = 'library-handle'

export function fileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/** Show the picker and remember what was chosen. Must be called from a user
 *  gesture; rejects (AbortError) if the user cancels. */
export async function pickLibrary(): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker({
    mode: 'readwrite',
    // Chromium reopens at the last place this id was used, which for a photo
    // library is nearly always the right guess.
    id: 'viberoom-library',
    startIn: 'pictures',
  })
  await idbSet(HANDLE_KEY, handle)
  return handle
}

/** The remembered handle if it is still usable *without* prompting, else null.
 *  A stored-but-unpermitted handle comes back as null on purpose: the caller
 *  should render a "reconnect" button rather than a broken library. */
export async function restoreLibrary(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY)
  if (!handle) return null
  const state = await handle.queryPermission({ mode: 'readwrite' })
  return state === 'granted' ? handle : null
}

/** True if a handle is stored but currently needs the user to re-grant it. */
export async function libraryNeedsPermission(): Promise<boolean> {
  const handle = await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY)
  if (!handle) return false
  return (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted'
}

/** Re-prompt for the stored handle. User gesture required. */
export async function regrantLibrary(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY)
  if (!handle) return null
  if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return null
  return handle
}

export function forgetLibrary(): Promise<void> {
  return idbDelete(HANDLE_KEY)
}
