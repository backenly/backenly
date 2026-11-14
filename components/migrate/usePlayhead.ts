'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * A clock for a picture that plays: seconds since it started, advanced on
 * animation frames only while `running`. With `loop`, it holds the last frame
 * for `hold` seconds and starts again. React state changes about ten times a
 * second, not every frame: the counters step in batches anyway, and the bars
 * ease between steps on the compositor.
 */
export function usePlayhead({
  duration,
  running,
  loop = false,
  hold = 3,
  speed = 1,
  start = 0,
  resetKey,
}: {
  duration: number
  running: boolean
  loop?: boolean
  hold?: number
  speed?: number
  start?: number
  /** Changing it starts the picture over (a different source was picked). */
  resetKey?: string
}): number {
  const [t, setT] = useState(start)
  const tRef = useRef(start)
  // A new source starts the picture over: adjusted while rendering, the way
  // React recommends for state that follows a prop, not in an effect.
  const [shownKey, setShownKey] = useState(resetKey)
  if (shownKey !== resetKey) {
    setShownKey(resetKey)
    setT(start)
  }
  useEffect(() => {
    tRef.current = start
  }, [resetKey, start])

  useEffect(() => {
    if (!running) return
    let raf = 0
    let last = performance.now()
    let sinceCommit = 0
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      let next = tRef.current + dt * speed
      if (next >= duration + (loop ? hold : 0)) {
        next = loop ? 0 : duration
      }
      tRef.current = next
      sinceCommit += dt
      if (sinceCommit >= 0.1 || next === 0 || next === duration) {
        sinceCommit = 0
        setT(next)
      }
      if (!loop && next >= duration) return
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [running, loop, hold, speed, duration])

  return t
}

/** "2:41" for a number of seconds. */
export function clockOf(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
