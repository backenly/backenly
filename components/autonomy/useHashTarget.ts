'use client'

import { useEffect, useState } from 'react'

/**
 * Lands on the row a link points at: Overview's "Waiting on you" opens
 * /autonomy#approval-<id>, a fix links to #fix-<findingId>, a finding to
 * #finding-<groupKey>. The rows arrive after the page does, so the browser's
 * own jump to the fragment finds nothing. This waits for the row (up to
 * `waitMs`), brings it into view, and lights it for a moment through the
 * row's `data-target` (components/autonomy/rows.tsx).
 */
export function useHashTarget(ready: boolean, waitMs = 6000): void {
  const [hash, setHash] = useState<string | null>(null)

  useEffect(() => {
    const read = () => setHash(window.location.hash ? decodeURIComponent(window.location.hash.slice(1)) : null)
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])

  useEffect(() => {
    if (!ready || !hash) return
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const started = Date.now()
    const land = () => {
      if (done) return
      const el = document.getElementById(hash)
      if (!el) {
        if (Date.now() - started < waitMs) timer = setTimeout(land, 150)
        return
      }
      done = true
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
      el.setAttribute('data-target', '')
      timer = setTimeout(() => el.removeAttribute('data-target'), 2400)
    }
    land()
    return () => {
      done = true
      if (timer) clearTimeout(timer)
    }
  }, [ready, hash, waitMs])
}
