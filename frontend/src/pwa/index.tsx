/** PWA glue: service-worker lifecycle plus the two things that have to be said
 *  over the top of the app — "there's an update" and "this browser can't".
 *
 *  It mounts its own React root into its own node rather than wrapping <App/>,
 *  so nothing about the app's tree has to know the PWA exists.
 */

import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { fileSystemAccessSupported } from '../local/handles'
import { BrowserGate } from './BrowserGate'
import { UpdatePrompt } from './UpdatePrompt'

// A background tab that has been open for a week should still notice a deploy.
const UPDATE_POLL_MS = 60 * 60 * 1000

const DISMISSED_KEY = 'viberoom-gate-dismissed'

function useServiceWorker(): { waiting: ServiceWorker | null; reload: () => void } {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)

  useEffect(() => {
    // Dev is served by Vite with no worker at all; registering one there caches
    // module URLs that change on every edit.
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

    let cancelled = false
    let timer: number | undefined

    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .then((registration) => {
        if (cancelled) return
        if (registration.waiting) setWaiting(registration.waiting)

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            // No controller means this is the first install, not an update —
            // prompting a reload there would be noise.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              setWaiting(installing)
            }
          })
        })

        const check = () => {
          if (document.visibilityState === 'visible') void registration.update()
        }
        timer = window.setInterval(check, UPDATE_POLL_MS)
        document.addEventListener('visibilitychange', check)
      })
      .catch(() => {
        // An unregisterable worker is a degraded install, not a broken app.
      })

    let reloading = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return
      reloading = true
      window.location.reload()
    })

    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [])

  return {
    waiting,
    reload: () => waiting?.postMessage('SKIP_WAITING'), // controllerchange does the reload
  }
}

function Pwa() {
  const { waiting, reload } = useServiceWorker()
  const [gated, setGated] = useState(
    () => !fileSystemAccessSupported() && sessionStorage.getItem(DISMISSED_KEY) !== '1',
  )

  return (
    <>
      {gated && (
        <BrowserGate
          onDismiss={() => {
            sessionStorage.setItem(DISMISSED_KEY, '1')
            setGated(false)
          }}
        />
      )}
      {waiting && <UpdatePrompt onReload={reload} />}
    </>
  )
}

export function installPwa(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  createRoot(host).render(<Pwa />)
}
