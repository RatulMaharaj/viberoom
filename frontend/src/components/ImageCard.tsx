import { memo, type MouseEvent } from 'react'
import { api, type Flag, type ImageMeta } from '../api'
import { FlagBadge, RatingStars } from './RatingStars'
import { exifLine } from '../exif'
import { unsupportedReason } from '../local/unsupported'

/** One grid card. Memoized because the library renders up to 500 of these and
 * hover/selection/filter changes would otherwise re-render every one. All the
 * handlers take the image id so the parent can hold them stable. */
export const ImageCard = memo(function ImageCard({
  image,
  selected,
  multi,
  thumbSrc,
  local,
  onClick,
  onOpen,
  onRate,
  onFlag,
}: {
  image: ImageMeta
  selected: boolean
  multi: boolean
  /** Ready-made tile URL. Set only in the no-server build, where a thumbnail
   *  is a blob the page decoded itself rather than something to GET. */
  thumbSrc?: string
  /** No server to fall back to: draw a skeleton, not a broken image. */
  local?: boolean
  onClick: (id: string, e: MouseEvent) => void
  onOpen: (id: string) => void
  onRate: (id: string, rating: number) => void
  onFlag: (id: string, flag: Flag) => void
}) {
  const exif = exifLine(image.exif)
  // Only meaningful with no server; the desktop app reads every format.
  const unsupported = local ? unsupportedReason(image.filename) : null
  return (
    <div
      className={`card bg-base-200 shadow cursor-pointer transition overflow-hidden ${
        selected ? 'outline-2 outline-primary' : multi ? 'outline-2 outline-secondary' : ''
      }`}
      onClick={(e) => onClick(image.id, e)}
      onDoubleClick={() => onOpen(image.id)}
    >
      <figure className="aspect-[3/2] bg-base-300 relative group">
        {/* Locally a thumbnail is a decode away, so for a moment there is no
            src to give. Falling through to the server's URL put a broken-image
            glyph and the filename on every tile until the decode landed —
            the browser drawing a failure where the answer was "not yet". */}
        {thumbSrc === undefined && local ? (
          <div className="w-full h-full skeleton rounded-none" />
        ) : (
        <img
          src={thumbSrc ?? api.thumbnailUrl(image.id)}
          alt={image.filename}
          loading="lazy"
          className="object-cover w-full h-full"
        />
        )}
        {exif && (
          <div className="absolute inset-x-0 bottom-0 bg-black/70 text-[10px] font-mono text-white/90 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {exif}
          </div>
        )}
      </figure>
      <div className="card-body p-3 gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs truncate">{image.filename}</span>
          <div className="flex gap-1 shrink-0">
            {image.is_raw && <span className="badge badge-xs badge-neutral">RAW</span>}
            {unsupported && (
              <span className="badge badge-xs badge-warning" title={unsupported}>
                Desktop only
              </span>
            )}
            {image.has_edits && <span className="badge badge-xs badge-info">edited</span>}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <RatingStars rating={image.rating} onChange={(r) => onRate(image.id, r)} size="xs" />
          <FlagBadge flag={image.flag} onChange={(f) => onFlag(image.id, f)} />
        </div>
      </div>
    </div>
  )
})
