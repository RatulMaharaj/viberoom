import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Library } from './pages/Library'
import { Edit } from './pages/Edit'
import { LocalCheck } from './pages/LocalCheck'

export default function App() {
  return (
    <BrowserRouter>
      {/* The app shell, not decoration: h-screen is what bounds the height the
          loupe's max-h-full measures against. It used to live in the agent
          dock, and removing that made every preview render at natural size. */}
      <div className="h-screen flex overflow-hidden">
      <div className="flex-1 min-w-0 overflow-y-auto">
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/edit" element={<Edit />} />
        <Route path="/edit/:id" element={<Edit />} />
        <Route path="/image/:id" element={<Navigate to="/edit" replace />} />
        {/* diagnostic for the no-server path; remove once the library page uses it */}
        <Route path="/local-check" element={<LocalCheck />} />
      </Routes>
      </div>
      </div>
    </BrowserRouter>
  )
}
