/** The one contract every decode path produces.
 *
 * Mirrors what `engine/decode.py::decode_linear` returns on the server: float32
 * linear RGB in [0,1] (RAW keeps whatever highlight headroom it decoded to),
 * three channels interleaved, row-major. Everything downstream — downscale,
 * source encoding, the GPU renderer — assumes exactly this.
 */
export interface LinearImage {
  width: number
  height: number
  /** width * height * 3 floats, RGB interleaved. */
  data: Float32Array
}

/** Extensions LibRaw handles. Kept in sync with `config.py::RAW_EXTENSIONS`. */
const RAW_EXTENSIONS = new Set([
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'raf', 'orf', 'rw2',
  'dng', 'pef', 'srw', 'x3f', '3fr', 'erf', 'kdc', 'mrw', 'iiq',
])

/** Extensions the browser decodes natively, no wasm involved. */
const BITMAP_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'])

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function isRaw(name: string): boolean {
  return RAW_EXTENSIONS.has(extensionOf(name))
}

/**
 * Whether we can decode this at all.
 *
 * TIFF and HEIC are in the server's `NON_RAW_EXTENSIONS` but no browser
 * decodes either through `createImageBitmap`, so they are unsupported here
 * rather than silently broken. Sigma X3F is nominally RAW but LibRaw-wasm
 * cannot decode Foveon in this build — it is listed as RAW so the file is
 * still catalogued, and the decode reports its own failure.
 */
export function isSupported(name: string): boolean {
  const ext = extensionOf(name)
  return RAW_EXTENSIONS.has(ext) || BITMAP_EXTENSIONS.has(ext)
}
