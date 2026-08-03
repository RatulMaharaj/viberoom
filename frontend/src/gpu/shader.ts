/** GLSL for the render pipeline.
 *
 *  `EDIT_SOURCE` is the pointwise half — a port of `render_float` in
 *  engine/pipeline.py, in its order:
 *    white balance -> exposure -> regions -> sRGB transfer -> contrast
 *    -> tone curve -> colour/HSL -> colour grading -> vignette
 *  Everything after it in this file is the multi-pass half: presence
 *  (dehaze/clarity/texture) and detail (noise reduction/sharpening), which
 *  cannot be pointwise because each reads a blurred copy of the frame.
 *
 *  The vignette is its own pass rather than the tail of the edit pass, because
 *  the engine applies it *after* presence and detail. Vignetting first would
 *  hand the blurs a darkened frame, and a large-radius clarity or dehaze blur
 *  spreads that darkening back inward — a visible halo, not a rounding error.
 *
 *  Stage 3 lives here too, in its own programs rather than in the edit pass,
 *  because none of it is pointwise in the same frame:
 *    - `LENS_SOURCE` runs *before* the edit pass, on linear light, and
 *      resamples the frame radially.
 *    - `GEOM_SOURCE` runs after detail and before the vignette, and is the one
 *      pass whose output is a different size from its input.
 *    - the LUT is the exception: it *is* pointwise, so it folds into the edit
 *      pass at one of two points (see `uLutStage`).
 *
 *  Stage 4 — the local adjustments of `engine/ops/masks.py` — lives at the
 *  bottom of this file, between geometry and the vignette, which is where
 *  `render_float` runs it. Retouch and grain are still absent, and so are AI
 *  masks; a recipe that uses any of them never reaches this shader (see
 *  support.ts).
 *
 *  Every formula below is transcribed from the corresponding op rather than
 *  re-derived, including the parts that look redundant. Where the Python
 *  short-circuits on a zero slider, the shader runs the expression anyway —
 *  it is the identity at zero, and a uniform branch per pixel buys nothing.
 */

import { BAND_WIDTH, HSL_CHANNEL_ORDER, HUE_CENTERS, LUMA_WEIGHTS } from './constants'

/** Entries in the tone-curve LUT. Has to be 1024 exactly: the engine indexes a
 *  1024-entry np.interp table with `int(v * 1023)`, and the shader reproduces
 *  that integer quantization rather than interpolating. */
export const CURVE_SIZE = 1024

/** Rows of the curve texture, in the order the engine applies them. */
export const CURVE_ROWS = 4

/** A fullscreen triangle from gl_VertexID alone — no buffers, no attributes. */
export const VERTEX_SOURCE = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const centers = HSL_CHANNEL_ORDER.map((n) => HUE_CENTERS[n].toFixed(1)).join(', ')
const luma = LUMA_WEIGHTS.map((w) => w.toString()).join(', ')

export const EDIT_SOURCE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uSource;
uniform sampler2D uCurves;
uniform highp sampler3D uLut3;
uniform sampler2D uLut1;

uniform vec3  uWbGain;
uniform float uExposure;      // EV stops
uniform vec4  uRegions;       // highlights, shadows, whites, blacks, each /100
uniform vec4  uContrast;      // k, lo, hi, t
uniform float uContrastSign;  // +1 adds contrast, -1 removes it
uniform vec4  uCurveOn;       // luma, r, g, b: 1 when the curve is not identity
uniform float uColorOn;
uniform vec2  uSatVib;        // saturation/100, vibrance/100
uniform vec3  uHsl[8];        // per band: hue, saturation, luminance, each /100
uniform float uGradingOn;
uniform float uGradeExp;      // p + 1
uniform float uGradeBalance;  // balance/100 * 0.25
uniform vec3  uGradeTint[3];  // chroma offset, strength already folded in
uniform vec3  uGradeLum;      // per band: luminance/100 * 0.4
uniform int   uLutKind;       // 0 none, 1 = a 1-D table, 3 = a 3-D cube
uniform int   uLutSize;       // entries per axis
uniform float uLutStrength;   // strength / 100
uniform int   uLutStage;      // 0 = "pre" (just after gamma), 1 = "post"

out vec4 fragColor;

const vec3 LUMA_W = vec3(${luma});
const float HSL_CENTERS[8] = float[8](${centers});
const float BAND_WIDTH = ${BAND_WIDTH.toFixed(1)};

float srgbEncode(float v) {
  v = clamp(v, 0.0, 1.0);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

// The engine indexes its LUT with a truncated integer, so this fetches a texel
// rather than sampling: LINEAR filtering would smooth across the very steps
// the server keeps, and the two renders would disagree on every gradient.
float curveAt(float v, int row) {
  int idx = clamp(int(clamp(v, 0.0, 1.0) * 1023.0), 0, ${CURVE_SIZE - 1});
  return texelFetch(uCurves, ivec2(idx, row), 0).r;
}

/** engine/ops/lut.py apply_lut, both kinds.
 *
 *  The trilinear blend is written out rather than left to a LINEAR sampler.
 *  Hardware filtering would be the obvious way to do it — trilinear *is*
 *  _apply_3d — but the weights a sampler uses are fixed-point (commonly 8
 *  bits of subtexel precision), and a LINEAR-filterable float format is an
 *  extension besides. Eight texelFetches and the arithmetic spelled out cost a
 *  few instructions on a pass that is already bandwidth-bound, and they are
 *  bit-comparable with the Python instead of nearly so.
 */
vec3 applyLut(vec3 c) {
  vec3 x = clamp(c, 0.0, 1.0);
  vec3 m;
  if (uLutKind == 3) {
    vec3 p = x * float(uLutSize - 1);
    ivec3 i0 = clamp(ivec3(p), ivec3(0), ivec3(uLutSize - 2));
    vec3 f = p - vec3(i0);
    // The cube is indexed [b][g][r], so the texture's x axis is red.
    vec3 c000 = texelFetch(uLut3, i0 + ivec3(0, 0, 0), 0).rgb;
    vec3 c100 = texelFetch(uLut3, i0 + ivec3(1, 0, 0), 0).rgb;
    vec3 c010 = texelFetch(uLut3, i0 + ivec3(0, 1, 0), 0).rgb;
    vec3 c110 = texelFetch(uLut3, i0 + ivec3(1, 1, 0), 0).rgb;
    vec3 c001 = texelFetch(uLut3, i0 + ivec3(0, 0, 1), 0).rgb;
    vec3 c101 = texelFetch(uLut3, i0 + ivec3(1, 0, 1), 0).rgb;
    vec3 c011 = texelFetch(uLut3, i0 + ivec3(0, 1, 1), 0).rgb;
    vec3 c111 = texelFetch(uLut3, i0 + ivec3(1, 1, 1), 0).rgb;
    vec3 c0 = mix(mix(c000, c100, f.r), mix(c010, c110, f.r), f.g);
    vec3 c1 = mix(mix(c001, c101, f.r), mix(c011, c111, f.r), f.g);
    m = mix(c0, c1, f.b);
  } else {
    // np.interp over np.linspace(0, 1, n): three independent channel curves.
    vec3 p = x * float(uLutSize - 1);
    ivec3 i0 = clamp(ivec3(p), ivec3(0), ivec3(uLutSize - 2));
    vec3 f = p - vec3(i0);
    for (int ch = 0; ch < 3; ch++) {
      float a = texelFetch(uLut1, ivec2(i0[ch], 0), 0)[ch];
      float b = texelFetch(uLut1, ivec2(i0[ch] + 1, 0), 0)[ch];
      m[ch] = mix(a, b, f[ch]);
    }
  }
  return x * (1.0 - uLutStrength) + clamp(m, 0.0, 1.0) * uLutStrength;
}

vec3 rgb2hsv(vec3 c) {
  float maxc = max(max(c.r, c.g), c.b);
  float minc = min(min(c.r, c.g), c.b);
  float delta = maxc - minc;
  float s = maxc > 0.0 ? delta / max(maxc, 1e-8) : 0.0;
  float dsafe = max(delta, 1e-8);
  float rc = (maxc - c.r) / dsafe;
  float gc = (maxc - c.g) / dsafe;
  float bc = (maxc - c.b) / dsafe;
  float h = (maxc == c.g) ? 2.0 + rc - bc : bc - gc;
  h = (maxc == c.b) ? 4.0 + gc - rc : h;
  h *= (delta > 1e-8) ? 1.0 : 0.0;
  return vec3(mod(h / 6.0, 1.0), s, maxc);
}

vec3 hsv2rgb(float h, float s, float v) {
  float h6 = h * 6.0;
  int i = int(mod(floor(h6), 6.0));
  float f = h6 - floor(h6);
  float p = v * (1.0 - s);
  float q = v * (1.0 - s * f);
  float t = v * (1.0 - s * (1.0 - f));
  if (i == 0) return vec3(v, t, p);
  if (i == 1) return vec3(q, v, p);
  if (i == 2) return vec3(p, v, t);
  if (i == 3) return vec3(p, q, v);
  if (i == 4) return vec3(t, p, v);
  return vec3(v, p, q);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uSource, px, 0).rgb;

  // ---- linear light ----
  c *= uWbGain;
  c *= exp2(uExposure);

  // Region masks all read the luma of the frame *before* any of them fire,
  // then accumulate onto the same buffer, in this order.
  float luma = clamp(dot(c, LUMA_W), 0.0, 1.0);
  float hi = uRegions.x;
  c = hi < 0.0
    ? c * (1.0 + hi * 0.6 * luma * luma)
    : c + hi * 0.4 * luma * luma * clamp(1.0 - c, 0.0, 1.0);
  c += uRegions.y * 0.35 * pow(1.0 - luma, 3.0) * max(0.5 - c, 0.0);
  c += uRegions.z * 0.5 * pow(clamp(luma * 1.5 - 0.5, 0.0, 1.0), 3.0) * (1.2 - c);
  c += uRegions.w * 0.25 * pow(clamp(1.0 - luma * 3.0, 0.0, 1.0), 2.0);
  c = max(c, 0.0);

  // ---- display space ----
  c = vec3(srgbEncode(c.r), srgbEncode(c.g), srgbEncode(c.b));

  if (uLutKind != 0 && uLutStage == 0) c = applyLut(c);

  vec3 x = clamp(c, 0.0, 1.0);
  vec3 sig = 1.0 / (1.0 + exp(-uContrast.x * 4.0 * (x - 0.5)));
  sig = (sig - uContrast.y) / (uContrast.z - uContrast.y);
  vec3 alt = uContrastSign > 0.0 ? sig : x + (x - sig);
  c = x * (1.0 - uContrast.w) + alt * uContrast.w;

  if (uCurveOn.x > 0.5) {
    c = vec3(curveAt(c.r, 0), curveAt(c.g, 0), curveAt(c.b, 0));
  }
  if (uCurveOn.y + uCurveOn.z + uCurveOn.w > 0.5) {
    c = clamp(c, 0.0, 1.0);
    if (uCurveOn.y > 0.5) c.r = curveAt(c.r, 1);
    if (uCurveOn.z > 0.5) c.g = curveAt(c.g, 2);
    if (uCurveOn.w > 0.5) c.b = curveAt(c.b, 3);
  }

  if (uColorOn > 0.5) {
    vec3 hsv = rgb2hsv(clamp(c, 0.0, 1.0));
    float h = hsv.x, s = hsv.y, v = hsv.z;
    s = clamp(s + uSatVib.y * (1.0 - s) * s * 2.0, 0.0, 1.0);
    s = clamp(s * (1.0 + uSatVib.x), 0.0, 1.0);
    // Band weights read the *original* hue but the *running* saturation, so
    // the bands compose in order and cannot be reordered or merged.
    float hdeg = h * 360.0;
    for (int i = 0; i < 8; i++) {
      float dist = abs(mod(hdeg - HSL_CENTERS[i] + 180.0, 360.0) - 180.0);
      float w = clamp(1.0 - dist / BAND_WIDTH, 0.0, 1.0) * s;
      h = mod(h + w * uHsl[i].x * (30.0 / 360.0), 1.0);
      s = clamp(s * (1.0 + w * uHsl[i].y), 0.0, 1.0);
      v = clamp(v * (1.0 + w * uHsl[i].z * 0.5), 0.0, 1.0);
    }
    c = hsv2rgb(h, s, v);
  }

  if (uGradingOn > 0.5) {
    vec3 g = clamp(c, 0.0, 1.0);
    float l = clamp(dot(g, LUMA_W) - uGradeBalance, 0.0, 1.0);
    float wSh = pow(1.0 - l, uGradeExp);
    float wHi = pow(l, uGradeExp);
    float w[3] = float[3](wSh, clamp(1.0 - wSh - wHi, 0.0, 1.0), wHi);
    for (int i = 0; i < 3; i++) {
      g += w[i] * uGradeTint[i];
      g *= 1.0 + w[i] * uGradeLum[i];
    }
    c = clamp(g, 0.0, 1.0);
  }

  if (uLutKind != 0 && uLutStage == 1) c = applyLut(c);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`

/** engine/ops/lens.py `apply_lens`, minus defringe.
 *
 *  Runs first, on linear light, so it reads the uploaded source frame and the
 *  edit pass reads *this* instead. Three things about it are load-bearing:
 *
 *  - The bilinear blend is spelled out over four texelFetches rather than left
 *    to a LINEAR sampler. `_plan` clamps its sample coordinate to `w - 1.001`
 *    and then floors it, so the last texel column is only ever reached as the
 *    0.999 end of a blend with its neighbour. A hardware sampler with
 *    CLAMP_TO_EDGE reaches it a different way, and the two disagree along the
 *    right and bottom edges — a one-pixel seam that a preview shows and the
 *    server render does not.
 *  - A channel with no distortion *and* no CA of its own is copied, not
 *    resampled, exactly as `_plan`'s `scale == 1.0` short circuit does. With
 *    distortion on, `base` is an array and the Python cannot take that branch,
 *    so neither does this — hence a per-channel flag rather than a comparison
 *    against 1.0 here.
 *  - The vignette gain uses the radius of the *destination* pixel, applied to
 *    the already-resampled colour, and the only clamp at the end is the lower
 *    one: `np.clip(out, 0, None)` keeps highlight headroom for the ops above.
 *
 *  `_defringe` is absent on purpose. It thresholds on `np.percentile(edge, 99)`
 *  over the whole frame, and a fragment shader has no way to reduce over the
 *  frame it is drawing; approximating the percentile would change the mask, so
 *  support.ts refuses any recipe with defringe instead.
 */
export const LENS_SOURCE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform ivec2 uSize;
uniform vec2  uCenter;     // (w - 1) / 2, (h - 1) / 2
uniform float uNorm;       // sqrt(cx^2 + cy^2)
uniform float uK;          // distortion / 100 * 0.15
uniform float uVig;        // vignette / 100 * 0.8
uniform vec3  uCaScale;    // per channel: 1 + ca / 100 * 0.001
uniform vec3  uRemap;      // per channel: 1 when it must be resampled at all
out vec4 fragColor;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float dx = float(px.x) - uCenter.x;
  float dy = float(px.y) - uCenter.y;
  float r = sqrt(dx * dx + dy * dy) / uNorm;
  float base = uK != 0.0 ? 1.0 + uK * r * r : 1.0;

  vec3 c;
  for (int i = 0; i < 3; i++) {
    if (uRemap[i] < 0.5) {
      c[i] = texelFetch(uSrc, px, 0)[i];
      continue;
    }
    float s = base * uCaScale[i];
    float sx = clamp(uCenter.x + dx * s, 0.0, float(uSize.x) - 1.001);
    float sy = clamp(uCenter.y + dy * s, 0.0, float(uSize.y) - 1.001);
    int x0 = int(sx);
    int y0 = int(sy);
    float fx = sx - float(x0);
    float fy = sy - float(y0);
    float top = texelFetch(uSrc, ivec2(x0, y0), 0)[i] * (1.0 - fx)
              + texelFetch(uSrc, ivec2(x0 + 1, y0), 0)[i] * fx;
    float bot = texelFetch(uSrc, ivec2(x0, y0 + 1), 0)[i] * (1.0 - fx)
              + texelFetch(uSrc, ivec2(x0 + 1, y0 + 1), 0)[i] * fx;
    c[i] = top * (1.0 - fy) + bot * fy;
  }

  c *= 1.0 + uVig * r * r;
  fragColor = vec4(max(c, 0.0), 1.0);
}`

/** engine/ops/geometry.py `apply_geometry`, as a sampling transform.
 *
 *  One program, run one to three times. The op is five steps, but only two of
 *  them resample — the perspective warp and the straighten — and the other
 *  three (orientation, flips, crop) are exact index permutations that fold
 *  into a neighbouring pass for free:
 *
 *    orientation -> `uOrient`, applied to every *input* fetch, taps included.
 *      A rot90 is a relabelling of the grid, so a bicubic taken through it is
 *      the same bicubic; folding it in costs one pass fewer than doing it.
 *    flips + crop -> `uOrigin` / `uSign`, applied to the *output* index of the
 *      last pass. Cropping is then a viewport that starts somewhere else, and
 *      a flip is a negative step through it.
 *
 *  The two resampling steps stay separate passes because the Python does two
 *  bicubics with a clamp between them, and one bicubic through the composed
 *  matrix is a visibly different (sharper) result.
 *
 *  `cubicW` is PIL's kernel with **a = -1**, not the a = -0.5 Catmull-Rom that
 *  most references give — measured against `Image.transform`, not assumed.
 *  Taps clamp to the edge, but a *sample position* outside [-0.5, size - 0.5)
 *  produces black, which is how PIL's generic transform fills the corners a
 *  straighten leaves empty.
 */
export const GEOM_SOURCE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform ivec2 uSrcSize;    // texels in uSrc, before uOrient
uniform ivec2 uInSize;     // logical input extent, after uOrient
uniform int   uOrient;     // rot90 count, 0-3
uniform ivec2 uOrigin;     // logical output index of fragment (0, 0)
uniform ivec2 uSign;       // +1, or -1 for a flipped axis
uniform mat3  uMap;        // output (x + 0.5) -> input (x + 0.5), projective
uniform int   uResample;   // 0 = exact permutation, 1 = bicubic
out vec4 fragColor;

/** A logical index in the oriented frame -> the texel that holds it. */
ivec2 oriented(ivec2 p) {
  if (uOrient == 1) return ivec2(uSrcSize.x - 1 - p.y, p.x);
  if (uOrient == 2) return ivec2(uSrcSize.x - 1 - p.x, uSrcSize.y - 1 - p.y);
  if (uOrient == 3) return ivec2(p.y, uSrcSize.y - 1 - p.x);
  return p;
}

float cubicW(float t) {
  float x = abs(t);
  if (x < 1.0) return x * x * x - 2.0 * x * x + 1.0;
  if (x < 2.0) return -(x * x * x - 5.0 * x * x + 8.0 * x - 4.0);
  return 0.0;
}

void main() {
  ivec2 idx = uOrigin + uSign * ivec2(gl_FragCoord.xy);

  if (uResample == 0) {
    ivec2 q = clamp(idx, ivec2(0), uInSize - 1);
    fragColor = vec4(texelFetch(uSrc, oriented(q), 0).rgb, 1.0);
    return;
  }

  vec3 hom = uMap * vec3(vec2(idx) + 0.5, 1.0);
  vec2 s = hom.xy / hom.z - 0.5;
  if (s.x < -0.5 || s.y < -0.5
      || s.x >= float(uInSize.x) - 0.5 || s.y >= float(uInSize.y) - 0.5) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  ivec2 i0 = ivec2(floor(s));
  vec3 acc = vec3(0.0);
  for (int j = -1; j <= 2; j++) {
    float wy = cubicW(float(i0.y + j) - s.y);
    for (int i = -1; i <= 2; i++) {
      float wx = cubicW(float(i0.x + i) - s.x);
      ivec2 q = clamp(i0 + ivec2(i, j), ivec2(0), uInSize - 1);
      acc += wy * wx * texelFetch(uSrc, oriented(q), 0).rgb;
    }
  }
  // _resample clips: bicubic overshoots at hard edges and the uint8 path it
  // replaced clamped as a side effect of its own conversion.
  fragColor = vec4(clamp(acc, 0.0, 1.0), 1.0);
}`

/** engine/ops/effects.py `apply_vignette`. Its own pass because it runs after
 *  presence and detail — see the note at the top of this file. */
export const VIGNETTE_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform vec2 uResolution;
uniform vec4 uVignette;   // amount/100, start, width, superellipse power
out vec4 fragColor;
void main() {
  vec3 c = texelFetch(uFrame, ivec2(gl_FragCoord.xy), 0).rgb;
  // Pixel centers, matching the engine's (index + 0.5) / extent * 2 - 1.
  vec2 n = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
  float p = uVignette.w;
  float d = pow(pow(abs(n.y), p) + pow(abs(n.x), p), 1.0 / p) / sqrt(2.0);
  float fall = smoothstep(uVignette.y, uVignette.y + uVignette.z, d);
  fragColor = vec4(clamp(clamp(c, 0.0, 1.0) * (1.0 + uVignette.x * fall), 0.0, 1.0), 1.0);
}`

// ---------------------------------------------------------------------------
// Multi-pass stage: the scalar planes the blurs run on, the two blur kernels,
// and the passes that fold a blurred plane back into the frame.
// ---------------------------------------------------------------------------

/** Which scalar (or chroma) plane `PLANE_SOURCE` extracts. */
export const PLANE_LUMA = 0
export const PLANE_DARK = 1
export const PLANE_MEAN = 2
export const PLANE_CHROMA = 3

/** Which presence op `PRESENCE_SOURCE` recombines. Values are also the order
 *  `apply_presence` runs them in, which is not the slider order. */
export const PRESENCE_DEHAZE = 0
export const PRESENCE_CLARITY = 1
export const PRESENCE_TEXTURE = 2

/** Extracts the plane an op is about to blur.
 *
 *  Rec.709 luma for texture/clarity, the per-pixel channel minimum (the "dark
 *  channel") for dehaze, and the plain mean for detail's luma/chroma split —
 *  `apply_detail` really does use the unweighted mean where presence uses
 *  Rec.709, so the two are separate modes rather than one shared luma.
 */
export const PLANE_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform int uPlaneMode;
out vec4 fragColor;
const vec3 LUMA_W = vec3(${luma});
void main() {
  vec3 c = clamp(texelFetch(uFrame, ivec2(gl_FragCoord.xy), 0).rgb, 0.0, 1.0);
  float mean = (c.r + c.g + c.b) / 3.0;
  if (uPlaneMode == ${PLANE_LUMA}) fragColor = vec4(dot(c, LUMA_W), 0.0, 0.0, 1.0);
  else if (uPlaneMode == ${PLANE_DARK}) fragColor = vec4(min(min(c.r, c.g), c.b), 0.0, 0.0, 1.0);
  else if (uPlaneMode == ${PLANE_MEAN}) fragColor = vec4(mean, 0.0, 0.0, 1.0);
  else fragColor = vec4(c - mean, 1.0);
}`

/** One box pass of `engine/ops/blur.py` `_box_blur_axis`, edge-clamped.
 *
 *  The Python takes a cumsum and differences it, which is O(1) per pixel; this
 *  sums the window directly, which is O(radius). That is the right trade on a
 *  GPU — a prefix sum needs a second dispatch and a scan, and the widest radius
 *  the presence ops ever ask for is a few dozen texels — and it is strictly
 *  more accurate, since nothing accumulates across the whole line.
 */
export const BOX_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uSize;
uniform ivec2 uStep;    // (0,1) blurs along y, (1,0) along x
uniform int uRadius;
out vec4 fragColor;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 acc = vec4(0.0);
  for (int i = -uRadius; i <= uRadius; i++) {
    acc += texelFetch(uSrc, clamp(px + uStep * i, ivec2(0), uSize - 1), 0);
  }
  fragColor = acc / float(2 * uRadius + 1);
}`

/** One axis of `engine/ops/detail.py` `_blur`: a true gaussian, zero-padded.
 *
 *  Zero padding, not clamping — taps that fall outside contribute nothing but
 *  still count toward the normalizing sum, which is exactly what convolving
 *  with a pre-normalized kernel against a zero-padded array does, and is why
 *  the engine's sharpened frames darken slightly at the border. Reproducing
 *  the darkening is the point; a preview that disagrees at the edge is a
 *  preview that visibly changes when the server render lands.
 */
export const GAUSS_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uSize;
uniform ivec2 uStep;
uniform int uRadius;
uniform float uSigma;
out vec4 fragColor;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float denom = 2.0 * uSigma * uSigma;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -uRadius; i <= uRadius; i++) {
    float w = exp(-float(i * i) / denom);
    wsum += w;
    ivec2 q = px + uStep * i;
    if (q.x >= 0 && q.y >= 0 && q.x < uSize.x && q.y < uSize.y) {
      acc += w * texelFetch(uSrc, q, 0);
    }
  }
  fragColor = acc / wsum;
}`

/** engine/ops/presence.py, recombining a frame with its blurred plane.
 *
 *  The *unblurred* plane is recomputed here rather than carried in a second
 *  texture: it is one dot product against pixels this pass already samples,
 *  which is cheaper than a full-frame fetch.
 */
export const PRESENCE_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform sampler2D uPlane;   // .r holds the blurred plane
uniform int uMode;
uniform float uAmount;      // slider / 100
out vec4 fragColor;
const vec3 LUMA_W = vec3(${luma});
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec3 x = clamp(texelFetch(uFrame, px, 0).rgb, 0.0, 1.0);
  float blurred = texelFetch(uPlane, px, 0).r;

  if (uMode == ${PRESENCE_TEXTURE}) {
    x += (dot(x, LUMA_W) - blurred) * uAmount * 0.8;
  } else if (uMode == ${PRESENCE_CLARITY}) {
    float l = dot(x, LUMA_W);
    // midtone weight 1 - (2L - 1)^2: skies and deep shadows stay clean
    float mid = 2.0 * l - 1.0;
    x += (l - blurred) * uAmount * 0.7 * (1.0 - mid * mid);
  } else {
    float t = uAmount;
    if (t > 0.0) {
      float s = blurred * 0.7 * t;
      x = (x - s) / max(1.0 - s, 0.2);
      // dehazing flattens colour; give saturation a nudge proportionally
      float gray = dot(x, LUMA_W);
      x = (x - gray) * (1.0 + 0.25 * t) + gray;
    } else {
      // lift toward a light atmospheric gray, weighted by the existing veil
      float s = (blurred * 0.6 + 0.4) * 0.5 * (-t);
      x += (0.85 - x) * s;
    }
  }
  fragColor = vec4(clamp(x, 0.0, 1.0), 1.0);
}`

/** engine/ops/detail.py noise reduction: reassemble the luma/chroma split.
 *  Either plane may have been blurred or not; this pass does not care. */
export const NR_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uLuma;
uniform sampler2D uChroma;
out vec4 fragColor;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float luma = texelFetch(uLuma, px, 0).r;
  fragColor = vec4(clamp(luma + texelFetch(uChroma, px, 0).rgb, 0.0, 1.0), 1.0);
}`

/** engine/ops/detail.py unsharp mask. */
export const SHARPEN_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform sampler2D uBlur;
uniform float uStrength;    // amount/100 * (0.5 + detail/100)
out vec4 fragColor;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uFrame, px, 0).rgb;
  vec3 high = c - texelFetch(uBlur, px, 0).rgb;
  fragColor = vec4(clamp(c + high * uStrength * 2.0, 0.0, 1.0), 1.0);
}`

// ---------------------------------------------------------------------------
// Stage 4: local adjustments (engine/ops/masks.py).
//
// The Python is three things stacked: a weight map per mask, a sub-pipeline
// (`_adjust`) run over the frame, and a per-pixel blend of the two. The GPU
// mirrors all three, and deliberately does *not* mirror the fourth — the
// bounding-box crop `apply_masks` does. That crop exists so the CPU can skip
// pixels the blend would leave alone; a fragment shader gets that for free
// because the blend at weight 0 already returns the untouched colour. What the
// crop's own comment says about *radii*, though, is load-bearing here too:
// clarity and dehaze size their blur from the frame they are handed, which is
// why `_adjust_margin` refuses to crop for them at all. So every blur below is
// sized from the full post-geometry frame, never from anything smaller.
//
// Masks run after geometry, so every coordinate here is normalized in the
// *output* frame, and every pass in this section runs at the output size.
// Row 0 is still the top, as everywhere before the present pass.
// ---------------------------------------------------------------------------

/** Which closed-form weight `MASK_WEIGHT_SOURCE` evaluates. Brush masks are
 *  not here: they are rasterized stroke by stroke by `STROKE_SOURCE`. */
export const MASK_LINEAR = 0
export const MASK_RADIAL = 1
export const MASK_LUMINANCE = 2
export const MASK_COLOR = 3

/** Points a single `STROKE_SOURCE` invocation can carry, packed two to a vec4.
 *
 *  A long stroke is split into chunks that share their boundary point, and the
 *  distance is minimized across them in the target's green channel before the
 *  last chunk composites. Splitting the *composite* instead would be wrong:
 *  paint accumulates as `1 - (1-a)(1-b)`, so a stroke composited twice at
 *  flow < 100 lands somewhere the Python never does. */
export const MAX_STROKE_POINTS = 96

/** `masks.py` `_smoothstep`, which is not GLSL's.
 *
 *  The difference is the `max(edge1 - edge0, 1e-6)`, and it is not cosmetic: a
 *  radial mask with feather 0 has `inner == 1.0 == edge1`, where GLSL's
 *  smoothstep divides by zero and the Python divides by 1e-6 — a hard edge,
 *  not a NaN. */
const SSTEP = `
float sstep(float e0, float e1, float x) {
  float t = clamp((x - e0) / max(e1 - e0, 1e-6), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}`

/** `mask_weight`'s closed-form branches, into an RG32F target's red channel.
 *
 *  `invert` and `opacity` are *not* applied here — the blend pass does both,
 *  so a brush mask (whose weight is built by a different program) needs no
 *  second copy of them.
 */
export const MASK_WEIGHT_SOURCE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uFrame;
uniform vec2 uResolution;
uniform int  uMode;
// linear:    uA = start.xy, end.xy
// radial:    uA = center.xy, radiusX, radiusY;  uB.x = 1 - feather/100
// luminance: uA = lumMin, lumMax, feather units; uB = lumMin<=0, lumMax>=100
// color:     uA = hue degrees, range degrees
uniform vec4 uA;
uniform vec4 uB;
out vec4 fragColor;
const vec3 LUMA_W = vec3(${luma});
${SSTEP}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  // _coord_grids: pixel centers, x by width and y by height.
  vec2 uv = gl_FragCoord.xy / uResolution;
  float w = 0.0;

  if (uMode == ${MASK_LINEAR}) {
    vec2 d = uA.zw - uA.xy;
    float norm = dot(d, d);
    w = norm < 1e-9 ? 1.0 : 1.0 - sstep(0.0, 1.0, dot(uv - uA.xy, d) / norm);
  } else if (uMode == ${MASK_RADIAL}) {
    vec2 q = (uv - uA.xy) / uA.zw;
    w = 1.0 - sstep(uB.x, 1.0, sqrt(dot(q, q)));
  } else if (uMode == ${MASK_LUMINANCE}) {
    vec3 c = clamp(texelFetch(uFrame, px, 0).rgb, 0.0, 1.0);
    float lum = clamp(dot(c, LUMA_W), 0.0, 1.0) * 100.0;
    // Both ends of the range are open: lumMin 0 selects every dark fully.
    float lo = uB.x > 0.5 ? 1.0 : sstep(uA.x - uA.z, uA.x + uA.z, lum);
    float hi = uB.y > 0.5 ? 0.0 : sstep(uA.y - uA.z, uA.y + uA.z, lum);
    w = lo * (1.0 - hi);
  } else {
    vec3 x = clamp(texelFetch(uFrame, px, 0).rgb, 0.0, 1.0);
    float maxc = max(max(x.r, x.g), x.b);
    float minc = min(min(x.r, x.g), x.b);
    float delta = maxc - minc;
    float sat = maxc > 1e-6 ? delta / max(maxc, 1e-6) : 0.0;
    // The hexagonal hue angle, exactly as np.arctan2 is called on it. GLSL
    // leaves atan(0, 0) undefined where numpy returns 0, so grey is special
    // cased rather than left to the driver.
    float ny = sqrt(3.0) * (x.g - x.b);
    float nx = 2.0 * x.r - x.g - x.b;
    float hdeg = (ny == 0.0 && nx == 0.0) ? 0.0 : mod(degrees(atan(ny, nx)), 360.0);
    float dist = abs(mod(hdeg - uA.x + 180.0, 360.0) - 180.0);
    w = clamp(1.0 - dist / uA.y, 0.0, 1.0) * clamp(sat * 2.0, 0.0, 1.0);
  }
  fragColor = vec4(w, 0.0, 0.0, 1.0);
}`

/** One chunk of one brush stroke: `_stroke_patch` plus `_brush_weight`'s
 *  composite, ping-ponged through an RG32F pair.
 *
 *  red carries the accumulated mask weight, green the running minimum distance
 *  to the stroke's polyline. `uInit` starts a stroke's distance, `uFinal`
 *  turns it into a patch and composites it — a stroke short enough to fit in
 *  one chunk sets both.
 *
 *  Evaluating over the whole frame rather than `_stroke_patch`'s bounding box
 *  is not an approximation: outside the box the smoothstep has already reached
 *  1, so the patch is 0 there, and both composites leave the weight untouched
 *  at 0.
 */
export const STROKE_SOURCE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uPrev;
uniform vec4  uPts[${MAX_STROKE_POINTS / 2}];   // pixel coords, two points per vec4
uniform int   uCount;      // points in this chunk
uniform int   uInit;       // 1 = first chunk of this stroke
uniform int   uFinal;      // 1 = last chunk: build the patch and composite
uniform vec4  uStroke;     // hard radius, outer radius, flow/100, erase
out vec4 fragColor;
${SSTEP}

vec2 point(int i) {
  vec4 v = uPts[i >> 1];
  return (i & 1) == 0 ? v.xy : v.zw;
}

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 prev = texelFetch(uPrev, ivec2(p), 0).rg;
  float d = uInit == 1 ? 3.0e30 : prev.g;

  if (uCount == 1) {
    d = min(d, distance(p, point(0)));
  } else {
    for (int i = 0; i + 1 < uCount; i++) {
      vec2 a = point(i);
      vec2 v = point(i + 1) - a;
      float norm = dot(v, v);
      float seg;
      if (norm < 1e-9) {
        seg = distance(p, a);
      } else {
        float t = clamp(dot(p - a, v) / norm, 0.0, 1.0);
        seg = distance(p, a + t * v);
      }
      d = min(d, seg);
    }
  }

  float weight = prev.r;
  if (uFinal == 1) {
    float s = (1.0 - sstep(uStroke.x, uStroke.y, d)) * uStroke.z;
    weight = uStroke.w > 0.5 ? weight * (1.0 - s) : 1.0 - (1.0 - weight) * (1.0 - s);
  }
  fragColor = vec4(weight, d, 0.0, 1.0);
}`

/** Which half of `_adjust`'s pointwise work `LOCAL_SOURCE` is doing. */
export const LOCAL_TONE = 0
export const LOCAL_SAT = 1

/** The pointwise parts of `masks.py` `_adjust`.
 *
 *  Two modes rather than one pass, because saturation runs *after* dehaze and
 *  clarity and those two are multi-pass. What is not split is where the
 *  clamps fall: `_adjust` only clips at the points its ops clip, and one extra
 *  `clamp(x, 0, 1)` between the gamma block and saturation would quietly
 *  discard the headroom a lifted exposure leaves behind. So the tone pass
 *  writes its result unclamped, and the blend pass applies `_adjust`'s closing
 *  `np.clip(out, 0, 1)` instead.
 */
export const LOCAL_SOURCE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform int   uMode;
uniform float uToneOn;       // any of exposure/temp/tint/highlights/shadows
uniform float uExpGain;      // 2^exposure
uniform vec3  uWbGain;       // 2^(temp/100*0.35), 2^(-tint/100*0.25), 1/red
uniform float uRegionsOn;
uniform vec2  uRegions;      // highlights/100, shadows/100
uniform float uContrastOn;
uniform vec4  uContrast;     // k, lo, hi, t
uniform float uContrastSign;
uniform float uSatGain;      // 1 + saturation/100
out vec4 fragColor;
const vec3 LUMA_W = vec3(${luma});
const float GAMMA = 2.2;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec3 o = texelFetch(uSrc, px, 0).rgb;

  if (uMode == ${LOCAL_SAT}) {
    float gray = dot(o, LUMA_W);
    fragColor = vec4(clamp(gray + (o - gray) * uSatGain, 0.0, 1.0), 1.0);
    return;
  }

  // _adjust's opening np.clip(img, 0, 1).
  o = clamp(o, 0.0, 1.0);
  if (uToneOn > 0.5) {
    vec3 lin = pow(o, vec3(GAMMA));
    lin *= uExpGain;
    lin *= uWbGain;
    if (uRegionsOn > 0.5) {
      // apply_regions with whites/blacks pinned at 0 — Tone(highlights=,
      // shadows=) leaves the other two at their defaults, and both of their
      // terms are exactly additive identities there.
      float luma = clamp(dot(lin, LUMA_W), 0.0, 1.0);
      float hi = uRegions.x;
      lin = hi < 0.0
        ? lin * (1.0 + hi * 0.6 * luma * luma)
        : lin + hi * 0.4 * luma * luma * clamp(1.0 - lin, 0.0, 1.0);
      lin += uRegions.y * 0.35 * pow(1.0 - luma, 3.0) * max(0.5 - lin, 0.0);
      lin = max(lin, 0.0);
    }
    o = pow(max(lin, 0.0), vec3(1.0 / GAMMA));
  }

  if (uContrastOn > 0.5) {
    vec3 x = clamp(o, 0.0, 1.0);
    vec3 sig = 1.0 / (1.0 + exp(-uContrast.x * 4.0 * (x - 0.5)));
    sig = (sig - uContrast.y) / (uContrast.z - uContrast.y);
    vec3 alt = uContrastSign > 0.0 ? sig : x + (x - sig);
    o = x * (1.0 - uContrast.w) + alt * uContrast.w;
  }

  fragColor = vec4(o, 1.0);
}`

/** `apply_masks`'s blend, and the two clips that bracket it: the frame's own
 *  `np.clip(img, 0, 1)` and `_adjust`'s closing clip on the adjusted copy. */
export const MASK_BLEND_SOURCE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uFrame;
uniform sampler2D uAdjusted;
uniform sampler2D uWeight;
uniform float uInvert;
uniform float uOpacity;    // opacity / 100
out vec4 fragColor;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec3 base = clamp(texelFetch(uFrame, px, 0).rgb, 0.0, 1.0);
  vec3 adj = clamp(texelFetch(uAdjusted, px, 0).rgb, 0.0, 1.0);
  float raw = texelFetch(uWeight, px, 0).r;
  float w = (uInvert > 0.5 ? 1.0 - raw : raw) * uOpacity;
  fragColor = vec4(base * (1.0 - w) + adj * w, 1.0);
}`

/** Copies the float intermediate out to the 8-bit canvas. */
// The one place the pipeline flips vertically, and it has to.
//
// Every pass before this one is self-consistent: texImage2D puts source row 0
// at texel row 0, and each pass writes gl_FragCoord.y into the same row it
// read. But this pass draws into the default framebuffer, whose origin is
// bottom-left rather than top-left — so row 0 of the image would land at the
// bottom of the canvas, and the preview would be upside down. It was, until a
// frame with a bright top and dark bottom was rendered and read back.
export const PRESENT_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
out vec4 fragColor;
void main() {
  int y = textureSize(uFrame, 0).y - 1 - int(gl_FragCoord.y);
  fragColor = vec4(texelFetch(uFrame, ivec2(int(gl_FragCoord.x), y), 0).rgb, 1.0);
}`
