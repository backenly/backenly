'use client'

/**
 * AUTONOMY WELCOME-BACK BANNER
 * ============================
 *
 * On every project page load, ask the server "what did Backenly do since the
 * last time this user was here?". If the answer is non-zero, show one calm
 * banner at the top of the page: "Backenly did 7 things while you were away."
 *
 * This is what creates the "AI engineer working full-time" feeling — every
 * return visit has receipts. Without it, autonomy reads as a thing that
 * happens only when you're watching.
 *
 * Storage:
 *   • `last_seen_at` per project in localStorage. We set it when the banner
 *     is dismissed OR when the user has been on the page for >30 s (i.e.
 *     they've seen the events and we shouldn't show them again on refresh).
 */

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Cpu, X, ArrowRight } from 'lucide-react'

interface BannerData {
  total: number
  autonomousFixes: number
  escalations: number
  rollbacks: number
  headline: string
  examples: Array<{ id: string; at: string; what: string; why: string; full: string }>
  shouldShow: boolean
}

const STORAGE_KEY = (projectId: string) => `backenly:autonomy:lastseen:${projectId}`
const SETTLE_MS = 30_000 // mark "seen" after 30 s on the page

export default function AutonomyWelcomeBackBanner() {
  const params = useParams<{ id?: string }>()
  const projectId = params?.id
  const [data, setData] = useState<BannerData | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!projectId) return

    const lastSeen = typeof window !== 'undefined'
      ? window.localStorage.getItem(STORAGE_KEY(projectId))
      : null
    const since = lastSeen ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    let cancelled = false
    fetch(`/api/projects/${projectId}/autonomy/since-last-visit?since=${encodeURIComponent(since)}`, {
      credentials: 'include',
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setData(d as BannerData) })
      .catch(() => { /* network blip — skip the banner this load */ })

    // Settle the cursor after the user has been on the page long enough that
    // they've effectively "seen" what happened, even if they don't click
    // dismiss. Without this, every fast page hop reloads the same banner.
    const settleTimer = setTimeout(() => {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY(projectId), new Date().toISOString())
      }
    }, SETTLE_MS)

    return () => {
      cancelled = true
      clearTimeout(settleTimer)
    }
  }, [projectId])

  const onDismiss = () => {
    setDismissed(true)
    if (projectId && typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY(projectId), new Date().toISOString())
    }
  }

  if (!projectId || !data || !data.shouldShow || dismissed) return null

  return (
    <div className="mx-4 mt-4 rounded-lg border border-violet-500/15 bg-[#16171d] px-4 py-3 sm:mx-6 lg:mx-8">
      <div className="flex items-start gap-3">
        <Cpu className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-violet-300/80" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-zinc-100">{data.headline}</div>
          {data.examples.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setExpanded(e => !e)}
                className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-violet-300/90 hover:text-violet-200"
              >
                {expanded ? 'Hide details' : `See ${data.examples.length} ${data.examples.length === 1 ? 'item' : 'items'}`}
                <ArrowRight className={`h-3 w-3 transition ${expanded ? 'rotate-90' : ''}`} />
              </button>
              {expanded && (
                <ul className="mt-3 space-y-2">
                  {data.examples.map(e => (
                    <li key={e.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                      <div className="text-[11.5px] font-medium text-zinc-200">{e.what}</div>
                      <div className="mt-0.5 text-[11.5px] leading-relaxed text-zinc-500">Because {e.why}</div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-zinc-500 transition hover:text-zinc-300"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
