'use client'

/**
 * DetectedFindingsPanel — the OPEN half of the one queue.
 *
 * Why this exists (2026-07-28):
 *
 * The loop's Detect node counts `open + pending_approval`, but the only queue
 * surface in the product (ReviewQueuePanel) renders the trust report's
 * `pendingApprovals` — `pending_approval` ONLY. Findings sitting at `open` were
 * rendered by Overview's Backend health block until it was deleted on
 * 2026-07-21 for saying things twice, on the stated principle that "Autonomy
 * owns the one queue". Autonomy never actually took ownership of that half, so
 * from that day an `open` finding rendered NOWHERE in the product.
 *
 * The user-visible failure: Overview says "DETECT 2 need attention" and fires
 * the "A few things to clear before launch → Open inspector" hero (which gates
 * on open findings), you land on Autonomy, and it says "Nothing waiting on
 * you". Both statements were true and the pair was unusable — the dashboard
 * pointed at a page that had been built to not show the thing it pointed at.
 *
 * So: "Waiting on you" keeps its exact meaning (needs YOUR call, nothing else
 * appears there), and this panel carries the rest. Detect's number is now
 * visibly the sum of the two cards under it.
 *
 * Data source is `/health` — the SAME endpoint the Detect node counts from,
 * deliberately, not the trust report. Two endpoints over one table on
 * independent refresh schedules is exactly what once made the loop render
 * "10 need attention · 14 of those, held for you"; the counts here cannot
 * drift from the counts above because they are the same fetch of the same rows.
 *
 * Rows are ROOT-CAUSE GROUPS (lib/core/finding-groups), same as the approval
 * queue: the loop writes one finding per affected table, so one bad policy
 * across nine tables is one row, one decision.
 *
 * Visual language: the locked flat inspector kit — #16171d surface, hairline
 * borders, mono numerals, violet for the primary action only. No gradients,
 * no glow.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Radar, RefreshCw, CheckCircle2, Loader2, XCircle, ChevronDown,
  ClipboardCopy, Check,
} from 'lucide-react'
import { KIT, KitButton } from '@/components/inspector/kit'
import {
  groupFindings, CATEGORY_LABEL, severityLabel, type FindingGroup,
} from '@/lib/core/finding-groups'

// ── Types ────────────────────────────────────────────────────────────────────

/** The /health row shape. Structurally satisfies GroupableFinding. */
interface HealthFinding {
  id: string
  type: string
  severity: string
  details: Record<string, unknown> | null
  status: string
  detectedAt: string | null
}

interface HealthPayload {
  /** TRUNCATED preview — safe to render, never to count. */
  findings?: HealthFinding[]
  /** Uncapped open + pending_approval. */
  actionableTotal?: number
  /** Uncapped pending_approval. */
  needsAttention?: number
}

type Level = 'OFF' | 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'

type RowState =
  | { phase: 'idle' }
  | { phase: 'applying' }
  | { phase: 'dismissing' }
  | { phase: 'verified' }
  | { phase: 'error'; message: string }

const CARD =
  `relative overflow-hidden ${KIT.radius} border ${KIT.border} ${KIT.surface} ${KIT.inset}`

function timeAgo(iso: string | null): string {
  if (!iso) return 'unknown'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * What the loop will do with these WITHOUT the user. Mode-dependent, because
 * claiming "Backenly fixes these itself" under Review-only would be a lie —
 * in that mode the next pass raises them for approval instead of applying.
 */
function dispositionCopy(level: Level | undefined): string {
  if (level === 'CONSERVATIVE') {
    return 'Backenly found these and has not acted. Under Review-only it raises each one for your approval on its next pass — or fix any of them now.'
  }
  if (level === 'OFF') {
    return 'Backenly found these while checking the runtime. Autonomy is off, so nothing will be applied until you pick a mode or fix them here.'
  }
  return 'Backenly found these and can fix them itself — they are queued for its next pass and need no approval from you. Fix now to skip the wait, or hand one to your coding agent.'
}

/** The prompt handed to the user's coding agent — same contract as the approval queue. */
function agentPrompt(g: FindingGroup<HealthFinding>): string {
  const head = g.members[0]
  return [
    `My Backenly backend flagged a ${g.severity} ${CATEGORY_LABEL[g.category]} issue I want addressed in my app:`,
    ``,
    `Issue: ${g.title}`,
    `Type: ${head.type}`,
    g.subjects.length > 0 ? `Affected: ${g.subjects.join(', ')}` : '',
    `Context: ${JSON.stringify(head.details ?? {}, null, 2)}`,
    ``,
    `If this belongs in the backend (schema, RLS, API, auth), tell me to run it through Backenly so the change stays governed and reversible. If it belongs in my frontend/client code, make the change directly.`,
  ].filter(Boolean).join('\n')
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function DetectedFindingsPanel({
  projectId,
  level,
}: {
  projectId: string
  level?: Level
}) {
  const [data, setData] = useState<HealthPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [rowState, setRowState] = useState<Record<string, RowState>>({})
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])

  const setRow = (id: string, s: RowState) =>
    setRowState(prev => ({ ...prev, [id]: s }))

  const fetchHealth = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true)
    setError(false)
    try {
      const res = await fetch(`/api/projects/${projectId}/health`, { credentials: 'include' })
      if (!res.ok) throw new Error('fetch failed')
      const j = await res.json()
      setData(j?.data ?? null)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [projectId])

  useEffect(() => { fetchHealth() }, [fetchHealth])

  const openFindings = useMemo(
    () => (data?.findings ?? [])
      .filter(f => f.status === 'open')
      .map(f => ({ ...f, details: f.details ?? null })),
    [data],
  )

  const groups = useMemo(() => groupFindings(openFindings), [openFindings])

  /**
   * Uncapped open count. `findings` is a 50-row preview, so measuring it would
   * silently under-report a project over the cap — the precise mistake that
   * once capped the Detect node at its preview limit. Both uncapped totals come
   * from this payload, and open = actionable − held.
   */
  const openTotal = useMemo(() => {
    if (typeof data?.actionableTotal === 'number' && typeof data?.needsAttention === 'number') {
      return Math.max(0, data.actionableTotal - data.needsAttention)
    }
    return openFindings.length
  }, [data, openFindings])

  /** One finding's fix. 409 = project lock held by a scan; ride the server's wait. */
  const fixOne = async (
    findingId: string,
    retriesLeft = 3,
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/projects/${projectId}/health/approve`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findingId }),
      })
      const j = await res.json().catch(() => ({} as any))
      if (res.ok && j?.success) return { ok: true }
      if (res.status === 409 && retriesLeft > 0) {
        await new Promise(r => { timers.current.push(setTimeout(r, 2500)) })
        return fixOne(findingId, retriesLeft - 1)
      }
      return { ok: false, error: j?.error || 'The fix could not be applied. Try again in a moment.' }
    } catch {
      return { ok: false, error: 'Network error. Check your connection and try again.' }
    }
  }

  /**
   * Sequential, not parallel — the fix path takes a project-level lock, so
   * firing a group at once would have every member after the first bounce off
   * 409 and burn its retries against its own siblings.
   */
  const fixGroup = async (g: FindingGroup<HealthFinding>) => {
    setRow(g.key, { phase: 'applying' })
    let applied = 0
    let firstError: string | undefined
    for (const m of g.members) {
      const r = await fixOne(m.id)
      if (r.ok) applied += 1
      else if (!firstError) firstError = r.error
    }

    if (applied === 0) {
      setRow(g.key, {
        phase: 'error',
        message: firstError ?? 'The fix could not be applied. Try again in a moment.',
      })
      return
    }

    setRow(g.key, { phase: 'verified' })
    const t = setTimeout(async () => {
      await fetchHealth(true)
      setRowState(prev => {
        const { [g.key]: _gone, ...rest } = prev
        return rest
      })
    }, 2400)
    timers.current.push(t)
  }

  const dismissGroup = async (g: FindingGroup<HealthFinding>) => {
    setRow(g.key, { phase: 'dismissing' })
    try {
      for (const m of g.members) {
        const res = await fetch(`/api/projects/${projectId}/health`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ findingId: m.id }),
        })
        if (!res.ok) {
          setRow(g.key, { phase: 'error', message: 'Could not dismiss. Try again.' })
          return
        }
      }
      await fetchHealth(true)
      setRowState(prev => {
        const { [g.key]: _gone, ...rest } = prev
        return rest
      })
    } catch {
      setRow(g.key, { phase: 'error', message: 'Network error. Try again.' })
    }
  }

  // Nothing detected → render nothing. "Waiting on you" already owns the
  // all-clear message for this page; a second empty card would just repeat it.
  // A failed fetch is also silent: the Detect node above is the count of
  // record, and an error card here would imply findings exist that we cannot
  // show, which is a scarier claim than the one we can support.
  if (loading || error || groups.length === 0) return null

  return (
    <section className={CARD}>
      <div className="flex items-center gap-2.5 border-b border-white/[0.06] px-5 py-3.5">
        <Radar className="size-3.5 text-violet-300" />
        <h3 className="text-[13px] font-semibold tracking-tight text-zinc-100">Detected</h3>
        <span className="font-mono text-[11px] font-medium tabular-nums text-violet-300">
          {openTotal}
          {groups.length < openTotal && (
            <span className="ml-1.5 font-normal text-zinc-500">
              in {groups.length} {groups.length === 1 ? 'issue' : 'issues'}
            </span>
          )}
        </span>
        <button
          onClick={() => fetchHealth(true)}
          disabled={refreshing}
          className="ml-auto text-zinc-600 transition-colors hover:text-zinc-300 disabled:opacity-40"
          aria-label="Refresh"
        >
          <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="border-b border-white/[0.06] px-5 py-2.5">
        <p className="text-[11.5px] leading-relaxed text-zinc-500">{dispositionCopy(level)}</p>
      </div>

      <ul className="divide-y divide-white/[0.04]">
        {groups.map(g => (
          <DetectedRow
            key={g.key}
            group={g}
            state={rowState[g.key] ?? { phase: 'idle' }}
            onFix={() => fixGroup(g)}
            onDismiss={() => dismissGroup(g)}
            onResetError={() => setRow(g.key, { phase: 'idle' })}
          />
        ))}
      </ul>

      {/* The preview cap is stated rather than hidden: a project over 50
          actionable rows would otherwise look like it had exactly 50. */}
      {openTotal > openFindings.length && (
        <p className="border-t border-white/[0.06] px-5 py-2.5 font-mono text-[10.5px] text-zinc-600">
          showing {openFindings.length} of {openTotal} — the rest appear as these clear
        </p>
      )}
    </section>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────────

function DetectedRow({
  group: g,
  state,
  onFix,
  onDismiss,
  onResetError,
}: {
  group: FindingGroup<HealthFinding>
  state: RowState
  onFix: () => void
  onDismiss: () => void
  onResetError: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const head = g.members[0]
  const many = g.members.length > 1
  const sev = severityLabel(g.severity)

  if (state.phase === 'verified') {
    return (
      <li className="flex items-start gap-3 px-5 py-3.5 animate-fade-in">
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-emerald-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-zinc-200">{g.title}</p>
          <p className="mt-1 font-mono text-[10.5px] text-zinc-500">
            fixed{many ? ` · ${g.members.length} tables` : ''} · rollback snapshot captured
          </p>
        </div>
      </li>
    )
  }

  const busy = state.phase === 'applying' || state.phase === 'dismissing'

  const handToAgent = async () => {
    try {
      await navigator.clipboard.writeText(agentPrompt(g))
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard blocked — no-op */ }
  }

  return (
    <li className={`px-5 py-3.5 transition-colors ${state.phase === 'error' ? 'bg-rose-500/[0.03]' : ''}`}>
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${sev.dot} ${
            state.phase === 'applying' ? 'animate-pulse' : ''
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] leading-snug text-zinc-100">{g.title}</p>
          <p className="mt-1.5 font-mono text-[10.5px] text-zinc-600">
            {head.type} · {g.severity}
            {!many && g.subjects[0] && <> · <span className="text-zinc-500">{g.subjects[0]}</span></>}
            {' · '}{timeAgo(head.detectedAt)}
          </p>

          {many && (
            <div className="mt-2">
              <button
                onClick={() => setExpanded(v => !v)}
                aria-expanded={expanded}
                className="inline-flex items-center gap-1 text-[11.5px] font-medium text-zinc-500 transition-colors hover:text-zinc-300"
              >
                {g.members.length} findings, one cause
                <ChevronDown className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </button>
              {expanded && (
                <ul className="mt-2 space-y-1 border-l border-white/[0.08] pl-3">
                  {g.members.map((m, i) => (
                    <li key={m.id} className="font-mono text-[10.5px] leading-relaxed text-zinc-500">
                      {g.subjects[i] ?? m.type}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {state.phase === 'error' && (
            <div className="mt-2 flex items-start gap-2">
              <XCircle className="mt-px size-3.5 shrink-0 text-rose-400" />
              <p className="text-[11.5px] leading-snug text-rose-300/90">{state.message}</p>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {state.phase === 'error' ? (
            <KitButton variant="primary" onClick={onResetError}>Try again</KitButton>
          ) : (
            <>
              <KitButton variant="primary" onClick={onFix} disabled={busy}>
                {state.phase === 'applying'
                  ? <><Loader2 className="size-3.5 animate-spin" /> {many ? `Fixing ${g.members.length}…` : 'Fixing…'}</>
                  : <><CheckCircle2 className="size-3.5" /> {many ? `Fix all ${g.members.length}` : 'Fix now'}</>}
              </KitButton>
              <KitButton variant="secondary" onClick={handToAgent} disabled={busy}>
                {copied ? <Check className="size-3.5 text-emerald-400" /> : <ClipboardCopy className="size-3.5" />}
                {copied ? 'Copied' : 'Hand to my agent'}
              </KitButton>
              <KitButton variant="secondary" onClick={onDismiss} disabled={busy}>
                {state.phase === 'dismissing' ? '…' : 'Dismiss'}
              </KitButton>
            </>
          )}
        </div>
      </div>
    </li>
  )
}
