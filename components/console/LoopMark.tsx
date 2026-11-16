'use client'

/**
 * Backenly's self-healing mark: a small ring whose violet arc fills over the
 * minute between two passes of the loop, and starts again at each pass. It
 * replaces the ✦ that read as a generic "AI" sparkle. It is telemetry, not
 * decoration: the arc is aligned to the real last pass, so a full ring means
 * the next check is due now.
 *
 *   ◔ Autopilot   Checked 36 s ago
 *
 * 'running' animates; 'still' draws a resting arc (first check, a stale loop,
 * or reduced motion); 'off' is the bare ring, because Backenly is not acting.
 */

import { useEffect, useRef } from 'react'

/** The loop checks every project once a minute (Autonomy → Checks: "Every minute"). */
export const LOOP_PERIOD_MS = 60_000

export type LoopMarkState = 'running' | 'still' | 'off'

/** Where in the current minute the loop is, 0..1, aligned to its last real pass. */
export function loopFraction(lastPassAt: string | null | undefined, now = Date.now()): number {
  const last = lastPassAt ? Date.parse(lastPassAt) : NaN
  if (!Number.isFinite(last)) return 0
  const elapsed = (((now - last) % LOOP_PERIOD_MS) + LOOP_PERIOD_MS) % LOOP_PERIOD_MS
  return elapsed / LOOP_PERIOD_MS
}

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

export function LoopMark({
  lastPassAt,
  state = 'running',
  size = 14,
  className = '',
}: {
  lastPassAt?: string | null
  state?: LoopMarkState
  size?: number
  className?: string
}) {
  const arc = useRef<SVGCircleElement>(null)

  useEffect(() => {
    const el = arc.current
    if (!el || state !== 'running' || reducedMotion() || typeof el.animate !== 'function') return
    const elapsed = loopFraction(lastPassAt) * LOOP_PERIOD_MS
    const anim = el.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], {
      duration: LOOP_PERIOD_MS,
      iterations: Infinity,
      delay: -elapsed,
      easing: 'linear',
    })
    return () => anim.cancel()
  }, [lastPassAt, state])

  return (
    <svg aria-hidden viewBox="0 0 16 16" width={size} height={size} className={`flex-shrink-0 ${className}`} fill="none">
      <circle cx="8" cy="8" r="6" stroke="rgba(255,255,255,0.16)" strokeWidth="1.6" />
      {state !== 'off' && (
        <circle
          ref={arc}
          cx="8"
          cy="8"
          r="6"
          stroke="#a78bfa"
          strokeWidth="1.6"
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray="1 1"
          strokeDashoffset={0.28}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  )
}
