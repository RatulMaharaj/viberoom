import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = fileURLToPath(new URL('.', import.meta.url))

// The same build is served two ways: FastAPI mounts dist/ at the site root, and
// GitHub Pages serves it from /<repo>/. Everything that resolves a URL — Vite's
// asset rewriting, the service worker scope, the registration path — hangs off
// this one value. The manifest needs no help: its URLs are relative, so they
// resolve against wherever the manifest itself lands.
const base = process.env.VITE_BASE ?? '/'

const PUBLIC_PRECACHE = ['favicon.png', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']

function walk(dir: string): string[] {
  let out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out = out.concat(walk(full).map((p) => `${entry}/${p}`))
    else out.push(relative(dir, full))
  }
  return out
}

/** Emit `sw.js` with the build's real filenames baked in. Hand-written worker,
 *  no plugin dependency — see src/pwa/sw-template.js. */
function serviceWorker(): Plugin {
  return {
    name: 'viberoom-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => name !== 'sw.js' && !name.endsWith('.map'))
        .map((name) => base + name)

      // Fonts live in public/ and never reach the bundle graph, but a missing
      // brand font offline is the most visible kind of broken.
      const fonts = walk(join(here, 'public', 'fonts'))
        .filter((p) => p.endsWith('.woff2'))
        .map((p) => `${base}fonts/${p}`)

      // index.html is not in `bundle` yet — Vite emits it after this hook — but
      // it is the shell every offline navigation is answered with.
      // `base` only: /index.html redirects to / on most static hosts, and a
      // cached redirect cannot be served to a navigation.
      const precache = [base, ...assets, ...PUBLIC_PRECACHE.map((f) => base + f), ...fonts]
      // Any asset hash change changes this, which changes the cache name, which
      // is what makes the waiting worker a *new* worker the browser notices.
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12)

      const source = readFileSync(join(here, 'src', 'pwa', 'sw-template.js'), 'utf8')
        .replace('__BASE__', base)
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(precache))

      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), serviceWorker()],
  server: {
    port: 7666, // ROOM on a phone keypad
    proxy: {
      '/api': 'http://127.0.0.1:8423', // VIBE
    },
  },
})
