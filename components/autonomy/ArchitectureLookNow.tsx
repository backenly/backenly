'use client'

/**
 * When Backenly last looked for architecture changes, and a way to ask for a
 * look now.
 *
 * Production QA (2026-11-09): the look ran once a day and the console offered
 * no way to ask for one; the route's `assess` was there, reachable only by
 * calling it. The Architecture changes card stays as it is, shown only when
 * there are changes; this line is always on the Autonomy page.
 *
 * Only an organization admin may ask (the route's floor), and a look runs at
 * most every 10 minutes per project; the route says when the next may start.
 * A look that finds a change worth making puts it in "Waiting on you", which
 * re-reads.
 *
 * Since 2026-11-16 it is the third line of Autonomy's Checks section
 * ("Every day  Architecture review ran 3 h ago.  [Look now]"), drawn by
 * CheckLine (components/autonomy/CheckLine.tsx).
 */

import { useEffect, useState } from 'react'
import { KitButton } from '@/components/inspector/kit'
import { formatTime } from '@/components/console/format'
import { announceArchitectureChange } from '@/components/autonomy/architecture-decisions'
import { CheckLine } from '@/components/autonomy/CheckLine'

interface LookAnswer {
  ok?: boolean
  requested?: number
  message?: string
  error?: string
}

export function ArchitectureLookNow({
  projectId,
  onLooked,
  canLook = true,
  as = 'div',
}: {
  projectId: string
  onLooked: () => void
  /** Asking takes an organization admin; others read the line without the button. */
  canLook?: boolean
  /** 'li' inside the Checks list. */
  as?: 'li' | 'div'
}) {
  // undefined until read; null when Backenly has not looked yet.
  const [analyzedAt, setAnalyzedAt] = useState<string | null | undefined>(undefined)
  const [reads, setReads] = useState(0)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/architecture`, { credentials: 'include' })
        if (!res.ok) return
        const summary = (await res.json()) as { analyzedAt?: string | null }
        if (!cancelled) setAnalyzedAt(summary.analyzedAt ?? null)
      } catch {
        // The line says nothing rather than something untrue.
      }
    }
    read()
    return () => {
      cancelled = true
    }
  }, [projectId, reads])

  const look = async () => {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/architecture`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'assess' }),
      })
      const answer = ((await res.json().catch(() => ({}))) ?? {}) as LookAnswer
      if (res.status === 403) {
        setNote('Only an organization admin can ask Backenly to look.')
      } else if (!res.ok || !answer.ok) {
        setNote(answer.error || 'The look did not start. Try again in a moment.')
      } else if (answer.message) {
        setNote(answer.message)
      } else if ((answer.requested ?? 0) > 0) {
        const n = answer.requested!
        setNote(`Found ${n} ${n === 1 ? 'change' : 'changes'} worth making. ${n === 1 ? 'It is' : 'They are'} waiting on you above.`)
        onLooked()
        announceArchitectureChange('card')
      } else {
        setNote('Looked just now. No change is worth making right now.')
      }
      setReads((n) => n + 1)
    } catch {
      setNote('Network error. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (analyzedAt === undefined) return null

  return (
    <CheckLine
      as={as}
      cadence="Every day"
      action={
        canLook ? (
          <KitButton variant="secondary" size="sm" loading={busy} onClick={look}>
            Look now
          </KitButton>
        ) : undefined
      }
      note={note}
    >
      {analyzedAt
        ? `Architecture review ran ${formatTime(analyzedAt, 'ago')}.`
        : 'Architecture review has not run yet.'}
    </CheckLine>
  )
}
