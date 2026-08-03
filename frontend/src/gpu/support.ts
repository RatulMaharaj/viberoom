/** Which recipes the client-side renderer is allowed to draw.
 *
 *  A wrong preview is far worse than a slow one, so this is an allowlist, not
 *  a blocklist: strip out every field the shader implements, and whatever is
 *  left must still be at its default. A recipe that trips over anything else —
 *  including a field added to the schema after this file was written — falls
 *  back to the server render. Getting a fallback wrong costs latency; getting
 *  an *approval* wrong shows the photographer pixels that are not their photo.
 */

/** Recipe defaults, mirroring recipe/schema.py. Only the shape and the values
 *  matter here — this is never rendered, only compared against. */
const CURVE = [
  [0, 0],
  [255, 255],
]

const HSL_CHANNEL = { hue: 0, saturation: 0, luminance: 0 }
const GRADE_BAND = { hue: 0, saturation: 0, luminance: 0 }

export const RECIPE_DEFAULTS: Record<string, any> = {
  lens: {
    distortion: 0,
    vignette: 0,
    caRed: 0,
    caBlue: 0,
    defringe: { amount: 0 },
  },
  whiteBalance: { temp: null, tint: 0 },
  tone: {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    texture: 0,
    clarity: 0,
    dehaze: 0,
    toneCurve: { points: CURVE, red: CURVE, green: CURVE, blue: CURVE },
  },
  color: {
    saturation: 0,
    vibrance: 0,
    hsl: {
      red: HSL_CHANNEL,
      orange: HSL_CHANNEL,
      yellow: HSL_CHANNEL,
      green: HSL_CHANNEL,
      aqua: HSL_CHANNEL,
      blue: HSL_CHANNEL,
      purple: HSL_CHANNEL,
      magenta: HSL_CHANNEL,
    },
    grading: {
      shadows: GRADE_BAND,
      midtones: GRADE_BAND,
      highlights: GRADE_BAND,
      blending: 50,
      balance: 0,
    },
    lut: { name: null, strength: 100, stage: 'post' },
  },
  detail: {
    sharpening: { amount: 0, radius: 1.0, detail: 25 },
    noiseReduction: { luminance: 0, color: 0 },
  },
  geometry: {
    rotate: 0,
    orientation: 0,
    flipH: false,
    flipV: false,
    perspective: { vertical: 0, horizontal: 0, scale: 100 },
    crop: { left: 0, top: 0, right: 1, bottom: 1 },
  },
  effects: {
    vignette: { amount: 0, midpoint: 50, feather: 50, roundness: 0 },
    grain: { amount: 0, size: 25 },
  },
  retouch: [],
  masks: [],
}

/** Everything the shader reproduces exactly. Geometry, LUTs, masks, retouch
 *  and grain are later stages and are absent on purpose.
 *
 *  So is `detail`, which the shader *does* implement — see shader.ts's gauss,
 *  NR and sharpen passes. Its radii are absolute pixel counts, so reproducing
 *  it needs `render_float`'s `scale`: the ratio of the preview frame to the
 *  full-resolution one. The source endpoint does not report that ratio and it
 *  cannot be recovered from the frame's own dimensions, so the renderer's
 *  `scale` is a default 1 and a sharpening radius would come out several times
 *  too wide on any downscaled preview. Wrong is worse than slow; detail stays
 *  on the server until the frame arrives with its scale attached, at which
 *  point this list is the only thing that has to change.
 */
const IMPLEMENTED: string[][] = [
  ['whiteBalance', 'temp'],
  ['whiteBalance', 'tint'],
  ['tone', 'exposure'],
  ['tone', 'contrast'],
  ['tone', 'highlights'],
  ['tone', 'shadows'],
  ['tone', 'whites'],
  ['tone', 'blacks'],
  ['tone', 'toneCurve'],
  ['tone', 'texture'],
  ['tone', 'clarity'],
  ['tone', 'dehaze'],
  ['color', 'saturation'],
  ['color', 'vibrance'],
  ['color', 'hsl'],
  ['color', 'grading'],
  ['effects', 'vignette'],
]

/** Deep clone with `paths` pruned out. */
function prune(value: any, paths: string[][]): any {
  if (paths.length === 0) return value
  const out: Record<string, any> = { ...value }
  const nested = new Map<string, string[][]>()
  for (const [head, ...rest] of paths) {
    if (rest.length === 0) delete out[head]
    else if (head in out) nested.set(head, [...(nested.get(head) ?? []), rest])
  }
  for (const [head, sub] of nested) out[head] = prune(out[head], sub)
  return out
}

/** True when `value` is indistinguishable from `def` — an absent key counts as
 *  default, an unrecognized one never does. */
function isDefault(value: any, def: any): boolean {
  if (value === undefined) return true
  if (def === undefined) return false // a field this build has never heard of
  if (Array.isArray(def) || Array.isArray(value)) {
    if (!Array.isArray(def) || !Array.isArray(value)) return false
    return value.length === def.length && value.every((v, i) => isDefault(v, def[i]))
  }
  if (value === null || def === null || typeof value !== 'object' || typeof def !== 'object') {
    return value === def
  }
  return Object.keys(value).every((k) => isDefault(value[k], def[k]))
}

/**
 * Can the shader draw this recipe faithfully?
 *
 * Note the vignette: the engine applies it *after* geometry, so it tracks the
 * cropped frame. The shader has no crop, which is only consistent because a
 * recipe with any crop is rejected here in the first place.
 */
export function gpuSupportsRecipe(recipe: any): boolean {
  if (!recipe || typeof recipe !== 'object') return false
  return isDefault(prune(recipe, IMPLEMENTED), prune(RECIPE_DEFAULTS, IMPLEMENTED))
}
