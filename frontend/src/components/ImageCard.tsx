import { memo, type MouseEvent } from 'react'
import { api, type Flag, type ImageMeta } from '../api'
import { FlagBadge, RatingStars } from './RatingStars'
import { exifLine } from '../exif'

/** One grid card. Memoized because the library renders up to 500 of these and
 * hover/selection/filter changes would otherwise re-render every one. All the
 * handlers take the image id so the parent can hold them stable. */
export const ImageCard = memo(function ImageCard({
  image,
  selected,
  multi,
  onClick,
  onOpen,
  onRate,
  onFlag,
}: {
  image: ImageMeta
  selected: boolean
  multi: boolean
  onClick: (id: string, e: MouseEvent) => void
  onOpen: (id: string) => void
  onRate: (id: string, rating: number) => void
  onFlag: (id: string, flag: Flag) => void
}) {
  const exif = exifLine(image.exif)
  return (
    <div
      className={`card bg-base-200 shadow cursor-pointer transition overflow-hidden ${
        selected ? 'outline-2 outline-primary' : multi ? 'outline-2 outline-secondary' : ''
      }`}
      onClick={(e) => onClick(image.id, e)}
      onDoubleClick={() => onOpen(image.id)}
    >
      <figure className="aspect-[3/2] bg-base-300 relative group">
        <img
          src={api.thumbnailUrl(image.id)}
          alt={image.filename}
          loading="lazy"
          className="object-cover w-full h-full"
        />
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
