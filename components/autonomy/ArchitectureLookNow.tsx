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
 */

import { useEffect, useState } from 'react'
import { ScanSearch } from 'lucide-react'
import { KitButton } from '@/components/inspector/kit'
import { ago } from '@/components/changes/present'
import { announceArchitectureChange } from '@/components/autonomy/architecture-decisions'
import { PANEL } from '@/components/autonomy/rows'

interface LookAnswer {
  ok?: boolean
  requested?: number
  message?: string
  error?: string
}

export function ArchitectureLookNow({ projectId, onLooked }: { projectId: string; onLooked: () => void }) {
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
    <section aria-label="Architecture review">
      <div className={`${PANEL} flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5`}>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-[20px] text-zinc-100">Architecture review</p>
          <p className="mt-0.5 text-[12.5px] leading-[18px] text-faint">
            {analyzedAt
              ? `Backenly last looked for changes worth making ${ago(analyzedAt)}. It looks every day.`
              : 'Backenly has not looked for changes worth making yet. It looks every day.'}
          </p>
        </div>
        <KitButton variant="secondary" size="sm" icon={ScanSearch} loading={busy} onClick={look}>
          Look now
        </KitButton>
      </div>
      {note && (
        <p role="status" className="mt-2 text-[12.5px] leading-[18px] text-faint">
          {note}
        </p>
      )}
    </section>
  )
}
