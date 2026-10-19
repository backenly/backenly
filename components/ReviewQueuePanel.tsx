'use client'

/**
 * ReviewQueuePanel — the actionable half of what used to be AutonomyPanel.
 *
 * Autonomy's dial + guardrail config moved to Settings → Autonomy & Guardrails
 * (components/AutonomyGuardrailsSettings.tsx) — that's configuration, not
 * daily workflow. This panel is the daily workflow: changes waiting on you,
 * why each one needs your call, and one-click approve/dismiss.
 *
 * Visual language: a single self-headed inspector card (kit surface #16171d,
 * hairline borders, one soft shadow, hairline-divided rows) so it reads as one
 * product with Monitoring / Connect / the rest of the inspector — not the
 * free-floating green-button cards it used to be. It owns the ONE "Waiting on
 * you" header; the parent no longer prints a second title above it. Primary
 * action is violet everywhere (matching the Overview hero and the agent-request
 * row below it) — green is reserved for a settled, healthy result.
 *
 * Same data source as before (GET /api/projects/[id]/autonomy's
 * pendingApprovals) and the same approve/dismiss endpoints
 * (/health/approve, /health) — only the surface it lives on changed.
 *
 * SINCE 2026-07-21 this is the ONLY working queue in the product. Overview's
 * Backend health block used to render the same findings with its own set of
 * buttons; it is now a read-only summary that links here. One inbox, shown
 * once — so a count can't drift between two pages and an approval can't leave
 * a stale twin behind.
 *
 * Rows are ROOT-CAUSE GROUPS (lib/core/finding-groups), not findings. The loop
 * writes one finding per affected table because that is the unit it fixes; a
 * single wrong policy dialect therefore arrived as nine near-identical rows
 * needing nine identical approvals. A group is one row, one decision, and one
 * "Approve & fix all" that walks every member — the storage unit stays per
 * table, the decision unit becomes per cause.
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { KIT, KitButton } from '@/components/inspector/kit'
import {
  AlertTriangle, RefreshCw, CheckCircle2, Loader2, XCircle, ArrowRight,
  ChevronDown, ClipboardCopy, Check,
} from 'lucide-react'
import { groupFindings, CATEGORY_LABEL, type FindingGroup } from '@/lib/core/finding-groups'
import { hasExecutableFix } from '@/lib/core/fix-actions'

interface PendingApproval {
  id: string
  type: string
  severity: string
  detectedAt: string
  reason: string
  /** Server-computed truth about WHY this waits on a human (trust-report). */
  heldBecause?: { kind: 'escalated' | 'recurrence' | 'guardrail' | 'held'; text: string }
  source?: string
  resource?: string
  /** Always sent by the trust report; normalized to null on the way in so the
   *  grouping contract holds even against a response that predates the field. */
  details: Record<string, unknown> | null
  /** An AI-proposed repair waiting for approval of this exact version (lib/autonomy/ai-proposals.ts). */
  proposal?: { id: string; version: string; summary: string; expiresAt: string }
}

/** Senior-engineer diagnosis written onto escalated findings (escalation-diagnosis). */
interface FindingDiagnosis {
  rootCause?: string
  recommendation?: string
  /**
   * Where it came from. A deterministic investigation reached its conclusion
   * from observations it made; a model-written diagnosis is a hypothesis that
   * nothing has verified. They must never look the same on screen.
   */
  provenance: 'investigation' | 'ai_hypothesis'
  /** Observations an investigation made (its evidence trail), when recorded. */
  observations: number | null
}

interface TrustReportShape {
  pendingApprovals: PendingApproval[]
}

/**
 * A destructive operation an MCP-connected coding agent asked for. Parked
 * here for the human's call; the agent polls check_approval for the outcome.
 */
interface AgentApproval {
  id: string
  status: string
  tool: string
  target: string
  /** Absent on responses that predate it: those were all agent requests. */
  requestedBy?: 'agent' | 'backenly'
  changeId?: string | null
  rowCount: number | null
  reversible: boolean
  message: string
  createdAt: string
  expiresAt: string
  executedAt: string | null
  resultSummary: string | null
  /**
   * False when the request's exact call is kept in the project's region and
   * could not be read: the card shows only stand-ins, so it cannot be approved.
   * Absent from an older server, which kept every request on its row.
   */
  readable?: boolean
  /** The request as this card shows it, sent back with an approval so only what was shown runs. */
  shownDigest?: string | null
}

/** Per-row trust state machine — identical to the one AutonomyPanel used. */
type RowState =
  | { phase: 'idle' }
  | { phase: 'applying' }
  | { phase: 'dismissing' }
  | { phase: 'verified' }
  | { phase: 'error'; message: string }

// Fallback only — types the fix-classifier genuinely gates on approval (its
// NEEDS_APPROVAL set), for responses that predate the server-computed
// `heldBecause`. Deliberately NOT "anything auth-flavoured": types like
// rls_expression_invalid are AUTO-class — Autopilot heals them silently and
// they only appear here when a fix was tried and did not verify. Claiming
// "always requires approval" for those was false, and made Autopilot read
// like a debug agent that asks permission for everything.
const GUARDRAIL_GATED_TYPES = new Set([
  'broken_webhook', 'broken_auth', 'integration_key_invalid',
  'integration_webhook_failing', 'integration_smtp_unreachable',
  'oauth_config_invalid', 'oauth_redirect_uri_missing', 'dead_api_endpoint',
  'deploy_failure', 'auth_spike', 'auth_jwt_missing', 'auth_users_table_missing',
])

// One card shell shared by the loading / error / populated states so every
// phase of the panel reads as the same inspector surface. Composed from the
// kit's tokens so it can't drift from KitCard.
const CARD =
  `relative overflow-hidden ${KIT.radius} border ${KIT.border} ${KIT.surface} ${KIT.inset}`

/**
 * Why this specific item needs a human. Deliberately distinct from p.reason
 * (the finding's own description) so the row doesn't render the same sentence
 * twice. The truth is computed server-side (trust-report heldBecause) from
 * what actually happened — escalated-after-verification vs recurrence vs a
 * genuine guardrail gate. The local branches only cover legacy payloads.
 */
function reasonForApproval(p: PendingApproval): string {
  if (p.heldBecause?.text) return p.heldBecause.text
  const esc = (p.details as Record<string, any> | null)?.escalation as { reason?: string } | undefined
  if (esc?.reason) return esc.reason
  if (GUARDRAIL_GATED_TYPES.has(p.type)) {
    return 'Auth/security changes always require approval under your guardrails.'
  }
  if (p.severity === 'critical') {
    return 'High-risk and hard to reverse. No autonomy mode can apply this without you.'
  }
  return 'Waiting for your review.'
}

/**
 * Label chip for the hold reason — "Escalated by Autopilot" is the story that
 * separates an autonomous loop from a debug agent: it TRIED, verified, and
 * stopped honestly. Null when there's nothing more specific than "waiting".
 */
function heldKindLabel(p: PendingApproval): string | null {
  switch (p.heldBecause?.kind) {
    case 'escalated':  return 'Escalated by Autopilot after a verified fix attempt'
    case 'recurrence': return 'Fix applied but kept recurring — stopped retrying'
    case 'guardrail':  return null // the text itself already says "requires approval"
    default:           return null
  }
}

/** Diagnosis written by the escalation pass, when one exists. */
function diagnosisOf(p: PendingApproval): FindingDiagnosis | null {
  const d = (p.details as Record<string, any> | null)?.diagnosis
  if (!d || typeof d !== 'object') return null
  const rootCause = typeof d.rootCause === 'string' ? d.rootCause : undefined
  const recommendation = typeof d.recommendation === 'string' ? d.recommendation : undefined
  if (!rootCause && !recommendation) return null
  // Only the deterministic investigation is labelled as such; anything else,
  // including a diagnosis with no recorded source, is shown as a hypothesis.
  const provenance = d.model === 'deterministic-investigation' ? 'investigation' : 'ai_hypothesis'
  const observations = Array.isArray(d.evidence) ? d.evidence.length : null
  return { rootCause, recommendation, provenance, observations }
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function ReviewQueuePanel({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [data, setData] = useState<TrustReportShape | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [rowState, setRowState] = useState<Record<string, RowState>>({})
  const [banner, setBanner] = useState<{ title: string; detail?: string } | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])

  const setRow = (id: string, s: RowState) =>
    setRowState(prev => ({ ...prev, [id]: s }))

  const [agentApprovals, setAgentApprovals] = useState<AgentApproval[]>([])

  const fetchReport = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true)
    setError(false)
    try {
      const [autonomyRes, agentRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/autonomy`, { credentials: 'include' }),
        fetch(`/api/projects/${projectId}/agent-approvals`, { credentials: 'include' }),
      ])
      if (!autonomyRes.ok) throw new Error('fetch failed')
      setData(await autonomyRes.json())
      // Agent requests are additive — their failure must not blank the queue.
      if (agentRes.ok) {
        const j = await agentRes.json().catch(() => null)
        if (j?.approvals) setAgentApprovals(j.approvals)
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [projectId])

  useEffect(() => { fetchReport() }, [fetchReport])

  const groups = useMemo(
    () => groupFindings(
      (data?.pendingApprovals ?? []).map(p => ({ ...p, details: p.details ?? null })),
    ),
    [data],
  )

  const flashBanner = (title: string, detail?: string) => {
    setBanner({ title, detail })
    const t = setTimeout(() => setBanner(null), 6000)
    timers.current.push(t)
  }

  /**
   * Apply one finding's fix. Returns the outcome instead of touching row state
   * so a group approval can walk its members and report once, at the end.
   */
  const approveOne = async (
    findingId: string,
    retriesLeft = 3,
  ): Promise<{ ok: boolean; alreadyApplied?: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/projects/${projectId}/health/approve`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findingId }),
      })
      const j = await res.json().catch(() => ({} as any))

      if (res.ok && j?.success) return { ok: true, alreadyApplied: !!j?.alreadyApplied }

      // 409 = lock contention (a scan/auto-fix holds the project lock). The
      // server already waits ~30s per attempt, so each retry here rides a
      // fresh server-side wait — three of them outlasts any normal scan.
      if (res.status === 409 && retriesLeft > 0) {
        await new Promise(r => { timers.current.push(setTimeout(r, 2500)) })
        return approveOne(findingId, retriesLeft - 1)
      }

      return { ok: false, error: j?.error || 'The fix could not be applied. Try again in a moment.' }
    } catch {
      return { ok: false, error: 'Network error. Check your connection and try again.' }
    }
  }

  /**
   * Approve every member of a root-cause group.
   *
   * Sequential, not parallel, and deliberately so: the fix path takes a
   * project-level lock, so firing nine approvals at once would have eight of
   * them bounce off 409 and burn their retries against each other. One at a
   * time is also the only order in which a partial failure is interpretable —
   * "6 of 9 applied" means the first six really are applied.
   */
  const approveGroup = async (g: FindingGroup<PendingApproval>) => {
    // Only walk members the executor can actually repair. Sending the rest would
    // spend a round trip to be told there is no fix mapping, and — worse — a
    // group that is mostly unfixable would report a partial failure for work
    // that was never going to run. The button is labelled with this same count.
    const targets = g.members.filter(m => hasExecutableFix(m.type, m.details))
    if (targets.length === 0) return

    setRow(g.key, { phase: 'applying' })
    let applied = 0
    let firstError: string | undefined
    for (const m of targets) {
      const r = await approveOne(m.id)
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
    flashBanner(
      applied === targets.length
        ? `Fix applied${targets.length > 1 ? ` to ${applied} tables` : ''}`
        : `Applied to ${applied} of ${targets.length}`,
      applied === targets.length
        ? 'schema verified · rollback snapshot captured'
        : `${targets.length - applied} left in the queue — ${firstError ?? 'see details'}`,
    )
    const t = setTimeout(async () => {
      await fetchReport(true)
      setRowState(prev => {
        const { [g.key]: _gone, ...rest } = prev
        return rest
      })
    }, 2400)
    timers.current.push(t)
  }

  /**
   * Approve one AI-proposed repair. The server re-checks everything the
   * proposal was bound to, runs it once, and says whether all three checks
   * confirmed it. Anything less is shown as exactly what it is.
   */
  const approveProposal = async (g: FindingGroup<PendingApproval>, proposal: NonNullable<PendingApproval['proposal']>) => {
    setRow(g.key, { phase: 'applying' })
    try {
      const res = await fetch(`/api/projects/${projectId}/health/proposals/${proposal.id}/approve`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalVersion: proposal.version }),
      })
      const j = await res.json().catch(() => ({} as any))
      if (res.ok && j?.fixed) {
        setRow(g.key, { phase: 'verified' })
        flashBanner('Fixed · verified', 'the change is in the catalog, the issue is gone on re-check, nothing else broke · Undo is in Applied changes')
        const t = setTimeout(async () => {
          await fetchReport(true)
          setRowState(prev => {
            const { [g.key]: _gone, ...rest } = prev
            return rest
          })
        }, 2400)
        timers.current.push(t)
        return
      }
      setRow(g.key, { phase: 'error', message: j?.message || j?.error || 'The repair could not be applied. Try again in a moment.' })
      if (res.status === 409 || res.ok) fetchReport(true)
    } catch {
      setRow(g.key, { phase: 'error', message: 'Network error. Check your connection and try again.' })
    }
  }

  const decideAgentRequest = async (approvalId: string, decision: 'approve' | 'reject', shownDigest?: string | null) => {
    setRow(approvalId, { phase: decision === 'approve' ? 'applying' : 'dismissing' })
    try {
      const res = await fetch(`/api/projects/${projectId}/agent-approvals`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // An approval names the request as this card showed it, so the server
        // runs only what the human read.
        body: JSON.stringify({
          approvalId,
          decision,
          ...(decision === 'approve' && shownDigest ? { shownDigest } : {}),
        }),
      })
      const j = await res.json().catch(() => ({} as any))

      if (res.ok && j?.success) {
        setRow(approvalId, { phase: 'verified' })
        const request = agentApprovals.find(a => a.id === approvalId)
        const restore = request?.tool === 'revert_schema_change'
        const fromBackenly = request?.requestedBy === 'backenly'
        flashBanner(
          decision === 'approve'
            ? (restore ? 'Previous state restored' : 'Agent request executed')
            : (restore ? 'Restore declined' : 'Agent request rejected'),
          decision === 'approve'
            ? (j?.resultSummary ? String(j.resultSummary).slice(0, 120) : 'the agent sees the result on its next poll')
            : fromBackenly ? 'the change stays as it is' : 'the agent is told not to retry',
        )
        const t = setTimeout(async () => {
          await fetchReport(true)
          setRowState(prev => {
            const { [approvalId]: _gone, ...rest } = prev
            return rest
          })
        }, 2400)
        timers.current.push(t)
        return
      }

      setRow(approvalId, {
        phase: 'error',
        message: j?.error || (decision === 'approve'
          ? 'The operation could not be executed. Try again in a moment.'
          : 'Could not reject. Try again.'),
      })
      // The request changed under this card, or was decided elsewhere: show it as it is now.
      if (res.status === 409) fetchReport(true)
    } catch {
      setRow(approvalId, { phase: 'error', message: 'Network error. Check your connection and try again.' })
    }
  }

  /** Dismiss every member of a group — the inverse of approveGroup. */
  const dismissGroup = async (g: FindingGroup<PendingApproval>) => {
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
      await fetchReport(true)
      setRowState(prev => {
        const { [g.key]: _gone, ...rest } = prev
        return rest
      })
    } catch {
      setRow(g.key, { phase: 'error', message: 'Network error. Try again.' })
    }
  }

  if (loading) {
    return (
      <section className={CARD}>
        <PanelHeader count={null} refreshing={false} onRefresh={() => {}} disabled />
        <div className="animate-pulse divide-y divide-white/[0.04]">
          <div className="h-[76px]" />
          <div className="h-[76px]" />
        </div>
      </section>
    )
  }

  if (error || !data) {
    return (
      <section className={CARD}>
        <PanelHeader count={null} refreshing={refreshing} onRefresh={() => fetchReport()} />
        <div className="px-5 py-10 text-center">
          <AlertTriangle className="mx-auto mb-3 size-5 text-amber-400/70" />
          <p className="text-[13px] font-medium text-zinc-300">Review queue is unavailable right now</p>
          <button
            onClick={() => fetchReport()}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-white/[0.10] bg-white/[0.03] px-3 py-1.5 text-[12px] font-medium text-zinc-300 transition-colors hover:border-white/[0.18] hover:bg-white/[0.06]"
          >
            <RefreshCw className="size-3" /> Retry
          </button>
        </div>
      </section>
    )
  }

  const pendingAgents = agentApprovals.filter(a => a.status === 'pending')
  // An approval the human already granted must not vanish from the queue
  // while it runs — and if its execution died (server reports failed with no
  // executedAt: the terminal update never ran), the unknown outcome is the
  // human's to look at, not something to hide.
  const runningAgents = agentApprovals.filter(a => a.status === 'approved')
  const stuckAgents = agentApprovals.filter(a => a.status === 'failed' && !a.executedAt)
  // The header counts FINDINGS (what the user must clear), the list renders
  // GROUPS (what they must decide). Both numbers are shown, so folding nine
  // rows into one never looks like eight findings quietly disappearing.
  const total = data.pendingApprovals.length + pendingAgents.length + stuckAgents.length

  return (
    <section className={CARD}>
      <PanelHeader
        count={total}
        groupCount={groups.length + pendingAgents.length + stuckAgents.length}
        refreshing={refreshing}
        onRefresh={() => fetchReport(true)}
      />

      <div className="border-b border-white/[0.06] px-5 py-2.5">
        <p className="text-[12.5px] leading-relaxed text-zinc-500">
          Backenly deliberately did not act on these. They need your call; everything else it handles itself.
          {' '}Once you decide, each change settles into the agent journal on{' '}
          <button
            onClick={() => router.push(`/app/projects/${projectId}`)}
            className="inline-flex items-center gap-0.5 font-medium text-violet-300/90 transition-colors hover:text-violet-200"
          >
            Overview<ArrowRight className="size-3" />
          </button>
        </p>
      </div>

      {banner && (
        <div className="flex items-center gap-2.5 border-b border-white/[0.06] bg-emerald-500/[0.04] px-5 py-2.5 animate-slide-up">
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />
          <p className="min-w-0 text-[12px] font-medium text-zinc-200">
            {banner.title}
            {banner.detail && (
              <span className="ml-2 font-mono text-[12px] font-normal text-zinc-500">{banner.detail}</span>
            )}
          </p>
        </div>
      )}

      {total === 0 && runningAgents.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <CheckCircle2 className="mx-auto mb-3 size-5 text-emerald-400/70" />
          <p className="text-[13px] font-medium text-zinc-300">Nothing waiting on you</p>
          <p className="mt-1 text-[12px] text-zinc-500">Risk-flagged changes show up here before they apply.</p>
        </div>
      ) : (
        <ul className="divide-y divide-white/[0.04]">
          {groups.map(g => (
            <ApprovalRow
              key={g.key}
              group={g}
              state={rowState[g.key] ?? { phase: 'idle' }}
              onApprove={() => approveGroup(g)}
              onApproveProposal={(pr) => approveProposal(g, pr)}
              onDismiss={() => dismissGroup(g)}
              onResetError={() => setRow(g.key, { phase: 'idle' })}
            />
          ))}
          {pendingAgents.map(a => (
            <AgentRequestRow
              key={a.id}
              projectId={projectId}
              request={a}
              state={rowState[a.id] ?? { phase: 'idle' }}
              onApprove={() => decideAgentRequest(a.id, 'approve', a.shownDigest)}
              onReject={() => decideAgentRequest(a.id, 'reject')}
              onResetError={() => setRow(a.id, { phase: 'idle' })}
            />
          ))}
          {runningAgents.map(a => (
            <AgentOutcomeRow key={a.id} request={a} running />
          ))}
          {stuckAgents.map(a => (
            <AgentOutcomeRow key={a.id} request={a} />
          ))}
        </ul>
      )}
    </section>
  )
}

// ── Card header ───────────────────────────────────────────────────────────────
// The ONE "Waiting on you" title — mirrors "Recent guardrail actions" below it
// (icon + 13px title + trailing mono meta).

function PanelHeader({
  count,
  groupCount,
  refreshing,
  onRefresh,
  disabled,
}: {
  count: number | null
  /** Rows actually rendered. Shown alongside `count` whenever the fold is
   *  doing work, so the grouping never reads as findings going missing. */
  groupCount?: number
  refreshing: boolean
  onRefresh: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-white/[0.06] px-5 py-3.5">
      <AlertTriangle className="size-3.5 text-amber-400" />
      <h3 className="text-[13px] font-semibold tracking-tight text-zinc-100">Waiting on you</h3>
      {typeof count === 'number' && count > 0 && (
        <span className="text-[12px] font-medium tabular-nums text-amber-300">
          {count}
          {typeof groupCount === 'number' && groupCount < count && (
            <span className="ml-1.5 font-normal text-zinc-500">
              in {groupCount} {groupCount === 1 ? 'issue' : 'issues'}
            </span>
          )}
        </span>
      )}
      <button
        onClick={onRefresh}
        disabled={disabled || refreshing}
        className="ml-auto text-zinc-600 transition-colors hover:text-zinc-300 disabled:opacity-40"
        aria-label="Refresh"
      >
        <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
      </button>
    </div>
  )
}

// ── Shared row action buttons (kit voice: violet primary, ghost secondary) ────

function PrimaryAction({
  onClick,
  busy,
  busyLabel,
  disabled,
  children,
}: {
  onClick: () => void
  busy: boolean
  busyLabel: string
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <KitButton variant="primary" onClick={onClick} disabled={busy || disabled}>
      {busy ? <><Loader2 className="size-3.5 animate-spin" /> {busyLabel}</> : children}
    </KitButton>
  )
}

function GhostAction({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <KitButton variant="secondary" onClick={onClick} disabled={disabled}>
      {children}
    </KitButton>
  )
}

/**
 * A destructive op requested by the user's own coding agent over MCP.
 * Deliberately louder about WHAT gets destroyed than the finding rows —
 * the requester is a machine, so the human is the only judgment in the loop.
 */
function AgentRequestRow({
  projectId,
  request: a,
  state,
  onApprove,
  onReject,
  onResetError,
}: {
  projectId: string
  request: AgentApproval
  state: RowState
  onApprove: () => void
  onReject: () => void
  onResetError: () => void
}) {
  const busy = state.phase === 'applying' || state.phase === 'dismissing'
  // Restoring a change reads as what it does, whoever asked for it: Backenly
  // raises one when a change fails its checks and recovering it would affect
  // data written since. The details are on the change itself.
  const restore = a.tool === 'revert_schema_change'
  const fromBackenly = a.requestedBy === 'backenly'
  // The card is the ONLY thing the human reads before approving — a merge
  // message carries the exact statements that reach production, and cutting
  // it at 180 characters asked them to approve what they could not see.
  const [showFull, setShowFull] = useState(false)
  const long = a.message.length > 180
  const shown = long && !showFull ? a.message.slice(0, 180) + '…' : a.message
  // A card that could only show stand-ins is not something a human read, so it
  // cannot be approved. Rejecting it needs nothing from the region.
  const unreadable = a.readable === false
  return (
    <li className="px-5 py-3.5">
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${restore ? 'bg-amber-400' : 'bg-violet-400'}`} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-zinc-100">
            {restore ? (
              a.target
            ) : (
              <>Your coding agent wants to run <span className="font-mono text-[12px] text-violet-200">{a.tool}</span> on {a.target}</>
            )}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-zinc-500">
            {restore || fromBackenly ? shown : `“${shown}”`}
          </p>
          {long && (
            <button
              onClick={() => setShowFull(v => !v)}
              className="mt-1 text-[12px] font-medium text-violet-300/90 underline underline-offset-2 transition-colors hover:text-violet-200"
            >
              {showFull ? 'Show less' : 'Show the full request'}
            </button>
          )}
          <p className="mt-1.5 font-mono text-[12px] text-zinc-600">
            {a.rowCount !== null && a.rowCount > 0 && (
              <span className="text-amber-400/90">{a.rowCount} row{a.rowCount === 1 ? '' : 's'} affected · </span>
            )}
            {restore ? 'current state protected first' : a.reversible ? 'restore point available' : 'not auto-reversible'}
            {' · '}{fromBackenly ? 'Backenly' : 'MCP'} · {timeAgo(a.createdAt)}
            {restore && a.changeId && (
              <>
                {' · '}
                <a
                  href={`/app/projects/${projectId}/database?view=changes&change=${encodeURIComponent(a.changeId)}`}
                  className="text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
                >
                  View details
                </a>
              </>
            )}
          </p>
          {unreadable && (
            <p className="mt-2 text-[12px] text-amber-200/80">
              The exact call is kept in the project’s region and could not be read just now. Refresh to try again.
            </p>
          )}
          {state.phase === 'error' && (
            <p className="mt-2 text-[12px] text-rose-300/90">
              {state.message}{' '}
              <button onClick={onResetError} className="text-zinc-500 underline underline-offset-2 hover:text-zinc-300">retry</button>
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state.phase === 'verified' ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-[12.5px] text-emerald-300">
              <CheckCircle2 className="size-3.5" /> Done
            </span>
          ) : (
            <>
              <GhostAction onClick={onReject} disabled={busy}>
                {state.phase === 'dismissing' ? <Loader2 className="size-3 animate-spin" /> : <XCircle className="size-3.5" />}
                Reject
              </GhostAction>
              <PrimaryAction onClick={onApprove} busy={state.phase === 'applying'} busyLabel={restore ? 'Restoring…' : 'Running…'} disabled={unreadable}>
                <CheckCircle2 className="size-3.5" /> {restore ? 'Approve restore' : <>Approve &amp; run</>}
              </PrimaryAction>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

/**
 * An agent request after the human decided: still executing, or approved and
 * never heard from again (the terminal update never ran — a restart mid-run).
 * No buttons: there is no decision left, only an outcome to witness. These
 * rows exist so an approval can never silently vanish from the queue while
 * its outcome is undecided or unknown.
 */
function AgentOutcomeRow({ request: a, running }: { request: AgentApproval; running?: boolean }) {
  return (
    <li className="px-5 py-3.5">
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${running ? 'bg-sky-400' : 'bg-amber-400'}`} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-zinc-100">
            {running ? 'Approved — running now: ' : 'Approved, but the outcome is unknown: '}
            <span className="font-mono text-[12px] text-violet-200">{a.tool}</span> on {a.target}
          </p>
          {!running && a.resultSummary && (
            <p className="mt-1 break-words text-[12px] leading-relaxed text-amber-200/80">{a.resultSummary}</p>
          )}
          <p className="mt-1.5 font-mono text-[12px] text-zinc-600">MCP · {timeAgo(a.createdAt)}</p>
        </div>
        {running && <Loader2 className="size-3.5 shrink-0 animate-spin text-zinc-500" />}
      </div>
    </li>
  )
}

/**
 * The prompt handed to the user's coding agent. Inherited from the Overview
 * advisor block when Autonomy became the single queue — some fixes genuinely
 * belong in the user's frontend code, and losing that door would have made the
 * consolidation a net loss of capability rather than a removal of duplication.
 */
function agentPrompt(g: FindingGroup<PendingApproval>): string {
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

function ApprovalRow({
  group: g,
  state,
  onApprove,
  onApproveProposal,
  onDismiss,
  onResetError,
}: {
  group: FindingGroup<PendingApproval>
  state: RowState
  onApprove: () => void
  onApproveProposal: (proposal: NonNullable<PendingApproval['proposal']>) => void
  onDismiss: () => void
  onResetError: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const head = g.members[0]
  const critical = g.severity === 'critical'
  const many = g.members.length > 1
  // A proposal is bound to one finding, so it is offered on single rows only.
  const proposal = !many ? head.proposal : undefined

  if (state.phase === 'verified') {
    return (
      <li className="flex items-start gap-3 px-5 py-3.5 animate-fade-in">
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-emerald-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-zinc-200">{g.title}</p>
          <p className="mt-1 font-mono text-[12px] text-zinc-500">
            fixed{many ? ` · ${g.members.length} tables` : ''} · schema verified · rollback snapshot captured
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
          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${critical ? 'bg-rose-500' : 'bg-amber-400'} ${
            state.phase === 'applying' ? 'animate-pulse' : ''
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] leading-snug text-zinc-100">{g.title}</p>
          {heldKindLabel(head) && (
            <p className="mt-1 text-[12px] font-medium text-amber-400/80">
              {heldKindLabel(head)}
            </p>
          )}
          <p className="mt-1 text-[12.5px] leading-snug text-zinc-500">{reasonForApproval(head)}</p>
          {(() => {
            const diag = diagnosisOf(head)
            if (!diag) return null
            return (
              <div className="mt-1.5 border-l border-white/[0.08] pl-3">
                <p className="mb-0.5 text-[11.5px] font-medium uppercase tracking-wide text-zinc-500">
                  {diag.provenance === 'investigation'
                    ? `Confirmed by investigation${diag.observations ? ` · ${diag.observations} observation${diag.observations === 1 ? '' : 's'}` : ''}`
                    : 'AI hypothesis · not verified'}
                </p>
                {diag.rootCause && (
                  <p className="text-[12.5px] leading-snug text-zinc-400">{diag.rootCause}</p>
                )}
                {diag.recommendation && (
                  <p className="mt-0.5 text-[12.5px] leading-snug text-zinc-500">
                    <span className="text-zinc-400">Recommended:</span> {diag.recommendation}
                  </p>
                )}
              </div>
            )
          })()}
          <p className="mt-1.5 font-mono text-[12px] text-zinc-600">
            {head.type} · {g.severity}
            {!many && head.resource && <> · <span className="text-zinc-500">{head.resource}</span></>}
            {head.source && head.source !== 'autonomy' && (
              <> · <span className="text-violet-300/80">{head.source === 'brain-risk' ? 'AI agent' : 'backend build'}</span></>
            )}
            {' · '}{timeAgo(head.detectedAt)}
          </p>

          {/* The fold is never a hiding place: every member is one click away,
              and the count is stated before you click. */}
          {many && (
            <div className="mt-2">
              <button
                onClick={() => setExpanded(v => !v)}
                aria-expanded={expanded}
                className="inline-flex items-center gap-1 text-[12.5px] font-medium text-zinc-500 transition-colors hover:text-zinc-300"
              >
                {g.members.length} findings, one cause
                <ChevronDown className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </button>
              {expanded && (
                <ul className="mt-2 space-y-1 border-l border-white/[0.08] pl-3">
                  {g.members.map((m, i) => (
                    <li key={m.id} className="font-mono text-[12px] leading-relaxed text-zinc-500">
                      {g.subjects[i] ?? m.resource ?? m.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* No auto-repair exists for this row. Say so HERE, before the user
              spends a click discovering it — and say what to do instead. The
              hint is the same sentence the approve route would have returned,
              read from the one fix mapping (lib/core/fix-actions.ts). */}
          {proposal && state.phase !== 'error' && (
            <div className="mt-2 border-l border-violet-400/30 pl-3">
              <p className="mb-0.5 text-[11.5px] font-medium uppercase tracking-wide text-violet-300/80">
                AI-proposed repair · needs your approval
              </p>
              <p className="text-[12.5px] leading-snug text-zinc-300">{proposal.summary}</p>
              <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">
                Recorded as fixed only if it is in the catalog, the issue is gone on re-check and nothing else broke. Undo restores the state before it.
              </p>
            </div>
          )}

          {!g.actionable && !proposal && state.phase !== 'error' && g.manualHint && (
            <p className="mt-2 border-l border-white/[0.08] pl-3 text-[12.5px] leading-snug text-zinc-400">
              {g.manualHint}
            </p>
          )}

          {state.phase === 'error' && (
            <div className="mt-2 flex items-start gap-2">
              <XCircle className="mt-px size-3.5 shrink-0 text-rose-400" />
              <p className="text-[12.5px] leading-snug text-rose-300/90">{state.message}</p>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state.phase === 'error' ? (
            <PrimaryAction onClick={onResetError} busy={false} busyLabel="">
              Try again
            </PrimaryAction>
          ) : (
            <>
              {/* The fix button exists only when a fix does. `fixableCount` is
                  computed from the executor's own action mapping, so this can
                  never promise a repair the engine does not have. */}
              {proposal && (
                <PrimaryAction onClick={() => onApproveProposal(proposal)} busy={state.phase === 'applying'} busyLabel="Applying…">
                  Approve & fix
                </PrimaryAction>
              )}
              {!proposal && g.actionable && (
                <PrimaryAction
                  onClick={onApprove}
                  busy={state.phase === 'applying'}
                  busyLabel={g.fixableCount > 1 ? `Applying ${g.fixableCount}…` : 'Applying…'}
                >
                  {g.fixableCount > 1 ? `Approve & fix all ${g.fixableCount}` : 'Approve & fix'}
                </PrimaryAction>
              )}
              <GhostAction onClick={handToAgent} disabled={busy}>
                {copied ? <Check className="size-3.5 text-emerald-400" /> : <ClipboardCopy className="size-3.5" />}
                {copied ? 'Copied' : 'Hand to my agent'}
              </GhostAction>
              <GhostAction onClick={onDismiss} disabled={busy}>
                {state.phase === 'dismissing' ? '…' : 'Dismiss'}
              </GhostAction>
            </>
          )}
        </div>
      </div>
    </li>
  )
}
