/**
 * Iconify offline registry.
 *
 * The marketing site uses ~34 icons across Solar + Remix collections.
 * Default @iconify/react lazy-fetches them from api.iconify.design at
 * runtime, which leaves blank boxes during the first paint.
 *
 * `data.json` here is a pre-extracted slice of the two collections
 * containing only the icons we actually reference. Generated from
 * @iconify-json/solar + @iconify-json/ri (full bundles are ~7 MB
 * combined; this slice is ~22 KB).
 *
 * To add a new icon: append its name to scripts/extract-icons.mjs and
 * re-run it, or extend the inline node one-liner in the commit history.
 */
import { addCollection } from '@iconify/react'
import data from './data.json'

let registered = false

export function registerSiteIcons() {
  if (registered) return
  registered = true

  addCollection(data.solar as Parameters<typeof addCollection>[0])
  addCollection(data.ri as Parameters<typeof addCollection>[0])
  if ((data as { si?: unknown }).si) {
    addCollection((data as { si: Parameters<typeof addCollection>[0] }).si)
  }
}
