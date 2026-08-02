import { Flag, X } from 'lucide-react'

export function RatingStars({
  rating,
  onChange,
  size = 'sm',
}: {
  rating: number
  onChange: (r: number) => void
  size?: 'xs' | 'sm' | 'md'
}) {
  return (
    <div className={`rating rating-${size}`} onClick={(e) => e.stopPropagation()}>
      {[1, 2, 3, 4, 5].map((n) => (
        <input
          key={n}
          type="radio"
          className="mask mask-star-2 bg-amber-400"
          checked={rating === n}
          onChange={() => onChange(rating === n ? 0 : n)}
          onClick={() => rating === n && onChange(0)}
          aria-label={`${n} star`}
        />
      ))}
    </div>
  )
}

export function FlagBadge({
  flag,
  onChange,
}: {
  flag: 'pick' | 'reject' | null
  onChange: (f: 'pick' | 'reject' | null) => void
}) {
  return (
    <div className="join" onClick={(e) => e.stopPropagation()}>
      <button
        className={`btn btn-xs join-item ${flag === 'pick' ? 'btn-success' : 'btn-ghost'}`}
        title="Pick (P)"
        onClick={() => onChange(flag === 'pick' ? null : 'pick')}
      >
        <Flag size={12} fill={flag === 'pick' ? 'currentColor' : 'none'} />
      </button>
      <button
        className={`btn btn-xs join-item ${flag === 'reject' ? 'btn-error' : 'btn-ghost'}`}
        title="Reject (X)"
        onClick={() => onChange(flag === 'reject' ? null : 'reject')}
      >
        <X size={12} />
      </button>
    </div>
  )
}
