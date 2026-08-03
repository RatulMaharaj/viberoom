/** Fetching the decoded linear frame the renderer draws from. */

export type SourceFormat = 'rgb9e5' | 'rgba16f'

export interface SourceFrame {
  width: number
  height: number
  format: SourceFormat
  data: ArrayBuffer
}

const BASE = '/api/v1'

/**
 * Pull one image's source frame.
 *
 * The dimensions come from the response headers, never from a guess: the
 * server cuts the frame to the resolution it would have *rendered* the preview
 * at, which is neither the decode size nor the requested `size`.
 */
export async function fetchSource(
  imageId: string,
  size: number,
  format: SourceFormat = 'rgb9e5',
  signal?: AbortSignal,
): Promise<SourceFrame> {
  const r = await fetch(
    `${BASE}/images/${imageId}/source?size=${size}&format=${format}`,
    { signal },
  )
  if (!r.ok) throw new Error(`source ${r.status}`)
  const width = Number(r.headers.get('X-Source-Width'))
  const height = Number(r.headers.get('X-Source-Height'))
  if (!width || !height) throw new Error('source response is missing its dimensions')
  return {
    width,
    height,
    format: (r.headers.get('X-Source-Format') as SourceFormat) ?? format,
    data: await r.arrayBuffer(),
  }
}

export interface ServerFrame {
  url: string
  /** The server's own identity for these pixels (X-Recipe-Hash), used to pair
   *  a late-arriving render with the recipe that asked for it. */
  hash: string
  revoke: () => void
}

/**
 * Fetch a rendered preview as a blob URL, keeping its recipe hash.
 *
 * `<img src>` would be simpler, but it throws the response headers away, and
 * the hash is the only reliable way to tell which recipe a frame that just
 * landed actually depicts — responses do not arrive in the order they were
 * asked for.
 */
export async function fetchServerFrame(
  imageId: string,
  size: number,
  signal?: AbortSignal,
): Promise<ServerFrame> {
  // `cache: 'no-cache'` revalidates instead of reusing what is stored. The
  // preview URL does not change when the recipe does — the recipe is not in
  // it — and the endpoint answers with `Cache-Control: immutable`, which
  // licenses the browser to serve its copy without ever asking. So an edit
  // landed on the server and the tab kept showing the render from before it,
  // until a reload forced the question. The ETag still makes the common case
  // a 304, so revalidating is cheap; it is being skipped that was the problem.
  const r = await fetch(`${BASE}/images/${imageId}/preview?size=${size}`, {
    signal,
    cache: 'no-cache',
  })
  if (!r.ok) throw new Error(`preview ${r.status}`)
  const hash = r.headers.get('X-Recipe-Hash') ?? ''
  const url = URL.createObjectURL(await r.blob())
  return { url, hash, revoke: () => URL.revokeObjectURL(url) }
}
