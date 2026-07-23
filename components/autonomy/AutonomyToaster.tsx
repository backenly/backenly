'use client'

/**
 * AUTONOMY TOASTER
 * ================
 *
 * Surfaces autonomous actions IN-FLOW. The user creates a table; five seconds
 * later a toast slides in from the corner: "Backenly added an index on
 * created_at because list queries would have slowed at scale."
 *
 * Without this, autonomy is invisible engineering — every fix lives in a
 * separate tab nobody navigates to. The toast is what sells the product.
 *
 * Behaviour:
 *   • Polls /api/projects/[id]/autonomy/events every 8 seconds while the tab
 *     is visible. Stops when hidden — no background traffic for inactive tabs.
 *   • One toast per event, stacked corner; auto-dismisses after 8 s.
 *   • The cursor (`since`) advances on each successful poll so events are
 *     shown exactly once per browser, even across React re-renders.
 *   • Suppresses on first mount — the initial poll only LEARNS the cursor and
 *     does not render historical events as toasts (those belong on the
 *     "while you were away" banner, not the corner of an active session).
 */

import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { Cpu, X } from 'lucide-react'

interface AutonomyEvent {
  id: string
  at: string
  what: string
  why: string
  full: string
  kind: string
  tableName?: string | null
}

interface VisibleToast extends AutonomyEvent {
  /** Local id so React's key is stable even if two events share the same id. */
  localKey: string
}

const POLL_INTERVAL_MS = 8000
const TOAST_TTL_MS = 8000
const MAX_VISIBLE = 3

export default function AutonomyToaster({ projectId: explicitId }: { projectId?: string }) {
  const params = useParams<{ id?: string }>()
  const projectId = explicitId ?? params?.id

  const [toasts, setToasts] = useState<VisibleToast[]>([])
  // Cursor + first-load suppression are refs so they don't trigger re-render
  // loops on every successful poll.
  const cursorRef = useRef<string | null>(null)
  const firstLoadRef = useRef<boolean>(true)
  const inflightRef = useRef<boolean>(false)

  useEffect(() => {
    if (!projectId) return
    // Anchor the cursor at component mount time. First poll learns the
    // latest event timestamp without rendering historical toasts.
    cursorRef.current = new Date().toISOString()
    firstLoadRef.current = true
    let cancelled = false

    const poll = async () => {
      if (inflightRef.current) return
      if (document.visibilityState !== 'visible') return
      inflightRef.current = true
      try {
        const url = `/api/projects/${projectId}/autonomy/events?since=${encodeURIComponent(
          cursorRef.current ?? new Date(Date.now() - 60_000).toISOString(),
        )}`
        const res = await fetch(url, { credentials: 'include' })
        if (!res.ok || cancelled) return
        const data = (await res.json()) as {
          events: AutonomyEvent[]
          nextCursor: string | null
        }
        if (data.nextCursor) cursorRef.current = data.nextCursor

        // Drop everything on first load — we only wanted the cursor anchor.
        if (firstLoadRef.current) {
          firstLoadRef.current = false
          return
        }

        if (data.events.length > 0) {
          // Newest at top — `events` already comes back desc, just stack them.
          setToasts(prev => {
            const next = [
              ...data.events.map(e => ({ ...e, localKey: `${e.id}-${Date.now()}` })),
              ...prev,
            ]
            return next.slice(0, MAX_VISIBLE)
          })
        }
      } catch {
        /* network blip — try again on next tick */
      } finally {
        inflightRef.current = false
      }
    }

    // Kick a poll right away; then on an interval.
    poll()
    const interval = setInterval(poll, POLL_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') poll()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // Reset toaster state only when the active project changes. Earlier this
    // also depended on pathname, which silently swallowed events generated
    // during a page navigation — every nav reset the cursor and treated the
    // newly-arriving events as historical (first-load suppress = dropped).
  }, [projectId])

  // Auto-dismiss the oldest toast after TTL. The interval (not setTimeout on
  // `toasts`) means a newly-arriving toast does NOT reset the dismissal clock
  // for the toasts already on screen — each one ages out independently of any
  // re-render. Avoids the "new toast freezes the old ones forever" UX bug.
  useEffect(() => {
    const interval = setInterval(() => {
      setToasts(prev => (prev.length > 0 ? prev.slice(0, -1) : prev))
    }, TOAST_TTL_MS)
    return () => clearInterval(interval)
  }, [])

  const dismiss = (key: string) =>
    setToasts(prev => prev.filter(t => t.localKey !== key))

  if (!projectId || toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-6 right-6 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-3"
    >
      {toasts.map(t => (
        <div
          key={t.localKey}
          className="pointer-events-auto rounded-lg border border-violet-500/20 bg-zinc-950/95 px-4 py-3 shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] animate-in slide-in-from-right-8 fade-in duration-300"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-violet-500/15 p-1.5">
              <Cpu className="h-3.5 w-3.5 text-violet-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-zinc-100">{t.what}</div>
              <div className="mt-1 text-xs leading-relaxed text-zinc-400">
                Because {t.why}
              </div>
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.localKey)}
              className="text-zinc-500 transition hover:text-zinc-300"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
