import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AgentDock } from './components/AgentDock'
import { Library } from './pages/Library'
import { Edit } from './pages/Edit'

export default function App() {
  return (
    <BrowserRouter>
      <AgentDock>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/edit" element={<Edit />} />
        <Route path="/edit/:id" element={<Edit />} />
        <Route path="/image/:id" element={<Navigate to="/edit" replace />} />
      </Routes>
      </AgentDock>
    </BrowserRouter>
  )
}
