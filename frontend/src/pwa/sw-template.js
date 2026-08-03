/* Service worker source. Not built by Vite as a module: the `pwa()` plugin in
 * vite.config.ts substitutes the placeholders below with the real base path and
 * the hashed filenames of the build, then emits the result as `sw.js` at the
 * root of the output — so this file is plain ES5-ish worker script, not TS.
 *
 * Update policy: this worker never calls skipWaiting() on its own. A new build
 * installs, then *waits*, and the page shows "a new version is ready". That is
 * deliberate — swapping the shell under a running editor would leave a page
 * whose already-loaded chunks no longer exist in any cache.
 */

const BASE = '__BASE__'
const VERSION = '__VERSION__'
const PRECACHE = __PRECACHE__

const CACHE = `viberoom-${VERSION}`
const SHELL = `${BASE}index.html`

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // `reload` bypasses the HTTP cache: a 304 from a stale disk entry would
      // precache exactly the bytes this update is meant to replace.
      cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))),
    ),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('viberoom-') && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

/** Cache-first with a background fill. Everything under BASE is either a
 *  content-hashed build asset or a static public file, so a cache hit is
 *  always correct for the version that installed it. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request, { ignoreSearch: true })
  if (hit) return hit
  const response = await fetch(request)
  // LibRaw's wasm and its worker chunk arrive here rather than in PRECACHE
  // when the app loads them lazily — caching opaque-free same-origin 200s is
  // what makes RAW decoding survive going offline.
  if (response.ok && response.type === 'basic') cache.put(request, response.clone())
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith(BASE)) return
  // The Python companion is a live server; caching its responses would hand
  // the UI a stale catalog.
  if (url.pathname.startsWith(`${BASE}api/`)) return

  if (request.mode === 'navigate') {
    // SPA routes (/edit/:id) have no file behind them; the shell is the answer
    // for every navigation, exactly as SPAStaticFiles does server-side.
    event.respondWith(caches.open(CACHE).then((c) => c.match(SHELL)).then((hit) => hit || fetch(request)))
    return
  }

  event.respondWith(cacheFirst(request))
})
