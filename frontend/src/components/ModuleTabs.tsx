import { LayoutGrid, SlidersHorizontal } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export function ModuleTabs({ active, imageId }: { active: 'catalog' | 'develop'; imageId?: string }) {
  const navigate = useNavigate()
  return (
    <div className="join shrink-0">
      <button
        className={`btn btn-sm join-item ${active === 'catalog' ? 'btn-primary' : ''}`}
        onClick={() => navigate('/')}
      >
        <LayoutGrid size={14} /> Catalog
      </button>
      <button
        className={`btn btn-sm join-item ${active === 'develop' ? 'btn-primary' : ''}`}
        onClick={() => navigate(imageId ? `/edit/${imageId}` : '/edit')}
      >
        <SlidersHorizontal size={14} /> Develop
      </button>
    </div>
  )
}
