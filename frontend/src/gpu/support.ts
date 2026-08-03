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

/** Everything the shader reproduces exactly. Masks, retouch and grain are
 *  later stages and are absent on purpose.
 *
 *  `lens.defringe` is absent too, and permanently: it thresholds on
 *  `np.percentile(edge, 99)` taken over the entire frame. A fragment shader
 *  cannot reduce over the frame it is drawing, and a sampled or approximated
 *  percentile picks a different threshold, which moves the mask — so the rest
 *  of `lens` is implemented and defringe alone forces the fallback.
 *
 *  `color.lut` is conditional rather than listed, since whether the shader can
 *  draw it depends on whether the *data* is loaded — see `gpuSupportsRecipe`.
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
  ['lens', 'distortion'],
  ['lens', 'vignette'],
  ['lens', 'caRed'],
  ['lens', 'caBlue'],
  ['geometry', 'rotate'],
  ['geometry', 'orientation'],
  ['geometry', 'flipH'],
  ['geometry', 'flipV'],
  ['geometry', 'perspective'],
  ['geometry', 'crop'],
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

/** What the caller knows about the LUT the renderer is currently holding. */
export interface SupportContext {
  /** True when this renderer has been handed the named LUT's data via
   *  `GpuRenderer.setLut`. Absent means "no LUTs are available", which is the
   *  safe default: the engine would find the file and apply it, so a shader
   *  that cannot is a wrong preview, not a slow one. */
  hasLut?: (name: string) => boolean
}

/**
 * Can the shader draw this recipe faithfully?
 *
 * The vignette used to be a caveat here — the engine applies it *after*
 * geometry, so it tracks the cropped frame, and a shader with no crop was only
 * consistent because crops were rejected outright. Both stages now exist and
 * run in that order, so the two agree for real rather than by exclusion.
 *
 * The LUT is the one op whose support is not a property of the recipe alone.
 * The engine resolves `lut.name` against `~/.viberoom/luts`; the renderer has
 * no filesystem and is handed LUT *data* instead. So a recipe naming a LUT is
 * drawable only if the caller confirms that renderer holds it.
 */
export function gpuSupportsRecipe(recipe: any, ctx: SupportContext = {}): boolean {
  if (!recipe || typeof recipe !== 'object') return false
  const lut = recipe.color?.lut
  const paths = lut && lutIsDrawable(lut, ctx) ? [...IMPLEMENTED, ['color', 'lut']] : IMPLEMENTED
  return isDefault(prune(recipe, paths), prune(RECIPE_DEFAULTS, paths))
}

/** A LUT the shader can draw: either one that does nothing, or one whose data
 *  the renderer actually has. */
function lutIsDrawable(lut: any, ctx: SupportContext): boolean {
  if (typeof lut !== 'object' || lut === null) return false
  if (lut.stage !== undefined && lut.stage !== 'pre' && lut.stage !== 'post') return false
  // A missing name or zero strength is `apply_lut`'s own no-op, whatever the
  // other fields say.
  if (!lut.name || lut.strength === 0) return true
  return typeof lut.name === 'string' && ctx.hasLut?.(lut.name) === true
}
