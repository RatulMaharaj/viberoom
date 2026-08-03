/** EXIF for the catalog, read in the browser.
 *
 * `exifr` parses the header only — it never touches the pixel data — so this
 * stays cheap enough to run over a whole folder at import time, which is what
 * the server's scanner does with exiftool.
 *
 * The output is deliberately shaped like `catalog/scanner.py::summarize_exif`
 * plus the raw string map `metadata.py` builds, because `frontend/src/exif.ts`
 * reads those stringified values directly.
 */

import exifr from 'exifr'

/** The eight tags `_EXIFTOOL_MAP` keeps, as strings, exactly as the server
 *  stores them in `exif_json`. */
export type RawExif = Record<string, string>

/** The derived columns `summarize_exif` returns. */
export interface ExifSummary {
  camera: string | null
  lens: string | null
  iso: number | null
  focal_length: number | null
  aperture: number | null
  shutter: number | null
  taken_at: string | null
  gps_lat: number | null
  gps_lon: number | null
}

export interface ImageMetadata {
  width: number | null
  height: number | null
  exif: RawExif
  summary: ExifSummary
}

/** Only these are picked out of the file. The UI reads no others, and the
 *  vendor maker-note blocks are large enough to be worth not parsing. */
const PICK = [
  'Make', 'Model', 'LensModel', 'DateTimeOriginal', 'ExposureTime',
  'FNumber', 'ISO', 'ISOSpeedRatings', 'PhotographicSensitivity',
  'FocalLength', 'ExifImageWidth', 'ExifImageHeight', 'Orientation',
  'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef',
]

const OPTIONS = {
  tiff: true, exif: true, gps: true,
  ifd1: false, interop: false,
  makerNote: false, userComment: false,
  pick: PICK,
  // exifr would otherwise hand back a Date for DateTimeOriginal; the server
  // stores the EXIF string and the reformatting below expects that form.
  reviveValues: false,
  translateValues: false,
}

/** Numeric value of a possibly-rational tag.
 *
 * `scanner.py::_num` keeps only the numerator of a "1/250", so every fast
 * shutter lands in the catalog as 1.0 and sorts identically. That is a bug, not
 * a shape, so this divides — the summary column is only ever read as a number. */
function num(v: unknown): number | null {
  if (v == null) return null
  const s = String(v)
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number)
    if (d) return n / d
  }
  const f = Number(s)
  return Number.isFinite(f) ? f : null
}

/**
 * Shutter speeds keep their fractional form, everything else goes decimal.
 *
 * `metadata.py::_ratio_str` does this, and the UI's `exif.ts` relies on it:
 * `shutter()` there re-derives 1/250 from the string, and a value already
 * rounded to "0.004" would come back as "1/250" only by luck.
 */
function ratioStr(v: unknown): string {
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v)
    if (v < 1) {
      const denom = Math.round(1 / v)
      return denom > 0 ? `1/${denom}` : String(v)
    }
    return String(Number(v.toPrecision(6)))
  }
  return String(v)
}

/** `summarize_exif`'s camera rule: drop a redundant make prefix. */
function cameraName(make: string, model: string): string | null {
  if (make && model.startsWith(make.split(' ')[0])) return model
  return [make, model].filter(Boolean).join(' ') || null
}

/** EXIF "YYYY:MM:DD HH:MM:SS" -> sortable "YYYY-MM-DD HH:MM:SS". */
function takenAt(value: unknown): string | null {
  if (!value) return null
  const parts = String(value).split(' ')
  return parts[0].replace(/:/g, '-') + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '')
}

/**
 * Decimal degrees, the same fold `scanner.py::_parse_gps` does.
 *
 * exifr hands GPS back as a [degrees, minutes, seconds] triple with the
 * hemisphere in a separate ref tag — it computes signed decimals too, but only
 * when `pick` has not narrowed the output, which it has here.
 */
function gps(tags: Record<string, unknown>): [number | null, number | null] {
  return [
    dms(tags.GPSLatitude, tags.GPSLatitudeRef),
    dms(tags.GPSLongitude, tags.GPSLongitudeRef),
  ]
}

/** Normalized metadata for one file.
 *
 * Never throws: a file with no readable EXIF is common (PNG, a stripped JPEG,
 * an export) and is a blank row, not a failure. Takes a raw buffer as well as a
 * Blob so a file already read for decoding is not read a second time. */
export async function readExif(
  file: Blob | ArrayBuffer | Uint8Array,
): Promise<ImageMetadata> {
  let tags: Record<string, unknown> = {}
  try {
    tags = (await exifr.parse(file, OPTIONS)) ?? {}
  } catch {
    tags = {}
  }

  const exif: RawExif = {}
  const iso = tags.ISO ?? tags.ISOSpeedRatings ?? tags.PhotographicSensitivity
  const put = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '') exif[key] = ratioStr(value)
  }
  put('Make', typeof tags.Make === 'string' ? tags.Make.trim() : tags.Make)
  put('Model', typeof tags.Model === 'string' ? tags.Model.trim() : tags.Model)
  put('LensModel', tags.LensModel)
  put('DateTimeOriginal', tags.DateTimeOriginal)
  put('ExposureTime', tags.ExposureTime)
  put('FNumber', tags.FNumber)
  put('ISO', iso)
  put('FocalLength', tags.FocalLength)

  const [lat, lon] = gps(tags)
  const isoNum = num(iso)
  return {
    width: num(tags.ExifImageWidth),
    height: num(tags.ExifImageHeight),
    exif,
    summary: {
      camera: cameraName(String(tags.Make ?? '').trim(), String(tags.Model ?? '').trim()),
      lens: (exif.LensModel as string) || null,
      iso: isoNum ? Math.round(isoNum) : null,
      focal_length: num(tags.FocalLength),
      aperture: num(tags.FNumber),
      shutter: num(tags.ExposureTime),
      taken_at: takenAt(tags.DateTimeOriginal),
      gps_lat: lat,
      gps_lon: lon,
    },
  }
}

/** Local wall-clock "YYYY-MM-DD HH:MM:SS" from a unix timestamp.
 *
 * Local, not UTC: LibRaw builds this stamp from the EXIF date with `mktime`,
 * which reads it as local time, so reading it back any other way shifts every
 * photo by the machine's offset. */
function stampToTakenAt(seconds: number): string | null {
  if (!seconds) return null
  const d = new Date(seconds * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Degrees-minutes-seconds triple plus a hemisphere ref. Accepts a plain
 *  decimal too, which is what a writer that skipped the rationals leaves. */
function dms(parts: unknown, ref: unknown): number | null {
  if (!Array.isArray(parts)) {
    const d = num(parts)
    if (d == null) return null
    const sign = String(ref ?? '').trim().toUpperCase()[0]
    return (sign === 'S' || sign === 'W') ? -Math.abs(d) : d
  }
  const [d = 0, m = 0, s = 0] = parts.map(Number)
  if (!Number.isFinite(d)) return null
  const deg = Math.abs(d) + m / 60 + s / 3600
  const hemisphere = String(ref ?? '').trim().toUpperCase()[0]
  return (hemisphere === 'S' || hemisphere === 'W' || d < 0) ? -deg : deg
}

/**
 * The same normalized shape, built from LibRaw's metadata block instead.
 *
 * This exists because exifr cannot open every RAW container — Canon's CR3 is
 * ISO-BMFF and Fuji's RAF has its own wrapper, and it finds no TIFF header in
 * either — while LibRaw parses both to get at the pixels anyway. The values are
 * already decoded numbers here, so they are re-stringified into the same form
 * exifr's would have taken.
 */
export function metadataFromLibRaw(meta: Record<string, unknown>): ImageMetadata {
  const g = <T,>(key: string): T | undefined => meta[key] as T | undefined
  const make = String(g<string>('camera_make') ?? '').trim()
  const model = String(g<string>('camera_model') ?? '').trim()
  const lens = String((g<{ Lens?: string }>('lens') ?? {}).Lens ?? '').trim()
  const iso = Number(g<number>('iso_speed') ?? 0) || null
  const shutter = Number(g<number>('shutter') ?? 0) || null
  const aperture = Number(g<number>('aperture') ?? 0) || null
  const focal = Number(g<number>('focal_len') ?? 0) || null
  // The npm wrapper turns `timestamp` into a Date; the worker protocol hands
  // back the raw seconds. Both arrive here depending on who is driving.
  const ts = g<number | Date>('timestamp')
  const seconds = ts instanceof Date ? ts.getTime() / 1000 : Number(ts ?? 0)

  const gpsData = g<Record<string, unknown>>('gps_data')
  // `gpsparsed` alone is not enough: Canon bodies set the flag with an all-zero
  // fix, and null island is a worse answer than no answer.
  const zeroed = (v: unknown) => Array.isArray(v) && v.every((n) => Number(n) === 0)
  const hasGps = !!gpsData?.gpsparsed &&
    !(zeroed(gpsData.latitude) && zeroed(gpsData.longitude))
  const lat = hasGps ? dms(gpsData!.latitude, gpsData!.latref) : null
  const lon = hasGps ? dms(gpsData!.longitude, gpsData!.longref) : null

  const exif: RawExif = {}
  if (make) exif.Make = make
  if (model) exif.Model = model
  if (lens) exif.LensModel = lens
  const taken = stampToTakenAt(seconds)
  // Back to EXIF's colon-separated form: `readExif` stores what the file said
  // and derives `taken_at` from it, so this one has to look like the file's.
  if (taken) exif.DateTimeOriginal = taken.replace(/^(\d+)-(\d+)-(\d+)/, '$1:$2:$3')
  if (shutter) exif.ExposureTime = ratioStr(shutter)
  if (aperture) exif.FNumber = ratioStr(Number(aperture.toFixed(1)))
  if (iso) exif.ISO = String(iso)
  if (focal) exif.FocalLength = ratioStr(Number(focal.toFixed(1)))

  return {
    width: Number(g<number>('width') ?? 0) || null,
    height: Number(g<number>('height') ?? 0) || null,
    exif,
    summary: {
      camera: cameraName(make, model),
      lens: lens || null,
      iso: iso ? Math.round(iso) : null,
      focal_length: focal,
      aperture,
      shutter,
      taken_at: taken,
      gps_lat: lat,
      gps_lon: lon,
    },
  }
}
