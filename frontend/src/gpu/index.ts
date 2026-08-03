/** Client-side preview rendering: DOM + WebGL2 only, no framework.
 *
 *  React lives one level up, in components/GpuPreview.tsx and
 *  hooks/useGpuPreview.ts. Keeping the boundary here means the renderer can be
 *  driven from a bare page or a headless harness.
 */

export { detectGpuSupport, gpuEnabled, gpuOverride } from './capability'
export { BAND_WIDTH, HSL_CHANNEL_ORDER, HSL_HUE_RANGE, HUE_CENTERS, LUMA_WEIGHTS } from './constants'
export type { HslChannelName } from './constants'
export { createLiveRecipe, publish, setAt } from './live'
export type { LiveRecipe } from './live'
export { LutError, parseCube } from './lut'
export type { LutData } from './lut'
export { GpuRenderer, GpuUnavailable } from './renderer'
export { fetchServerFrame, fetchSource } from './source'
export type { ServerFrame, SourceFrame, SourceFormat } from './source'
export { gpuSupportsRecipe } from './support'
export type { SupportContext } from './support'
export { buildUniforms } from './uniforms'
export type {
  DetailUniforms,
  FrameInfo,
  GaussPass,
  GeomPass,
  GeometryUniforms,
  LensUniforms,
  LutUniforms,
  PresencePass,
  Uniforms,
} from './uniforms'
