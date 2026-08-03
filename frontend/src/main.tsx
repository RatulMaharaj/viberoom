import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installPwa } from './pwa'
import { installWebMcp } from './webmcp'

// Render first. Both installers below touch experimental browser APIs, and
// calling them at module scope beforehand meant one throw took the whole app
// down with a blank page — which is what happened the first time WebMCP was
// actually enabled and provideContext ran for real instead of being skipped.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

for (const install of [installPwa, installWebMcp]) {
  try {
    install()
  } catch (err) {
    // A service worker that will not register, or an agent API that rejects
    // our tools, is a missing feature — not a reason to lose the editor.
    console.warn(`${install.name} failed`, err)
  }
}
