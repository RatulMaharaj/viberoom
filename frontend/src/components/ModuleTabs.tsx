import { LayoutGrid, SlidersHorizontal } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export function ModuleTabs({ active, imageId }: { active: 'organize' | 'edit'; imageId?: string }) {
  const navigate = useNavigate()
  return (
    <div role="tablist" className="tabs tabs-box tabs-sm">
      <button
        role="tab"
        className={`tab ${active === 'organize' ? 'tab-active' : ''}`}
        onClick={() => navigate('/')}
      >
        <LayoutGrid size={14} className="mr-1" /> Organize
      </button>
      <button
        role="tab"
        className={`tab ${active === 'edit' ? 'tab-active' : ''}`}
        onClick={() => navigate(imageId ? `/edit/${imageId}` : '/edit')}
      >
        <SlidersHorizontal size={14} className="mr-1" /> Edit
      </button>
    </div>
  )
}
