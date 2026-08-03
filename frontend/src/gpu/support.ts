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

/** Everything the shader reproduces exactly. Retouch and grain are later
 *  stages and are absent on purpose.
 *
 *  `masks` is absent from this list for the same reason `color.lut` is: the
 *  shader draws most of them and cannot draw all of them, so whether a recipe
 *  qualifies depends on the mask objects themselves rather than on the field
 *  existing — see `masksAreDrawable`.
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
  const paths = [...IMPLEMENTED]
  const lut = recipe.color?.lut
  if (lut && lutIsDrawable(lut, ctx)) paths.push(['color', 'lut'])
  if (masksAreDrawable(recipe.masks)) paths.push(['masks'])
  return isDefault(prune(recipe, paths), prune(RECIPE_DEFAULTS, paths))
}

/**
 * *Why* `gpuSupportsRecipe` said no: the dotted paths that are not at their
 * default and not on the allowlist.
 *
 * Purely for messages. The preview can shrug and show the original, but an
 * export has to refuse, and "this photo needs retouch, which only the desktop
 * app renders" is a sentence a photographer can act on where "unsupported
 * recipe" is not. Returns [] exactly when `gpuSupportsRecipe` returns true.
 */
export function gpuSupportGaps(recipe: any, ctx: SupportContext = {}): string[] {
  if (!recipe || typeof recipe !== 'object') return ['recipe']
  const paths = [...IMPLEMENTED]
  const lut = recipe.color?.lut
  if (lut && lutIsDrawable(lut, ctx)) paths.push(['color', 'lut'])
  if (masksAreDrawable(recipe.masks)) paths.push(['masks'])
  return gaps(prune(recipe, paths), prune(RECIPE_DEFAULTS, paths), [])
}

/** Descend while both sides are plain objects, so the answer is as specific as
 *  the recipe allows — `detail.sharpening`, not `detail`. */
function gaps(value: any, def: any, prefix: string[]): string[] {
  if (isDefault(value, def)) return []
  const here = prefix.join('.') || 'recipe'
  const plain = (v: any) => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!plain(value) || !plain(def)) return [here]
  const out: string[] = []
  for (const k of Object.keys(value)) out.push(...gaps(value[k], def[k], [...prefix, k]))
  return out.length ? out : [here]
}

// ---- stage 4 -------------------------------------------------------------

/** Every key `LocalAdjustments` has, and every key each mask type has on top
 *  of `MaskBase`. Spelled out rather than derived, because this is the check
 *  that has to fail closed when the schema grows a field this build has never
 *  heard of — the same rule `isDefault` follows for the rest of the recipe. */
const LOCAL_ADJUSTMENT_KEYS = new Set([
  'exposure', 'contrast', 'highlights', 'shadows', 'temp', 'tint',
  'saturation', 'clarity', 'dehaze', 'sharpness',
])

const MASK_BASE_KEYS = ['type', 'name', 'invert', 'opacity', 'adjustments']

const MASK_KEYS: Record<string, string[]> = {
  linear: ['start', 'end'],
  radial: ['center', 'radiusX', 'radiusY', 'feather'],
  luminance: ['lumMin', 'lumMax', 'feather'],
  color: ['hue', 'range'],
  brush: ['strokes'],
}

const STROKE_KEYS = new Set(['points', 'radius', 'feather', 'flow', 'erase'])

const isNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)

/** A [x, y] pair, as every mask coordinate in the schema is. */
const isPoint = (v: any): boolean => Array.isArray(v) && v.length === 2 && v.every(isNum)

/** Only keys in `allowed` are present, and nothing is undefined-but-listed. */
const onlyKeys = (obj: any, allowed: Set<string>): boolean =>
  typeof obj === 'object' && obj !== null && !Array.isArray(obj) &&
  Object.keys(obj).every((k) => allowed.has(k))

/**
 * Can the shader draw every mask in this list?
 *
 * An allowlist per type, not a blocklist: a mask whose `type` this build does
 * not recognize, or which carries a field it does not know how to draw, sends
 * the whole recipe to the fallback. The two that will never pass:
 *
 *   - AI masks (`subject` / `background` / `sky`). `ops/ai_masks.py` runs
 *     U2-Net when the ml extra is installed and a multi-stage saliency
 *     heuristic when it is not — a segmentation network and a global
 *     thresholding pass respectively. Neither is a fragment shader's kind of
 *     work, and an *approximate* subject mask is exactly the failure this
 *     module exists to prevent: it would put the right adjustment on the wrong
 *     pixels, confidently.
 *   - anything with `retouch` set, which is refused by `RECIPE_DEFAULTS`
 *     rather than here, because retouch is not a mask.
 */
function masksAreDrawable(masks: any): boolean {
  if (masks === undefined) return true
  if (!Array.isArray(masks)) return false
  return masks.every(maskIsDrawable)
}

function maskIsDrawable(mask: any): boolean {
  if (typeof mask !== 'object' || mask === null || Array.isArray(mask)) return false
  const extra = MASK_KEYS[mask.type]
  if (!extra) return false // AI masks and anything newer than this build
  if (!onlyKeys(mask, new Set([...MASK_BASE_KEYS, ...extra]))) return false
  if (mask.name !== undefined && mask.name !== null && typeof mask.name !== 'string') return false
  if (mask.invert !== undefined && typeof mask.invert !== 'boolean') return false
  if (mask.opacity !== undefined && !isNum(mask.opacity)) return false
  if (mask.adjustments !== undefined) {
    const adj = mask.adjustments
    if (!onlyKeys(adj, LOCAL_ADJUSTMENT_KEYS)) return false
    if (!Object.values(adj).every(isNum)) return false
  }
  switch (mask.type) {
    case 'linear':
      return isPoint(mask.start) && isPoint(mask.end)
    case 'radial':
      return (
        isPoint(mask.center) && isNum(mask.radiusX) && isNum(mask.radiusY) &&
        mask.radiusX > 0 && mask.radiusY > 0 &&
        (mask.feather === undefined || isNum(mask.feather))
      )
    case 'luminance':
      return [mask.lumMin, mask.lumMax, mask.feather].every((v) => v === undefined || isNum(v))
    case 'color':
      // `range` divides in the weight, and the schema's `ge=5` keeps it away
      // from zero; a recipe that got past the schema anyway must not.
      return isNum(mask.hue) && isNum(mask.range) && mask.range > 0
    case 'brush':
      return Array.isArray(mask.strokes) && mask.strokes.length > 0 &&
        mask.strokes.every(strokeIsDrawable)
    default:
      return false
  }
}

function strokeIsDrawable(stroke: any): boolean {
  if (!onlyKeys(stroke, STROKE_KEYS)) return false
  if (!Array.isArray(stroke.points) || stroke.points.length === 0) return false
  if (!stroke.points.every(isPoint)) return false
  if (stroke.radius !== undefined && (!isNum(stroke.radius) || stroke.radius <= 0)) return false
  if (stroke.erase !== undefined && typeof stroke.erase !== 'boolean') return false
  return [stroke.feather, stroke.flow].every((v) => v === undefined || isNum(v))
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
