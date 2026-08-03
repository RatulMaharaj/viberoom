/** `<file>.vibe.json` sidecars, read and written straight from the browser.
 *
 *  Same contract as `recipe/sidecar.py`: the sidecar is the source of truth,
 *  the original is never touched, and the JSON is pretty-printed with a
 *  trailing newline so a sidecar written here diffs cleanly against one
 *  written by the server or hand-edited by an agent.
 */

import { defaultRecipe } from './recipe'
import { SIDECAR_SUFFIX, type ScannedFile } from './scan'

export type Flag = 'pick' | 'reject' | null
export type Label = 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null

export interface Sidecar {
  version: number
  rating: number
  flag: Flag
  label: Label
  keywords: string[]
  iptc: Record<string, string | null>
  recipe: Record<string, any>
  snapshots: Record<string, any>
  variants: Record<string, any>
  history: { at: string; recipe: Record<string, any> }[]
}

export function defaultSidecar(): Sidecar {
  return {
    version: 1,
    rating: 0,
    flag: null,
    label: null,
    keywords: [],
    iptc: { title: null, caption: null, copyright: null, creator: null },
    recipe: defaultRecipe(),
    snapshots: {},
    variants: {},
    history: [],
  }
}

const sidecarName = (filename: string) => filename + SIDECAR_SUFFIX

/** Load a sidecar, or defaults if it is missing or malformed. A sidecar being
 *  rewritten by an agent mid-read must never take the app down — same rule the
 *  Python loader follows. */
export async function loadSidecar(file: ScannedFile): Promise<Sidecar> {
  try {
    const handle = await file.dir.getFileHandle(sidecarName(file.filename))
    const text = await (await handle.getFile()).text()
    return { ...defaultSidecar(), ...JSON.parse(text) }
  } catch {
    return defaultSidecar()
  }
}

export async function saveSidecar(file: ScannedFile, sidecar: Sidecar): Promise<void> {
  const handle = await file.dir.getFileHandle(sidecarName(file.filename), { create: true })
  const stream = await handle.createWritable()
  await stream.write(JSON.stringify(sidecar, null, 2) + '\n')
  await stream.close()
}
