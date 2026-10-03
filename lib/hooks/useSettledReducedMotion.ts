'use client'

import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function subscribe(onChange: () => void) {
  const query = window.matchMedia(QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function getSnapshot() {
  return window.matchMedia(QUERY).matches
}

/**
 * `prefers-reduced-motion`, read in a way that cannot break hydration.
 *
 * Framer's `useReducedMotion()` resolves the media query during the very first
 * client render. The server has no media query and always renders the
 * non-reduced branch, so any component that lets the result pick its element
 * type, its `initial` prop, or its TEXT disagrees with the server on that
 * first pass. On the marketing pages that produced React #425 / #418 / #423
 * for every reduced-motion visitor, and #423 means the root gives up and
 * re-renders the whole page on the client.
 *
 * `useSyncExternalStore` fixes it by construction: React uses the SERVER
 * snapshot during hydration too, so the first client pass returns `false`
 * exactly like the server did, and only the pass afterwards sees the real
 * setting.
 *
 * The tradeoff is deliberate. A reduced-motion visitor gets one frame of the
 * unreduced resting state before it settles, which is why this is named
 * "settled" rather than being a drop-in alias. Use it for anything whose
 * rendered output differs under reduced motion; it is not needed for CSS-only
 * treatments, where `motion-reduce:` variants already do the right thing with
 * no JavaScript at all.
 */
export function useSettledReducedMotion() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
