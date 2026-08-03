/** Thumbnails for a list of images, as object URLs that get cleaned up.
 *
 *  The only React in this directory, and it earns its place: both the grid and
 *  the filmstrip need exactly this, and the part that is easy to get wrong —
 *  revoking every URL when the list changes — is worth writing once. A leaked
 *  `blob:` holds its whole JPEG until the tab closes.
 *
 *  Server mode never calls this. There `api.thumbnailUrl(id)` is a plain URL
 *  the browser fetches like any other image, with no lifetime to manage, and
 *  routing it through here would replace a cached HTTP GET with a decode.
 */

import { useEffect, useState } from 'react'
import type { ImageMeta, PhotoSource, SourceUrl } from '../source'

/** Concurrent resolutions. The source throttles decoding itself; this only
 *  keeps the queue in view-order so the top of the grid fills in first. */
const LANES = 4

/** How long results are pooled before a render. One `setState` per thumbnail
 *  would re-render a 500-card grid 500 times. */
const FLUSH_MS = 120

export function useThumbnails(
  source: PhotoSource | null,
  images: ImageMeta[],
  enabled: boolean,
): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({})
  // The identity of `images` changes on every list, but its *contents* are
  // what this depends on.
  const key = images.map((im) => im.id).join(',')

  useEffect(() => {
    if (!enabled || !source) return
    let cancelled = false
    const held: SourceUrl[] = []
    const ids = key ? key.split(',') : []
    let pending: Record<string, string> = {}
    let timer: ReturnType<typeof setTimeout> | undefined

    const flush = () => {
      timer = undefined
      if (cancelled || !Object.keys(pending).length) return
      const batch = pending
      pending = {}
      setUrls((prev) => ({ ...prev, ...batch }))
    }

    const queue = [...ids]
    const lane = async () => {
      for (;;) {
        const id = queue.shift()
        if (id === undefined || cancelled) return
        const got = await source.thumbnail(id).catch(() => null)
        if (!got) continue
        if (cancelled) {
          got.release()
          return
        }
        held.push(got)
        pending[id] = got.url
        timer ??= setTimeout(flush, FLUSH_MS)
      }
    }
    void Promise.all(Array.from({ length: LANES }, lane)).then(flush)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      held.forEach((u) => u.release())
      // The URLs above are dead now, so the map has to go with them — an
      // <img> still pointing at a revoked blob renders as a broken image.
      setUrls({})
    }
  }, [enabled, source, key])

  return urls
}
