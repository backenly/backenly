'use client'

/**
 * AUTONOMY WELCOME-BACK BANNER
 * ============================
 *
 * On a project page, ask the server "what did Backenly do since this person
 * was last here?". If anything, say it in one row at the top of the page:
 *
 *   ◔ While you were away Backenly made 3 fixes, all verified. Review       ×
 *
 * Every return visit has receipts, which is what makes autonomy read as work
 * done while you were away rather than a thing that happens only when you
 * watch.
 *
 * Rebuilt 2026-11-16 (project console, shell decisions): one row, no box, no
 * arrow; "Review" opens Autonomy, where those changes are listed with their
 * statements and Undo. Hidden on Overview, which lists them itself, and on
 * Autonomy, which is what "Review" opens.
 *
 * The words keep the server's distinction: only a change a re-check confirmed
 * is a fix. One that ran unconfirmed is "a change it could not confirm", never
 * a fix, and the server counts each kind apart (since-last-visit/route.ts).
 *
 * Storage: `last_seen_at` per project in localStorage, set when the row is
 * dismissed OR after 30 s on any project page, Overview included (seeing the
 * list there counts as seeing them), so a refresh does not show it again.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { X } from 'lucide-react'
import { FOCUS, RULE } from '@/components/console/tokens'
import { LoopMark } from '@/components/console/LoopMark'

interface BannerData {
  total: number
  /** Fixes a re-check confirmed. */
  autonomousFixes: number
  /** Changes that ran but could not be confirmed — never shown as fixes. */
  unverifiedChanges: number
  escalations: number
  shouldShow: boolean
}

const STORAGE_KEY = (projectId: string) => `backenly:autonomy:lastseen:${projectId}`
const SETTLE_MS = 30_000 // mark "seen" after 30 s on the page
/** The server reads at most this many changes; a count at the cap is a floor. */
const CHANGE_SCAN_LIMIT = 1000

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/**
 * The row's sentence, or null when there is nothing to say.
 *
 *   3 verified                 made 3 fixes, all verified
 *   1 verified                 made 1 fix, verified
 *   2 verified, 1 unconfirmed  made 2 fixes it verified and 1 change it could not confirm
 *   1 unconfirmed              made 1 change it could not confirm
 *   + 1 escalation             …, and flagged 1 problem for your review
 */
export function welcomeBackLine(d: Pick<BannerData, 'autonomousFixes' | 'unverifiedChanges' | 'escalations'>): string | null {
  const verified = Math.max(0, d.autonomousFixes | 0)
  const unconfirmed = Math.max(0, d.unverifiedChanges | 0)
  const escalated = Math.max(0, d.escalations | 0)
  const atLeast = verified + unconfirmed >= CHANGE_SCAN_LIMIT ? 'at least ' : ''
  const parts: string[] = []
  if (verified > 0 && unconfirmed === 0) {
    parts.push(verified === 1 && !atLeast ? 'made 1 fix, verified' : `made ${atLeast}${plural(verified, 'fix', 'fixes')}, all verified`)
  } else if (verified > 0) {
    parts.push(`made ${atLeast}${plural(verified, 'fix', 'fixes')} it verified and ${plural(unconfirmed, 'change', 'changes')} it could not confirm`)
  } else if (unconfirmed > 0) {
    parts.push(`made ${atLeast}${plural(unconfirmed, 'change', 'changes')} it could not confirm`)
  }
  if (escalated > 0) parts.push(`flagged ${plural(escalated, 'problem', 'problems')} for your review`)
  if (parts.length === 0) return null
  return `While you were away Backenly ${parts.join(', and ')}.`
}

/** Backenly's mark: the one place violet means "Backenly did this". The loop's ring, at rest. */
function BackenlyMark() {
  return <LoopMark state="still" size={13} />
}

export default function AutonomyWelcomeBackBanner() {
  const params = useParams<{ id?: string }>()
  const pathname = usePathname() ?? ''
  const projectId = params?.id
  const [data, setData] = useState<BannerData | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!projectId) return

    let lastSeen: string | null = null
    try {
      lastSeen = window.localStorage.getItem(STORAGE_KEY(projectId))
    } catch {
      // Blocked storage: ask about the last day, as on a first visit.
    }
    const since = lastSeen ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    let cancelled = false
    fetch(`/api/projects/${projectId}/autonomy/since-last-visit?since=${encodeURIComponent(since)}`, {
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setData(d as BannerData)
      })
      .catch(() => {
        /* network blip — skip the row this load */
      })

    // Settle the cursor after the person has been on the page long enough to
    // have seen what happened, even without dismissing. Without this, every
    // fast page hop reloads the same row.
    const settleTimer = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY(projectId), new Date().toISOString())
      } catch {
        /* non-fatal */
      }
    }, SETTLE_MS)

    return () => {
      cancelled = true
      clearTimeout(settleTimer)
    }
  }, [projectId])

  const onDismiss = () => {
    setDismissed(true)
    if (!projectId) return
    try {
      window.localStorage.setItem(STORAGE_KEY(projectId), new Date().toISOString())
    } catch {
      /* non-fatal */
    }
  }

  if (!projectId || !data || !data.shouldShow || dismissed) return null
  const base = `/app/projects/${projectId}`
  // Overview lists these changes itself, and Autonomy is where "Review" goes.
  if (pathname === base || pathname === `${base}/` || pathname.startsWith(`${base}/autonomy`)) return null
  const line = welcomeBackLine(data)
  if (!line) return null

  return (
    // Marks and close sit on the first line when a phone wraps the sentence.
    <div role="status" className={`flex min-h-[44px] items-start gap-2.5 border-b ${RULE} py-3 pl-4 pr-2 sm:pl-5`}>
      <span className="mt-[4px] flex">
        <BackenlyMark />
      </span>
      <p className="min-w-0 flex-1 text-[13px] leading-[20px] text-zinc-300">
        {line}{' '}
        <Link
          href={`${base}/autonomy`}
          className={`whitespace-nowrap rounded-[4px] font-medium text-zinc-50 underline-offset-[3px] transition-colors hover:underline ${FOCUS}`}
        >
          Review
        </Link>
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className={`-my-1 inline-flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-[7px] text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200 ${FOCUS}`}
      >
        <X aria-hidden className="h-4 w-4" strokeWidth={1.75} />
      </button>
    </div>
  )
}
