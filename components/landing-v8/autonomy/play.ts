'use client'

import { useEffect, useState, type RefObject } from 'react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'

/**
 * Plays a figure once, the first time half of it is on screen, and returns
 * the latest of its `marks` (ms) that has passed: -1 before it starts,
 * Infinity once it has finished. The server, reduced motion and a figure that
 * is already on screen when the page loads all get Infinity, the finished
 * state, so nothing a visitor has seen ever plays backwards and no cell is
 * ever empty. Nothing loops (WCAG 2.2.2).
 */
export function usePlayOnce(ref: RefObject<HTMLElement | null>, marks: readonly number[], threshold = 0.5) {
  const quiet = useSettledReducedMotion()
  const [t, setT] = useState(Infinity)

  useEffect(() => {
    const el = ref.current
    if (!el || quiet) return
    // Already in view at load: stay finished.
    if (el.getBoundingClientRect().top < window.innerHeight) return
    const timers: number[] = []
    // Set back to the start before it can be seen (a frame later, outside render).
    const raf = requestAnimationFrame(() => setT(-1))
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.intersectionRatio < threshold) return
        io.disconnect()
        setT(0)
        for (const m of marks) timers.push(window.setTimeout(() => setT(m), m))
        timers.push(window.setTimeout(() => setT(Infinity), (marks[marks.length - 1] ?? 0) + 60))
      },
      { threshold: [0, threshold] },
    )
    io.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      timers.forEach((id) => window.clearTimeout(id))
    }
  }, [ref, quiet, marks, threshold])

  return quiet ? Infinity : t
}
