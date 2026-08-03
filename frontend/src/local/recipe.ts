/** The neutral recipe, and the two operations the edit panel needs on it.
 *
 *  This is `Recipe().model_dump()` from `recipe/schema.py` transcribed. It has
 *  to be a literal rather than "everything is zero", because several defaults
 *  are not zero (sharpening radius 1, grading blending 50, crop right/bottom 1)
 *  and a wrong default would read as an edit the user never made.
 *
 *  Nothing here validates ranges — that is the schema's job on the server, and
 *  clamping silently in the browser would hide a real bug rather than fix it.
 */

const hsl = () => ({ hue: 0, saturation: 0, luminance: 0 })
const curve = () => [
  [0, 0],
  [255, 255],
]

export function defaultRecipe(): Record<string, any> {
  return {
    lens: { distortion: 0, vignette: 0, caRed: 0, caBlue: 0, defringe: { amount: 0 } },
    whiteBalance: { temp: null, tint: 0 },
    tone: {
      exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
      texture: 0, clarity: 0, dehaze: 0,
      toneCurve: { points: curve(), red: curve(), green: curve(), blue: curve() },
    },
    color: {
      saturation: 0,
      vibrance: 0,
      hsl: {
        red: hsl(), orange: hsl(), yellow: hsl(), green: hsl(),
        aqua: hsl(), blue: hsl(), purple: hsl(), magenta: hsl(),
      },
      grading: {
        shadows: hsl(), midtones: hsl(), highlights: hsl(),
        blending: 50, balance: 0,
      },
      lut: { name: null, strength: 100, stage: 'post' },
    },
    detail: {
      sharpening: { amount: 0, radius: 1, detail: 25 },
      noiseReduction: { luminance: 0, color: 0 },
    },
    geometry: {
      rotate: 0, orientation: 0, flipH: false, flipV: false,
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
}

const isPlainObject = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** PATCH semantics: nested objects merge, arrays and scalars replace. Matches
 *  what the server's recipe PATCH does, so a partial slider update from the
 *  edit panel means the same thing in both modes. */
export function mergeRecipe(
  base: Record<string, any>,
  patch: Record<string, any>,
): Record<string, any> {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? mergeRecipe(base[k], v) : v
  }
  return out
}

/** Structural equality, used only to decide `has_edits`. */
export function recipeEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => recipeEquals(x, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => k in b && recipeEquals(a[k], b[k]))
  }
  return false
}

export const hasEdits = (recipe: unknown): boolean => !recipeEquals(recipe, defaultRecipe())
