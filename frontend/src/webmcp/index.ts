/** WebMCP: hand Viberoom's own capabilities to whatever agent the browser
 *  provides, instead of embedding an agent in the page.
 *
 *  `navigator.modelContext` is a W3C Community Group Draft — not a standard,
 *  not on the standards track, expected around Chrome 146. So this is entirely
 *  opt-in on the browser's side: where the API is absent, `installWebMcp()`
 *  returns 0 and the app is untouched.
 */

import { tools } from './tools'

let installed = 0

export function installWebMcp(): number {
  const ctx = navigator.modelContext
  if (!ctx) return 0

  // React 18 StrictMode mounts twice in dev, and a hot reload re-runs this
  // module; provideContext replaces the whole set rather than appending, so a
  // second call is harmless — but the guard keeps the count honest.
  if (installed) return installed

  ctx.provideContext({ tools })
  installed = tools.length
  // The bundle has no stable module handle, so hang the introspection helpers
  // somewhere a person can reach them from devtools.
  ;(window as unknown as Record<string, unknown>).viberoomWebmcp = {
    count: webmcpToolCount,
    names: webmcpToolNames,
  }
  return installed
}

/** How many tools are actually live. Nothing here can be tested without a
 *  browser that ships the API, so this exists to answer "did it register?"
 *  from the console. */
export function webmcpToolCount(): number {
  return installed
}

/** The names, for the same reason. */
export function webmcpToolNames(): string[] {
  return tools.map((t) => t.name)
}
