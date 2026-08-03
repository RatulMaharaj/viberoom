/** RAW decode in the browser, via LibRaw compiled to wasm.
 *
 * `libraw-wasm` runs the decode in its own Web Worker, so a 24 MP RAW — which
 * takes seconds — never blocks the UI thread. The only work done here is the
 * uint16 -> float32 conversion, which is a fraction of the decode.
 */

import LibRaw from 'libraw-wasm'
import type { LibRawSettings } from 'libraw-wasm'
import type { LinearImage } from './types.ts'

/**
 * The settings that reproduce `engine/decode.py::decode_linear`, i.e. rawpy's
 * `use_camera_wb=True, no_auto_bright=True, output_bps=16, gamma=(1,1),
 * output_color=sRGB`.
 *
 * `gamm` MUST be six elements. LibRaw's Emscripten binding checks
 * `arr["length"] == 6` and silently drops anything else, so the two-element
 * form the README documents leaves the default gamma applied — you get
 * gamma-encoded pixels, no error, and a picture that looks merely "a bit
 * bright" rather than obviously wrong. The trailing four slots are LibRaw's
 * unused curve parameters and stay zero.
 */
const SETTINGS = {
  outputBps: 16,
  noAutoBright: true,
  useCameraWb: true,
  outputColor: 1, // rawpy ColorSpace.sRGB
  gamm: [1, 1, 0, 0, 0, 0], // linear
} as unknown as LibRawSettings // the .d.ts types gamm as a 2-tuple; see above

/** Just enough of LibRaw's surface to decode, so tests can stand in for it. */
export interface RawDecoder {
  open(bytes: BufferSource, settings?: LibRawSettings): Promise<void>
  imageData(): Promise<{ width: number; height: number; colors: number; bits: number; data: ArrayBufferView } | undefined>
  metadata(full?: boolean): Promise<Record<string, unknown> | undefined>
  dispose(): void
}

let makeDecoder: () => RawDecoder = () => new LibRaw() as unknown as RawDecoder

/** Swap the decoder factory. Exists so the conversion below can be exercised
 *  outside a browser, where `new Worker(...)` does not exist. */
export function setRawDecoderFactory(factory: () => RawDecoder): void {
  makeDecoder = factory
}

export class UnsupportedRawError extends Error {}

/**
 * Decode a RAW buffer to linear float32 RGB.
 *
 * Always full size: `halfSize` is accepted by this build of LibRaw and then
 * ignored, so asking for it would quietly return a full-size frame under a
 * half-size name. Callers that want less than everything downscale afterwards.
 */
export async function decodeRawBuffer(bytes: ArrayBuffer): Promise<LinearImage> {
  const decoder = makeDecoder()
  try {
    // The worker call transfers this buffer, detaching the caller's copy — a
    // second decode of the same File would otherwise fail on an empty buffer.
    await decoder.open(new Uint8Array(bytes.slice(0)), SETTINGS)
    const img = await decoder.imageData()
    if (!img) throw new UnsupportedRawError('LibRaw returned no image data')
    if (img.bits !== 16 || img.colors !== 3) {
      throw new UnsupportedRawError(`unexpected LibRaw output: ${img.bits}-bit, ${img.colors} channels`)
    }
    return {
      width: img.width,
      height: img.height,
      data: toLinear(new Uint16Array(img.data.buffer, img.data.byteOffset, img.data.byteLength / 2)),
    }
  } catch (e) {
    // Foveon (X3F) fails in here, and so does any format this LibRaw build
    // lacks a decompressor for. Both are "we cannot open this file", which the
    // caller must distinguish from a bug.
    if (e instanceof UnsupportedRawError) throw e
    throw new UnsupportedRawError(e instanceof Error ? e.message : String(e))
  } finally {
    // One worker per decode. Keeping instances alive pins the wasm heap at the
    // size of the largest image it ever held, which for RAW is hundreds of MB.
    decoder.dispose()
  }
}

/**
 * LibRaw's own metadata for a RAW buffer, or undefined if it cannot open it.
 *
 * Cheap, despite appearances: `open()` only parses the container — the unpack
 * and demosaic happen inside `imageData()`, which is never called here. It runs
 * in tens of milliseconds even on the Fuji file that takes ten seconds to
 * decode, which is what makes it usable as an EXIF fallback during a scan.
 */
export async function readRawMetadata(bytes: ArrayBuffer): Promise<Record<string, unknown> | undefined> {
  const decoder = makeDecoder()
  try {
    await decoder.open(new Uint8Array(bytes.slice(0)), SETTINGS)
    // fullOutput, only for `lens` — the eight fields the catalog wants include
    // the lens model, and the compact block leaves it out.
    return await decoder.metadata(true)
  } catch {
    return undefined
  } finally {
    decoder.dispose()
  }
}

function toLinear(px: Uint16Array): Float32Array {
  const out = new Float32Array(px.length)
  for (let i = 0; i < px.length; i++) out[i] = px[i] / 65535
  return out
}
