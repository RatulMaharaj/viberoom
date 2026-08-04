/** Which source we got, as a value components can read synchronously.
 *
 *  `getSource()` is a promise, so every component that wanted to know resolved
 *  it into `useState` and read `source?.kind === 'local'` on the way. That
 *  expression is `false` on the first render — not because there is a server,
 *  but because nothing has been asked yet — and four separate bugs came from
 *  code acting on that `false`: a PWA firing `/source` and `/preview` at a
 *  backend that is not there, EventSource pointed at a static host that
 *  answers `/events` with HTML, a server-only picker probe on mount, and the
 *  loupe falling through to the server's preview URL.
 *
 *  So "unknown" is a state here, and it is not a boolean. `$sourceMode` is
 *  `'server' | 'local' | 'unknown'`, which means the mistake does not compile:
 *  a `boolean` prop or an `enabled:` flag will not take it, and the call site
 *  has to say which of the three it means. Guards stop being something you
 *  remember to add.
 */

import { atom, computed, onMount, type ReadableAtom } from 'nanostores'
import { useStore } from '@nanostores/react'
import { getSource, type PhotoSource } from '../source'

/** The third value is the point. Compare against it, never coerce it. */
export type SourceMode = 'server' | 'local' | 'unknown'

const $resolved = atom<PhotoSource | null>(null)

// Lazy and once: nanostores runs this when the first listener attaches, and
// `getSource()` caches its probe anyway, so mounting fifty components still
// hits `/api/v1/library` a single time.
onMount($resolved, () => {
  getSource().then((s) => $resolved.set(s)).catch(() => {})
})

/** The resolved source, or null while the probe is still out.
 *
 *  Nullable on purpose: the components that hand the source to something else
 *  (`useThumbnails`, `subscribe`) need the object, and `null` there is an
 *  explicit "nothing to hand over yet" rather than a silent wrong answer. Use
 *  `$sourceMode` for decisions about *which* source it is.
 */
export const $source: ReadableAtom<PhotoSource | null> = $resolved

export const $sourceMode: ReadableAtom<SourceMode> = computed(
  $resolved,
  (s) => s?.kind ?? 'unknown',
)

export function useSource(): PhotoSource | null {
  return useStore($source)
}

export function useSourceMode(): SourceMode {
  return useStore($sourceMode)
}

/** For everything outside a component — `selection.ts`, `local/**`, the WebMCP
 *  handlers, click handlers that must branch before a render can happen. They
 *  are already awaiting; there is no first-render hole for them to fall in. */
export { getSource }
