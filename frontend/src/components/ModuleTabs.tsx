import { LayoutGrid, SlidersHorizontal } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { loadLastImage } from '../selection'

export function ModuleTabs({ active, imageId }: { active: 'catalog' | 'develop'; imageId?: string }) {
  const navigate = useNavigate()
  return (
    <div className="flex items-center gap-1 shrink-0">
    <div className="join shrink-0">
      <button
        className={`btn btn-sm join-item ${active === 'catalog' ? 'btn-primary' : ''}`}
        onClick={() => navigate('/')}
      >
        <LayoutGrid size={14} /> Catalog
      </button>
      <button
        className={`btn btn-sm join-item ${active === 'develop' ? 'btn-primary' : ''}`}
        onClick={() => {
          const target = imageId ?? loadLastImage()
          navigate(target ? `/edit/${target}` : '/edit')
        }}
      >
        <SlidersHorizontal size={14} /> Develop
      </button>
    </div>
    </div>
  )
}
