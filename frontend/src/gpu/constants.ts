/** Hue-band geometry for the colour mixer, mirroring engine/ops/color.py.
 *
 *  The single copy in the frontend: the shader needs the centers to weight the
 *  bands, and the develop panel needs them to paint the slider rails. Two
 *  copies of a number that has to agree with the server is already one too
 *  many.
 */

/** Order matters — the engine composes the bands in sequence, and each one
 *  sees the saturation the previous ones left behind. */
export const HSL_CHANNEL_ORDER = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta',
] as const

export type HslChannelName = (typeof HSL_CHANNEL_ORDER)[number]

/** Channel centers on the hue wheel, in degrees (Lightroom's 8 bands). */
export const HUE_CENTERS: Record<HslChannelName, number> = {
  red: 0,
  orange: 30,
  yellow: 60,
  green: 120,
  aqua: 180,
  blue: 240,
  purple: 280,
  magenta: 320,
}

/** Degrees of influence falloff on each side of a band center. */
export const BAND_WIDTH = 45

/** The mixer's hue slider is a relative shift and the engine caps it at
 *  +-30 degrees around the band center (the `30 / 360` in apply_color). */
export const HSL_HUE_RANGE = 30

/** Rec.709 luma weights, as used everywhere in the engine. */
export const LUMA_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722]
