import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Library } from './pages/Library'
import { Edit } from './pages/Edit'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/edit" element={<Edit />} />
        <Route path="/edit/:id" element={<Edit />} />
        <Route path="/image/:id" element={<Navigate to="/edit" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
