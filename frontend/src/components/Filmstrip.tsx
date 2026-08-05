import { memo, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { api, type ImageMeta } from '../api'
import { cameraLine, exifLine } from '../exif'

const Thumb = memo(function Thumb({
  image,
  current,
  src,
  local,
  onPick,
  onHover,
}: {
  image: ImageMeta
  current: boolean
  /** Set only in the no-server build; see ImageCard's `thumbSrc`. */
  src?: string
  /** No server to fall back to: draw a skeleton, not a broken image. */
  local?: boolean
  onPick: (id: string) => void
  onHover: (im: ImageMeta | null) => void
}) {
  // Locally the thumbnail is a decode away, so for a moment there is no src.
  // Falling through to the server's URL drew a broken-image glyph on every
  // frame until it landed.
  if (src === undefined && local) {
    return <div className="h-20 w-28 skeleton rounded shrink-0" />
  }
  return (
    <img
      src={src ?? api.thumbnailUrl(image.id)}
      alt={image.filename}
      loading="lazy"
      onClick={() => onPick(image.id)}
      onMouseEnter={() => onHover(image)}
      onMouseLeave={() => onHover(null)}
      className={`h-20 w-auto object-cover rounded cursor-pointer ${
        current ? 'ring-2 ring-primary' : 'opacity-70 hover:opacity-100'
      }`}
    />
  )
})

/** Info bar + filmstrip. Owns the hover state so scrubbing across hundreds of
 * thumbnails does not re-render the loupe and the edit panel. */
export function Filmstrip({
  siblings,
  image,
  id,
  idx,
  thumbSrcs,
  local,
  open,
  onToggle,
  onPick,
}: {
  siblings: ImageMeta[]
  image: ImageMeta | null
  id: string | undefined
  idx: number
  /** id -> tile URL, in the no-server build only. */
  thumbSrcs?: Record<string, string>
  local?: boolean
  open: boolean
  onToggle: () => void
  onPick: (id: string) => void
}) {
  const [hovered, setHovered] = useState<ImageMeta | null>(null)
  const info = hovered ?? image

  const thumbs = useMemo(
    () =>
      siblings.map((im) => (
        <Thumb
          key={im.id}
          image={im}
          current={im.id === id}
          src={thumbSrcs?.[im.id]}
          local={local}
          onPick={onPick}
          onHover={setHovered}
        />
      )),
    [siblings, id, onPick, thumbSrcs, local],
  )

  const position = (hovered ? siblings.findIndex((s) => s.id === hovered.id) : idx) + 1

  return (
    <>
      <div className="h-7 shrink-0 bg-base-100 border-t border-base-300/30 flex items-center gap-3 px-3 text-xs">
        {info && (
          <>
            <span className="font-mono font-bold">{info.filename}</span>
            <span className="opacity-70 font-mono">{exifLine(info.exif)}</span>
            <span className="opacity-40 truncate">{cameraLine(info.exif)}</span>
            <div className="flex-1" />
            {info.rating > 0 && <span className="text-amber-400">{'★'.repeat(info.rating)}</span>}
            {info.flag && (
              <span className={info.flag === 'pick' ? 'text-success' : 'text-error'}>
                {info.flag}
              </span>
            )}
            <span className="opacity-50 font-mono">
              {position} / {siblings.length}
            </span>
          </>
        )}
        {/* Sits outside the `info` guard: with no image loaded there is still a
            closed strip to reopen, and a control that vanishes when you need it
            is worse than no control. */}
        {!info && <div className="flex-1" />}
        <button
          className="btn btn-ghost btn-xs px-1"
          onClick={onToggle}
          title={open ? 'Hide filmstrip (T)' : 'Show filmstrip (T)'}
          aria-label={open ? 'Hide filmstrip' : 'Show filmstrip'}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      {open && (
        <div className="h-24 shrink-0 bg-base-200 flex gap-1 items-center overflow-x-auto px-2">
          {thumbs}
        </div>
      )}
    </>
  )
}
