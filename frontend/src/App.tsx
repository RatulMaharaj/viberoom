import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Library } from './pages/Library'
import { Edit } from './pages/Edit'
import { LocalCheck } from './pages/LocalCheck'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/edit" element={<Edit />} />
        <Route path="/edit/:id" element={<Edit />} />
        <Route path="/image/:id" element={<Navigate to="/edit" replace />} />
        {/* diagnostic for the no-server path; remove once the library page uses it */}
        <Route path="/local-check" element={<LocalCheck />} />
      </Routes>
    </BrowserRouter>
  )
}
