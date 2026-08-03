/** The channel carrying in-flight slider values to the renderer.
 *
 *  Deliberately a mutable box rather than React state. A pointer-move fires
 *  dozens of times a second, and routing each one through setState means a
 *  full re-render of the develop panel per tick — which is most of the reason
 *  the sliders felt heavy before there was any GPU work at all. The render
 *  loop polls `version` instead, so writing is free and reading is one
 *  integer comparison per frame.
 */

export interface LiveRecipe {
  current: any
  /** Bumped on every write; the render loop redraws only when it changes. */
  version: number
}

export const createLiveRecipe = (): LiveRecipe => ({ current: null, version: 0 })

export function publish(live: LiveRecipe, recipe: any): void {
  live.current = recipe
  live.version++
}

/** Immutable set-at-path that clones only the nodes along the path.
 *
 *  Replaces a `structuredClone` of the whole recipe per pointer-move: the
 *  recipe is a deep tree of a few hundred fields and almost none of them
 *  changed, so cloning all of it to write one number was pure overhead.
 */
export function setAt(obj: any, path: readonly string[], value: unknown): any {
  if (path.length === 0) return value
  const [head, ...rest] = path
  const base = obj && typeof obj === 'object' ? obj : {}
  return { ...base, [head]: setAt(base[head], rest, value) }
}
