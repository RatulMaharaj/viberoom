/** Format scanner EXIF (stringified Pillow values) into a shooting summary
 * like "f/2.8 · 1/250s · ISO 400 · 35mm". */

function num(v: string | undefined): number | null {
  if (!v) return null
  if (v.includes('/')) {
    const [n, d] = v.split('/').map(Number)
    if (d) return n / d
  }
  const f = Number(v)
  return Number.isFinite(f) ? f : null
}

function shutter(v: string | undefined): string | null {
  const s = num(v)
  if (s == null || s <= 0) return null
  if (s >= 1) return `${s.toFixed(1)}s`
  return `1/${Math.round(1 / s)}s`
}

export function exifLine(exif: Record<string, string>): string {
  const parts: string[] = []
  const f = num(exif.FNumber)
  if (f) parts.push(`f/${f.toFixed(1).replace(/\.0$/, '')}`)
  const sh = shutter(exif.ExposureTime)
  if (sh) parts.push(sh)
  const iso = exif.ISO ?? exif.ISOSpeedRatings ?? exif.PhotographicSensitivity
  if (iso) parts.push(`ISO ${iso}`)
  const fl = num(exif.FocalLength)
  if (fl) parts.push(`${Math.round(fl)}mm`)
  return parts.join(' · ')
}

export function cameraLine(exif: Record<string, string>): string {
  return [exif.Model, exif.LensModel].filter(Boolean).join(' + ')
}
