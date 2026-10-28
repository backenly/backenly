'use client'

import { useSyncExternalStore } from 'react'

const MINUTE = 60_000

// One timer for every countdown on the page, armed while any of them is
// mounted. It fires just after each minute boundary rather than every second:
// nothing here shows seconds, so a per-second tick would re-render for nothing.
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null

function notify() {
  listeners.forEach((listener) => listener())
}

function arm() {
  timer = setTimeout(() => {
    notify()
    arm()
  }, MINUTE - (Date.now() % MINUTE) + 50)
}

// A background tab's timers are throttled, so a tab brought back to the front
// re-reads the clock at once instead of showing a stale minute until the next
// boundary.
function onVisibilityChange() {
  if (document.visibilityState === 'visible') notify()
}

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  if (listeners.size === 1) {
    arm()
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0) {
      if (timer) clearTimeout(timer)
      timer = null
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
}

function getSnapshot() {
  return Math.floor(Date.now() / MINUTE) * MINUTE
}

/**
 * The wall clock, to the minute, for a countdown.
 *
 * `null` on the server and during hydration. The marketing pages are rendered
 * ahead of time, so the server's clock is the build's, not the visitor's; a
 * countdown printed from it would be wrong in the HTML and then disagree with
 * the first client render, which is a hydration error (see
 * useSettledReducedMotion for the same construction). Callers render their
 * resting state for `null` and the real time from the next pass.
 */
export function useMinuteClock(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}
