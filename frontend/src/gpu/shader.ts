/** GLSL for the pointwise half of the render pipeline.
 *
 *  This is a port of `render_float` in engine/pipeline.py, in its order:
 *    white balance -> exposure -> regions -> sRGB transfer -> contrast
 *    -> tone curve -> colour/HSL -> colour grading -> vignette
 *  Lens, presence, detail, geometry, LUTs, masks, retouch and grain are later
 *  stages; a recipe that uses any of them never reaches this shader (see
 *  support.ts), which is what lets the chain be one pass with no resampling.
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

uniform vec2  uResolution;
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
uniform float uVignetteOn;
uniform vec4  uVignette;      // amount/100, start, width, superellipse power

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

  if (uVignetteOn > 0.5) {
    // Pixel centers, matching the engine's (index + 0.5) / extent * 2 - 1.
    vec2 n = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
    float p = uVignette.w;
    float d = pow(pow(abs(n.y), p) + pow(abs(n.x), p), 1.0 / p) / sqrt(2.0);
    float fall = smoothstep(uVignette.y, uVignette.y + uVignette.z, d);
    c = clamp(clamp(c, 0.0, 1.0) * (1.0 + uVignette.x * fall), 0.0, 1.0);
  }

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`

/** Copies the float intermediate out to the 8-bit canvas. Trivial today; it
 *  exists so the edit pass always writes somewhere with headroom, which is
 *  what the later blur/detail stages will need to read back. */
export const PRESENT_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
out vec4 fragColor;
void main() {
  fragColor = vec4(texelFetch(uFrame, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);
}`
