'use client'

import { useEffect } from 'react'
import Lenis from 'lenis'

/**
 * Buttery momentum scrolling for the marketing site (the Linear/Vercel feel).
 *
 * Mounted inside <SiteShell>, so it covers every marketing page and never
 * touches the app dashboard (which uses a different shell — and where inertial
 * scroll would be wrong).
 *
 * Behaviour:
 *  - Honours prefers-reduced-motion: bails out entirely, leaving native scroll.
 *  - smoothWheel only. Touch stays native — Lenis touch smoothing feels laggy
 *    on phones and mobile scroll is already smooth.
 *  - Intercepts same-page hash links (nav → #capabilities, etc.) so anchor
 *    jumps glide too, offset for the sticky 76px navbar.
 *  - Framer-motion whileInView reveals keep working: they use
 *    IntersectionObserver, not scroll events.
 */
export function SmoothScroll() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    // Duration-based expo glide (heavier, longer "buttery" feel than the
    // default frame-lerp, especially on a discrete mouse wheel). The founder
    // explicitly rejected lerp:0.1 as "not smooth enough" and chose this —
    // for MORE glide push duration higher (floaty past ~1.8), do NOT go back
    // to lerp. See memory project-landing-smooth-scroll.
    const lenis = new Lenis({
      duration: 1.5,
      easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      wheelMultiplier: 1,
    })

    let rafId = requestAnimationFrame(function raf(time) {
      lenis.raf(time)
      rafId = requestAnimationFrame(raf)
    })

    // Smooth in-page anchor navigation, offset for the sticky navbar.
    const NAV_OFFSET = -92
    function handleAnchorClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      const anchor = (event.target as HTMLElement | null)?.closest('a')
      if (!anchor) return

      const url = new URL(anchor.href, window.location.href)
      // Only intercept links that stay on the current page and carry a hash.
      if (url.pathname !== window.location.pathname || url.search !== window.location.search) return
      if (!url.hash || url.hash === '#') return

      const target = document.querySelector(url.hash)
      if (!target) return

      event.preventDefault()
      lenis.scrollTo(target as HTMLElement, { offset: NAV_OFFSET })
      window.history.pushState(null, '', url.hash)
    }

    document.addEventListener('click', handleAnchorClick)

    return () => {
      cancelAnimationFrame(rafId)
      document.removeEventListener('click', handleAnchorClick)
      lenis.destroy()
    }
  }, [])

  return null
}
