/** Formats the browser cannot open, and why.
 *
 *  Everything here decodes perfectly well in the Python package — this is a
 *  gap in the WebAssembly build of LibRaw, not in the format support of
 *  viberoom. Stating it up front beats letting someone find out when a
 *  thumbnail never arrives, and it lets export refuse before it writes a file
 *  rather than after.
 *
 *  Keep this list short and honest. A format belongs here only once it has
 *  actually been observed to fail — a guess that turns out to be wrong hides a
 *  working file behind a warning, which is the same disservice in reverse.
 */

/** Extension -> the reason, phrased for someone who just wants their photo. */
const LOCAL_UNSUPPORTED: Record<string, string> = {
  // Sigma's Foveon sensor stacks three colour layers per pixel instead of
  // using a Bayer mosaic, and LibRaw decodes it through a separate body of
  // code that the WebAssembly build leaves out. Verified against a real file:
  // Python reads it, the browser does not.
  '.x3f': 'Sigma Foveon files need the desktop app',
}

/** Why this file cannot be opened here, or null if it can. */
export function unsupportedReason(filename: string): string | null {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return null
  return LOCAL_UNSUPPORTED[filename.slice(dot).toLowerCase()] ?? null
}

export const isLocallyUnsupported = (filename: string): boolean =>
  unsupportedReason(filename) !== null
