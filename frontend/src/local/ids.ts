/** Image ids, byte-for-byte compatible with `catalog/scanner.py`.
 *
 *  The server hashes the library-relative path, so the same photo keeps the
 *  same id whether it was catalogued by Python or walked by the browser —
 *  which is what lets a bookmarked /edit/<id> survive the switch.
 */

/** sha1(rel_path) truncated to 16 hex chars — `hashlib.sha1(...)[:16]`. */
export async function imageId(relPath: string): Promise<string> {
  const bytes = new TextEncoder().encode(relPath)
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  let hex = ''
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0')
  return hex.slice(0, 16)
}
