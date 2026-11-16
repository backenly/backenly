'use client'

/**
 * <Time iso mode>: a moment on screen, said the console's way (format.ts),
 * with the exact timestamp on hover and for screen readers.
 *
 *   <Time iso={run.startedAt} mode="clockSeconds" />    2:18:41 AM
 *   <Time iso={fetchedAt} prefix="Updated" />            Updated 12 s ago
 *
 * Relative times re-render every 30 s from one shared clock, however many are
 * on the page. A server-rendered moment is written after hydration, in the
 * viewer's own time zone, so the server's zone never shows and never causes a
 * hydration mismatch.
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import { formatTime, fullTime, toDate, type Moment, type TimeMode } from './format'

/** How often relative times are rewritten (decision 13). */
const TICK_MS = 30_000

let tick = 0
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function subscribeTick(listener: () => void): () => void {
  listeners.add(listener)
  if (!timer) {
    timer = setInterval(() => {
      tick += 1
      listeners.forEach((l) => l())
    }, TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

const subscribeNever = () => () => {}
const getTick = () => tick
/** -1 while hydrating server HTML: nothing time-zone dependent is written yet. */
const getServerTick = () => -1

/**
 * The current time, re-read every 30 s while `live`, or null while the page
 * is still hydrating server HTML. For a component that needs a ticking "now"
 * of its own ("Next attempt in 3 min").
 */
export function useNow(live = true): number | null {
  const t = useSyncExternalStore(live ? subscribeTick : subscribeNever, getTick, getServerTick)
  // Reading the clock is the point; `t` changing is what re-renders it.
  // eslint-disable-next-line react-hooks/purity
  return t < 0 ? null : Date.now()
}

export interface TimeProps {
  /** The moment, as the API sent it. Missing or invalid renders `fallback`. */
  iso: Moment | null | undefined
  mode?: TimeMode
  /** Read in UTC (schedules); clock modes end in " UTC". */
  utc?: boolean
  /** Words before the time, inside the same element: "Updated" → "Updated 12 s ago". */
  prefix?: string
  /** What to show when there is no moment. Nothing by default. */
  fallback?: ReactNode
  className?: string
}

export function Time({ iso, mode = 'ago', utc = false, prefix, fallback = null, className = '' }: TimeProps) {
  // Only times that read against "now" need the clock to tick.
  const live = mode === 'ago' || mode === 'day'
  const now = useNow(live)
  const d = toDate(iso)
  if (!d) return <>{fallback}</>
  if (now === null) {
    // Hydrating: the same empty element on server and client, filled in right after.
    return <time dateTime={d.toISOString()} className={className} />
  }
  const text = formatTime(d, mode, { now, utc })
  const full = fullTime(d, { utc })
  // A relative time drops the moment itself; screen readers hear it after the words.
  const relative = mode === 'ago' && (text === 'just now' || text.endsWith(' ago'))
  return (
    <time dateTime={d.toISOString()} title={full} className={`tabular-nums ${className}`}>
      {prefix ? `${prefix} ` : ''}
      {text}
      {relative && <span className="sr-only">, {formatTime(d, 'dateTime', { now, utc })}</span>}
    </time>
  )
}
