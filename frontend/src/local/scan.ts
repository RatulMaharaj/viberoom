/** Walking a library folder, mirroring `catalog/scanner.py`'s `scan()`.
 *
 *  The Python scanner feeds a SQLite catalog; that catalog is explicitly
 *  disposable, so we do not reimplement it. The listing is derived from the
 *  folder on every open and held in memory — sidecars remain the truth.
 */

import { imageId } from './ids'

// Kept in lockstep with IMAGE_EXTENSIONS in src/viberoom/config.py.
export const RAW_EXTENSIONS = new Set([
  '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.raf', '.orf', '.rw2',
  '.dng', '.pef', '.srw', '.x3f', '.3fr', '.erf', '.kdc', '.mrw', '.iiq',
])
export const NON_RAW_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic', '.webp',
])
export const IMAGE_EXTENSIONS = new Set([...RAW_EXTENSIONS, ...NON_RAW_EXTENSIONS])

export const SIDECAR_SUFFIX = '.vibe.json'

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

export function isRaw(name: string): boolean {
  return RAW_EXTENSIONS.has(extOf(name))
}

/** One photo found on disk. `dir` is kept so sidecars can be written back
 *  without re-walking, and `handle` so the bytes can be opened lazily. */
export interface ScannedFile {
  id: string
  relPath: string
  filename: string
  ext: string
  isRaw: boolean
  dir: FileSystemDirectoryHandle
  handle: FileSystemFileHandle
}

/** Recursive walk. Skips dotted names and `exports/` exactly as the Python
 *  scanner does, so both modes see *almost* the same set of photos.
 *
 *  The exception is symlinks, and it is not fixable here: Chrome's directory
 *  iterator does not yield them at all — not as a file, not as a directory,
 *  not as an error — while Python's `os.walk` follows them. A folder of
 *  aliases pointing at photos elsewhere is empty to this walk and full to the
 *  server's. Confirmed in Chrome against a folder of 7 symlinked RAWs and 2
 *  real PNGs: only the 2 came back.
 *
 *  There is no count to report, because a skipped entry never reaches this
 *  loop to be counted. Do not spend an hour looking for one. It bites test
 *  folders and libraries assembled from aliases, not ordinary photo folders. */
export async function walkLibrary(
  root: FileSystemDirectoryHandle,
  prefix = '',
): Promise<ScannedFile[]> {
  const found: ScannedFile[] = []
  for await (const entry of root.values()) {
    if (entry.name.startsWith('.')) continue
    if (entry.kind === 'directory') {
      if (entry.name === 'exports') continue
      found.push(
        ...(await walkLibrary(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`)),
      )
      continue
    }
    if (entry.name.endsWith(SIDECAR_SUFFIX)) continue
    const ext = extOf(entry.name)
    if (!IMAGE_EXTENSIONS.has(ext)) continue
    const relPath = prefix + entry.name
    found.push({
      id: await imageId(relPath),
      relPath,
      filename: entry.name,
      ext,
      isRaw: RAW_EXTENSIONS.has(ext),
      dir: root,
      handle: entry as FileSystemFileHandle,
    })
  }
  return found
}
