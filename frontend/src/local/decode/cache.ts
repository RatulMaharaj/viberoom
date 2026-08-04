/** LRU of decoded linear frames, bounded by total bytes.
 *
 * Port of `engine/cache.py::DecodeCache`, and bounded the same way for the same
 * reason: entry-count bounding made browsing pathological, because two entries
 * meant a third image evicted the first and paging back and forth through a
 * filmstrip re-ran LibRaw every single time. Frame sizes vary by two orders of
 * magnitude between a small JPEG and a full-size RAW, so bytes are the only
 * budget that means anything.
 *
 * It matters more in a tab than it did on the server. A 24 MP decode is ~290 MB
 * of float32 and a browser will kill the tab rather than swap, so the budget is
 * a fraction of the server's default.
 */

import type { LinearImage } from './types.ts'

/** Full-resolution decodes, which are enormous: 197 MB for a Canon CR3, 524 MB
 *  for a Nikon Z7, 698 MB for a Sony ARW. Only one is ever wanted at a time —
 *  a full decode exists to produce a preview-sized frame and is not needed
 *  again until export — so this is sized to hold roughly one, and the
 *  keep-what-was-just-inserted rule does the rest. */
const DEFAULT_MAX_BYTES = 384 * 1024 * 1024

/** Preview-sized frames, which are small: a 2048px frame is ~32 MB. These are
 *  what makes going back to a photo instant, so they get the larger share and
 *  a separate budget.
 *
 *  Sharing one budget with the full decodes was the bug: producing a single
 *  preview allocated several hundred megabytes and evicted every frame worth
 *  keeping, so arrowing back through a filmstrip re-ran LibRaw every time. */
const FRAME_MAX_BYTES = 512 * 1024 * 1024

export class DecodeCache {
  private store = new Map<string, LinearImage>()
  private bytes = 0
  private maxBytes: number

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes
  }

  /** Decoded frame for `key`, running `decode` only on a miss.
   *
   * In-flight decodes are not deduplicated here — the caller owns request
   * lifetimes (an abandoned loupe navigation should not keep a decode alive),
   * and a duplicate decode is merely slow, whereas a shared promise that
   * outlives its abort is a leak. */
  async get(key: string, decode: () => Promise<LinearImage>): Promise<LinearImage> {
    const hit = this.store.get(key)
    if (hit) {
      // Map preserves insertion order, so re-inserting is the whole of "touch".
      this.store.delete(key)
      this.store.set(key, hit)
      return hit
    }
    const img = await decode()
    this.put(key, img)
    return img
  }

  put(key: string, img: LinearImage): void {
    const existing = this.store.get(key)
    if (existing) {
      this.store.delete(key)
      this.bytes -= existing.data.byteLength
    }
    this.store.set(key, img)
    this.bytes += img.data.byteLength
    // Always keep the entry just inserted, even if it alone busts the budget —
    // evicting it would mean decoding it again immediately.
    while (this.bytes > this.maxBytes && this.store.size > 1) {
      const oldest = this.store.keys().next().value as string
      this.bytes -= this.store.get(oldest)!.data.byteLength
      this.store.delete(oldest)
    }
  }

  clear(): void {
    this.store.clear()
    this.bytes = 0
  }

  get residentMb(): number {
    return this.bytes / (1024 * 1024)
  }
}

export const decodeCache = new DecodeCache()

/** Preview-sized frames. Separate from `decodeCache` on purpose — see the
 *  budgets above. */
export const frameCache = new DecodeCache(FRAME_MAX_BYTES)

/**
 * Cache identity for a file.
 *
 * `lastModified` is in here for the same reason the server keys on mtime: an
 * edited file reusing a stale decode is a wrong picture, not a stale one. Size
 * disambiguates the same-name-same-tick case that a millisecond timestamp
 * cannot.
 */
export function fileKey(file: File, suffix = ''): string {
  return `${file.name}|${file.size}|${file.lastModified}${suffix}`
}
