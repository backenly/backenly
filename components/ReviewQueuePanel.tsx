'use client'

/**
 * ReviewQueuePanel: Autonomy's "Waiting on you", the one working queue.
 *
 * Everything that waits on a person's decision is a row here: what the coding
 * agent asked for over MCP (GET /agent-approvals), findings Backenly holds for
 * approval (the trust report's pendingApprovals), architecture changes Backenly
 * prepared (each its own EvolutionRequestRow), and a structural migration when
 * one is pending (MaintenanceLadderRow). Overview's "Waiting on you" and the
 * top bar's inbox link to these rows by anchor (#approval-<id>,
 * #finding-<groupKey>), and the heading's count is the inbox's own
 * (useWaitingCount), so the three can never disagree.
 *
 * Rows are ROOT-CAUSE GROUPS (lib/core/finding-groups), not findings: the loop
 * writes one finding per affected table, so one wrong policy across nine
 * tables is one row, one decision, one "Approve & fix all".
 *
 * ARCHITECTURE CHANGES are the one exception to grouping: each is bound to its
 * own plan version, so they are taken out BEFORE grouping and approved through
 * POST /api/projects/[id]/architecture only.
 *
 * Rebuilt in place 2026-11-16 (the Nov 3 structure stays): every row leads
 * with its state (◆ waiting, ◐ running, ✓ done) instead of a 32px tile; facts
 * carry no icons; a decision's result REPLACES the row's buttons, in the
 * server's full words, instead of a banner cut at 120 characters; the queue
 * re-reads with the page (every 30 s and on focus) instead of a refresh icon;
 * people who cannot decide read one sentence where the buttons were.
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { KitButton, MetaCode, OverflowMenu, StatusGlyph, TextWithCode } from '@/components/inspector/kit'
import { ClipboardCopy } from 'lucide-react'
import { groupFindings, CATEGORY_LABEL, type FindingGroup, type GroupableFinding } from '@/lib/core/finding-groups'
import { hasExecutableFix } from '@/lib/core/fix-actions'
import { decisionLabels } from '@/lib/core/finding-summaries'
import { isEvolutionApprovalFinding } from '@/lib/core/types'
import { EvolutionRequestRow } from '@/components/autonomy/EvolutionRequestRow'
import { approvalTitle } from '@/lib/mcp/approval-title'
import { onArchitectureChange } from '@/components/autonomy/architecture-decisions'
import { MaintenanceLadderRow, useMaintenanceLadder } from '@/components/MaintenanceLadderPanel'
import { Time } from '@/components/console/Time'
import { approvalIcon, findingIcon } from '@/components/autonomy/row-icons'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { refreshWaitingCount, useWaitingCount } from '@/lib/hooks/useWaitingCount'
import {
  CodeBlock, Disclosure, EmptyLine, Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TEXT, ROW_TITLE, Section, rows,
} from '@/components/autonomy/rows'

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
  /** The published version a rollback request restores the backend to. */
  version?: number | null
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

/** Per-row state while a decision is made. */
type RowState =
  | { phase: 'idle' }
  | { phase: 'applying' }
  | { phase: 'dismissing' }
  | { phase: 'error'; message: string }

/**
 * A decision that went through. The row stays, with the outcome in place of
 * its buttons and the server's own words under the title, until the page is
 * left: the result is read where the question was asked.
 */
interface Settled {
  /** "Ran", "Restored", "Rejected", "Fixed". */
  word: string
  /** The server's account of what happened, when it gave one. */
  text?: string
  glyph: 'done' | 'idle'
}

// Fallback only — types the fix-classifier genuinely gates on approval (its
// NEEDS_APPROVAL set), for responses that predate the server-computed
// `heldBecause`. Deliberately NOT "anything auth-flavoured": types like
// rls_expression_invalid are AUTO-class — Autopilot heals them silently and
// they only appear here when a fix was tried and did not verify.
const GUARDRAIL_GATED_TYPES = new Set([
  'broken_webhook', 'broken_auth', 'integration_key_invalid',
  'integration_webhook_failing', 'integration_smtp_unreachable',
  'oauth_config_invalid', 'oauth_redirect_uri_missing', 'dead_api_endpoint',
  'deploy_failure', 'auth_jwt_missing', 'auth_users_table_missing',
])

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
  return WAITING_FOR_REVIEW
}

/**
 * The hold reason, when it says more than "waiting": "Escalated by Autopilot"
 * is the story that separates an autonomous loop from a debug agent. It TRIED,
 * verified, and stopped honestly.
 */
function heldKindLabel(p: PendingApproval): string | null {
  switch (p.heldBecause?.kind) {
    case 'escalated':  return 'Escalated by Autopilot after a verified fix attempt'
    case 'recurrence': return 'Fix applied but kept recurring, so retries stopped'
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

/** A server result written for agents ("✅ Column `x` dropped…"), without the emoji; backticks stay for TextWithCode. */
function resultWords(s: string | null | undefined): string | undefined {
  if (!s) return undefined
  const t = s
    .replace(/[☀-➿⬀-⯿️]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t || undefined
}

export function ReviewQueuePanel({
  projectId,
  refreshKey = 0,
  canDecideAgent = true,
  canFix = true,
}: {
  projectId: string
  /** Bumped by the page every 30 s and on focus: the queue re-reads quietly. */
  refreshKey?: number
  /** Deciding an agent's request, an architecture change or a migration takes an owner or admin. */
  canDecideAgent?: boolean
  /** Approving or dismissing a held finding takes a developer or above. */
  canFix?: boolean
}) {
  const [data, setData] = useState<TrustReportShape | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [rowState, setRowState] = useState<Record<string, RowState>>({})
  const [settled, setSettled] = useState<Record<string, Settled>>({})
  // What a settled row looked like, so it can stay after the queue no longer lists it.
  const [settledAgents, setSettledAgents] = useState<Record<string, AgentApproval>>({})
  const [settledGroups, setSettledGroups] = useState<Record<string, FindingGroup<PendingApproval>>>({})
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const waiting = useWaitingCount(projectId)
  const maintenance = useMaintenanceLadder(projectId, refreshKey)

  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])

  const setRow = (id: string, s: RowState) =>
    setRowState(prev => ({ ...prev, [id]: s }))

  const [agentApprovals, setAgentApprovals] = useState<AgentApproval[]>([])

  const fetchReport = useCallback(async () => {
    try {
      const [autonomyRes, agentRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/autonomy`, { credentials: 'include' }),
        fetch(`/api/projects/${projectId}/agent-approvals`, { credentials: 'include' }),
      ])
      if (!autonomyRes.ok) throw new Error('fetch failed')
      setData(await autonomyRes.json())
      setError(false)
      // Agent requests are additive — their failure must not blank the queue.
      if (agentRes.ok) {
        const j = await agentRes.json().catch(() => null)
        if (j?.approvals) setAgentApprovals(j.approvals)
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void fetchReport() }, [fetchReport, refreshKey])
  // A change decided on the Architecture changes card leaves or joins this queue.
  useEffect(() => onArchitectureChange('queue', () => { void fetchReport() }), [fetchReport])

  /** After a decision: the queue, and every surface that counts it (the inbox, Overview). */
  const afterDecision = useCallback(() => {
    void fetchReport()
    void refreshWaitingCount(projectId, { fresh: true })
  }, [fetchReport, projectId])

  // Architecture changes leave before grouping: each is its own decision on its
  // own plan version, and the grouper would fold several into one row.
  const { groups, evolutionRequests } = useMemo(() => {
    const all = (data?.pendingApprovals ?? []).map(p => ({ ...p, details: p.details ?? null }))
    return {
      groups: groupFindings(all.filter(p => !isEvolutionApprovalFinding(p.type))),
      evolutionRequests: all.filter(p => isEvolutionApprovalFinding(p.type)),
    }
  }, [data])

  /**
   * Apply one finding's fix. Returns the outcome instead of touching row state
   * so a group approval can walk its members and report once, at the end.
   */
  const approveOne = async (
    findingId: string,
    retriesLeft = 3,
  ): Promise<{ ok: boolean; alreadyApplied?: boolean; error?: string; message?: string }> => {
    try {
      const res = await fetch(`/api/projects/${projectId}/health/approve`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findingId }),
      })
      const j = await res.json().catch(() => ({} as any))

      if (res.ok && j?.success) return { ok: true, alreadyApplied: !!j?.alreadyApplied, message: typeof j?.message === 'string' ? j.message : undefined }

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

  const settle = (id: string, s: Settled) => setSettled(prev => ({ ...prev, [id]: s }))

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
    // Only walk members the executor can actually repair. The button is labelled with this same count.
    const targets = g.members.filter(m => hasExecutableFix(m.type, m.details))
    if (targets.length === 0) return

    setRow(g.key, { phase: 'applying' })
    let applied = 0
    let firstError: string | undefined
    let lastMessage: string | undefined
    for (const m of targets) {
      const r = await approveOne(m.id)
      if (r.ok) { applied += 1; lastMessage = r.message }
      else if (!firstError) firstError = r.error
    }

    if (applied === 0) {
      setRow(g.key, { phase: 'error', message: firstError ?? 'The fix could not be applied. Try again in a moment.' })
      return
    }

    setRow(g.key, { phase: 'idle' })
    setSettledGroups(prev => ({ ...prev, [g.key]: g }))
    settle(g.key, {
      glyph: 'done',
      word: applied === targets.length ? 'Fixed' : `Fixed ${applied} of ${targets.length}`,
      // What the server said the fix did, when there is one fix to speak for:
      // not every fix is verified, and not every fix keeps a restore point.
      text: applied === targets.length
        ? (targets.length === 1 ? resultWords(lastMessage) : `Applied to ${applied} tables.`)
        : `${targets.length - applied} still waiting: ${firstError ?? 'see the row'}`,
    })
    afterDecision()
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
        setRow(g.key, { phase: 'idle' })
        setSettledGroups(prev => ({ ...prev, [g.key]: g }))
        settle(g.key, {
          glyph: 'done',
          word: 'Fixed',
          text: 'In the catalog, gone on re-check, nothing else broke. Undo is under Changes Backenly made.',
        })
        afterDecision()
        return
      }
      setRow(g.key, { phase: 'error', message: j?.message || j?.error || 'The repair could not be applied. Try again in a moment.' })
      if (res.status === 409 || res.ok) void fetchReport()
    } catch {
      setRow(g.key, { phase: 'error', message: 'Network error. Check your connection and try again.' })
    }
  }

  const decideAgentRequest = async (
    approvalId: string,
    decision: 'approve' | 'reject',
    shownDigest?: string | null,
    // Bulk approval says one result for all of them and refreshes once.
    opts: { quiet?: boolean } = {},
  ): Promise<{ ok: boolean }> => {
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
        const request = agentApprovals.find(a => a.id === approvalId)
        const restore = request?.tool === 'revert_schema_change' || request?.tool === 'rollback_deploy'
        const fromBackenly = request?.requestedBy === 'backenly'
        if (request) setSettledAgents(prev => ({ ...prev, [approvalId]: request }))
        setRow(approvalId, { phase: 'idle' })
        settle(approvalId, decision === 'approve'
          ? {
              glyph: 'done',
              word: restore ? 'Restored' : 'Ran',
              text: resultWords(j?.resultSummary) ?? 'Your agent sees the result on its next check.',
            }
          : {
              glyph: 'idle',
              word: restore ? 'Declined' : 'Rejected',
              text: fromBackenly ? 'The change stays as it is.' : 'Your agent is told not to retry.',
            })
        if (!opts.quiet) afterDecision()
        return { ok: true }
      }

      // A call that ran and failed answers with what happened (resultSummary):
      // a restore refused because the data moved since, or one applied and not
      // yet confirmed. Shown as it is; "try again" is not true of either.
      setRow(approvalId, {
        phase: 'error',
        message: j?.error || j?.resultSummary || (decision === 'approve'
          ? 'The operation could not be executed. Try again in a moment.'
          : 'Could not reject. Try again.'),
      })
      // The request changed under this card, or was decided elsewhere: show it as it is now.
      if (res.status === 409 && !opts.quiet) void fetchReport()
      return { ok: false }
    } catch {
      setRow(approvalId, { phase: 'error', message: 'Network error. Check your connection and try again.' })
      return { ok: false }
    }
  }

  // ── Approving several agent requests at once ──────────────────────────────
  // An agent cleaning up after itself (the debug functions it made, its
  // scratch branches, the temporary key) left a card each: seven approvals one
  // by one. Each is still its own approval, run exactly as its card shows,
  // with that card's digest, one after another; the person approves the list
  // they were shown, taken when they asked. Restores, and requests Backenly
  // raised itself, are decided one at a time.
  const [bulk, setBulk] = useState<BulkState>({ phase: 'idle' })

  const approveAll = async (requests: Array<{ id: string; shownDigest?: string | null; title: string }>) => {
    setBulk({ phase: 'running', requests, done: 0 })
    let ran = 0
    for (const [i, r] of requests.entries()) {
      const outcome = await decideAgentRequest(r.id, 'approve', r.shownDigest, { quiet: true })
      if (outcome.ok) ran += 1
      setBulk({ phase: 'running', requests, done: i + 1 })
    }
    setBulk({ phase: 'finished', requests, ran })
    afterDecision()
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
      setRow(g.key, { phase: 'idle' })
      setSettledGroups(prev => ({ ...prev, [g.key]: g }))
      settle(g.key, { glyph: 'idle', word: 'Dismissed' })
      afterDecision()
    } catch {
      setRow(g.key, { phase: 'error', message: 'Network error. Try again.' })
    }
  }

  if (loading) {
    return (
      <QueueSection count={waiting.total}>
        <Panel>
          <RowSkeleton rows={2} />
        </Panel>
      </QueueSection>
    )
  }

  if (error || !data) {
    return (
      <QueueSection count={waiting.total}>
        <Panel>
          <ErrorRow
            things="what is waiting on you"
            stillWorks="Your guardrails still apply."
            onRetry={() => {
              setLoading(true)
              void fetchReport()
            }}
          />
        </Panel>
      </QueueSection>
    )
  }

  // The heading's count is the inbox's (useWaitingCount, from /health) once it has one.
  const pendingAgents = agentApprovals.filter(a => a.status === 'pending' && !settled[a.id])
  const bulkable = pendingAgents.filter(a =>
    a.readable !== false &&
    a.requestedBy !== 'backenly' &&
    a.tool !== 'revert_schema_change' &&
    a.tool !== 'rollback_deploy' &&
    (rowState[a.id]?.phase ?? 'idle') === 'idle')
  // An approval the human already granted must not vanish from the queue
  // while it runs — and if its execution died (server reports failed with no
  // executedAt: the terminal update never ran), the unknown outcome is the
  // human's to look at, not something to hide.
  const runningAgents = agentApprovals.filter(a => a.status === 'approved' && !settled[a.id])
  const stuckAgents = agentApprovals.filter(a => a.status === 'failed' && !a.executedAt)
  const openGroups = groups.filter(g => !settled[g.key])
  // Rows decided on this visit stay, with their outcome, until the page is left.
  const decidedAgents = Object.values(settledAgents).filter(a => settled[a.id])
  const decidedGroups = Object.values(settledGroups).filter(g => settled[g.key])
  const ladder = maintenance.ladder
  // The heading counts FINDINGS (what the user must clear), the list renders
  // GROUPS (what they must decide); both are said when the fold is doing work.
  const localTotal = data.pendingApprovals.length + pendingAgents.length + stuckAgents.length
  const rowCount = openGroups.length + evolutionRequests.length + pendingAgents.length + stuckAgents.length
  const nothing =
    localTotal === 0 && runningAgents.length === 0 && !ladder &&
    decidedAgents.length === 0 && decidedGroups.length === 0 && bulk.phase === 'idle'

  return (
    <QueueSection count={waiting.total ?? localTotal} groupCount={rowCount}>
      <Panel>
        {nothing ? (
          <EmptyLine>Nothing waiting. Risky changes stop here before they run.</EmptyLine>
        ) : (
          <RowList>
            {decidedAgents.map(a => (
              <AgentRequestRow
                key={a.id}
                projectId={projectId}
                request={a}
                state={{ phase: 'idle' }}
                settled={settled[a.id]}
                canDecide={canDecideAgent}
                onApprove={() => {}}
                onReject={() => {}}
                onResetError={() => {}}
              />
            ))}
            {decidedGroups.map(g => (
              <ApprovalRow
                key={g.key}
                group={g}
                state={{ phase: 'idle' }}
                settled={settled[g.key]}
                canDecide={canFix}
                onApprove={() => {}}
                onApproveProposal={() => {}}
                onDismiss={() => {}}
                onResetError={() => {}}
              />
            ))}
            {openGroups.map(g => (
              <ApprovalRow
                key={g.key}
                group={g}
                state={rowState[g.key] ?? { phase: 'idle' }}
                canDecide={canFix}
                onApprove={() => approveGroup(g)}
                onApproveProposal={(pr) => approveProposal(g, pr)}
                onDismiss={() => dismissGroup(g)}
                onResetError={() => setRow(g.key, { phase: 'idle' })}
              />
            ))}
            {canDecideAgent && (bulkable.length >= 2 || bulk.phase !== 'idle') && (
              <BulkApproveRow
                count={bulkable.length}
                state={bulk}
                onAsk={() => setBulk({
                  phase: 'confirming',
                  requests: bulkable.map(a => ({ id: a.id, shownDigest: a.shownDigest, title: approvalTitle(a.tool, a.target) })),
                  done: 0,
                })}
                onCancel={() => setBulk({ phase: 'idle' })}
                onConfirm={() => bulk.phase === 'confirming' && approveAll(bulk.requests)}
              />
            )}
            {pendingAgents.map(a => (
              <AgentRequestRow
                key={a.id}
                projectId={projectId}
                request={a}
                state={rowState[a.id] ?? { phase: 'idle' }}
                canDecide={canDecideAgent}
                onApprove={() => decideAgentRequest(a.id, 'approve', a.shownDigest)}
                onReject={() => decideAgentRequest(a.id, 'reject')}
                onResetError={() => setRow(a.id, { phase: 'idle' })}
              />
            ))}
            {evolutionRequests.map(r => (
              <EvolutionRequestRow
                key={r.id}
                projectId={projectId}
                request={r}
                onRefresh={() => fetchReport()}
                onDecided={() => { void refreshWaitingCount(projectId, { fresh: true }) }}
              />
            ))}
            {ladder && (
              <MaintenanceLadderRow projectId={projectId} ladder={ladder} reload={maintenance.reload} canDecide={canDecideAgent} />
            )}
            {runningAgents.map(a => (
              <AgentOutcomeRow key={a.id} request={a} running />
            ))}
            {stuckAgents.map(a => (
              <AgentOutcomeRow key={a.id} request={a} />
            ))}
          </RowList>
        )}
      </Panel>
    </QueueSection>
  )
}

// ── Section ───────────────────────────────────────────────────────────────────
// The ONE "Waiting on you" heading, above its panel like every section on the
// page. The count is the findings to clear; when grouping folds several into
// one row, the rows are said too, so the fold never reads as findings missing.

function QueueSection({
  count,
  groupCount,
  children,
}: {
  count: number | null
  /** Rows actually rendered. Shown alongside `count` whenever the fold is
   *  doing work, so the grouping never reads as findings going missing. */
  groupCount?: number
  children: React.ReactNode
}) {
  return (
    <Section
      id="autonomy-waiting"
      title="Waiting on you"
      count={count}
      aside={
        typeof count === 'number' && typeof groupCount === 'number' && groupCount > 0 && groupCount < count ? (
          <span className="text-[12.5px] tabular-nums text-faint">
            in {groupCount} {groupCount === 1 ? 'issue' : 'issues'}
          </span>
        ) : undefined
      }
    >
      {children}
    </Section>
  )
}

type BulkState =
  | { phase: 'idle' }
  | { phase: 'confirming' | 'running'; requests: Array<{ id: string; shownDigest?: string | null; title: string }>; done: number }
  | { phase: 'finished'; requests: Array<{ id: string; title: string }>; ran: number }

/**
 * The row offering to approve the agent's waiting requests together: first
 * the count, then the list it would approve, then progress through it, then
 * how many ran. Each request's own result stays on its own row.
 */
function BulkApproveRow({
  count,
  state,
  onAsk,
  onCancel,
  onConfirm,
}: {
  count: number
  state: BulkState
  onAsk: () => void
  onCancel: () => void
  onConfirm: () => void
}) {
  if (state.phase === 'idle') {
    return (
      <Row
        lead="none"
        title={<p className="text-[13px] leading-[21px] text-zinc-300">{count} requests from your agent are waiting.</p>}
        actions={<KitButton variant="secondary" onClick={onAsk}>Approve all {count}</KitButton>}
      />
    )
  }
  const n = state.requests.length
  if (state.phase === 'finished') {
    const missed = n - state.ran
    return (
      <Row lead="glyph" glyph={missed > 0 ? 'failed' : 'done'} glyphLabel={missed > 0 ? 'Some did not run' : 'All ran'} title={<p className={ROW_TITLE}>Ran {state.ran} of {n}</p>}>
        <p className={ROW_TEXT}>
          {missed > 0 ? `${missed} did not run; ${missed === 1 ? 'its card says' : 'their cards say'} why.` : 'Your agent sees each result on its next check.'}
        </p>
      </Row>
    )
  }
  return (
    <Row
      lead="none"
      title={
        <p className={ROW_TITLE}>
          {state.phase === 'running'
            ? `Running ${Math.min(state.done + 1, n)} of ${n}…`
            : `Approve these ${n}? Each runs exactly as its card shows, one after another.`}
        </p>
      }
    >
      <ul className="mt-2 space-y-1">
        {state.requests.map(r => (
          <li key={r.id} className="text-[12.5px] leading-[18px] text-zinc-400">
            <TextWithCode text={r.title} codeClassName="text-zinc-300" />
          </li>
        ))}
      </ul>
      {state.phase === 'confirming' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <KitButton variant="primary" onClick={onConfirm}>Approve and run {n}</KitButton>
          <KitButton variant="secondary" onClick={onCancel}>Cancel</KitButton>
        </div>
      )}
    </Row>
  )
}

/** "Ran", "Rejected", "Fixed": what a settled row says where its buttons were. */
function SettledWord({ settled }: { settled: Settled }) {
  return <StatusGlyph state={settled.glyph} label={settled.word} showLabel className="pt-[2px]" />
}

/** The sentence a person who may not decide reads where the buttons were. */
const ADMINS_DECIDE = 'Only admins can approve. Ask an owner or admin.'
const DEVELOPERS_DECIDE = 'Only developers and admins can approve fixes.'

/**
 * A destructive op requested by the user's own coding agent over MCP.
 * Deliberately louder about WHAT gets destroyed than the finding rows —
 * the requester is a machine, so the human is the only judgment in the loop.
 */
function AgentRequestRow({
  projectId,
  request: a,
  state,
  settled,
  canDecide,
  onApprove,
  onReject,
  onResetError,
}: {
  projectId: string
  request: AgentApproval
  state: RowState
  settled?: Settled
  canDecide: boolean
  onApprove: () => void
  onReject: () => void
  onResetError: () => void
}) {
  const busy = state.phase === 'applying' || state.phase === 'dismissing'
  // Restoring a change reads as what it does, whoever asked for it: Backenly
  // raises one when a change fails its checks and recovering it would affect
  // data written since. A rollback is a restore too: of the backend to a
  // published version, with Backenly's list of the changes it would undo.
  const restore = a.tool === 'revert_schema_change' || a.tool === 'rollback_deploy'
  const fromBackenly = a.requestedBy === 'backenly'
  // The card is the ONLY thing the human reads before approving — a merge
  // message carries the exact statements that reach production. They are
  // machine text, so they are set as code, in full up to MAX_STATEMENTS and
  // behind "Show the full request" past that.
  const [showFull, setShowFull] = useState(false)
  const [showAgentWords, setShowAgentWords] = useState(false)
  const { prose, statements } = splitRequest(a.message, a.target)
  // What an agent wrote is its case for the call, not a description of it: the
  // title is Backenly's description, and the agent's words stay closed until
  // asked for, marked as unchecked.
  const agentWords = !restore && !fromBackenly && statements.length === 0 && prose && prose !== a.target ? prose : ''
  const backenlyProse = agentWords ? '' : prose
  const long = statements.length > 0 ? statements.length > MAX_STATEMENTS : backenlyProse.length > 180
  const shownProse = statements.length === 0 && long && !showFull ? clip(backenlyProse, 180) : backenlyProse
  const shownStatements = showFull ? statements : statements.slice(0, MAX_STATEMENTS)
  // A card that could only show stand-ins is not something a human read, so it
  // cannot be approved. Rejecting it needs nothing from the region.
  const unreadable = a.readable === false
  return (
    <Row
      lead="well"
      icon={approvalIcon(a.tool)}
      tone={settled ? 'done' : 'neutral'}
      busy={state.phase === 'applying'}
      id={`approval-${a.id}`}
      title={
        <p className={ROW_TITLE}>
          <TextWithCode text={restore ? a.target : approvalTitle(a.tool, a.target)} codeClassName="text-zinc-100" />
        </p>
      }
      actions={
        settled ? (
          <SettledWord settled={settled} />
        ) : state.phase === 'error' ? (
          <KitButton variant="secondary" onClick={onResetError}>Try again</KitButton>
        ) : canDecide ? (
          <>
            <KitButton variant="secondary" onClick={onReject} disabled={busy} loading={state.phase === 'dismissing'}>
              Reject
            </KitButton>
            <KitButton variant="primary" onClick={onApprove} disabled={busy || unreadable} loading={state.phase === 'applying'}>
              {state.phase === 'applying' ? (restore ? 'Restoring…' : 'Running…') : restore ? 'Approve restore' : <>Approve &amp; run</>}
            </KitButton>
          </>
        ) : undefined
      }
    >
      {settled?.text && (
        <p role="status" className={`${ROW_TEXT} !text-zinc-300`}>
          <TextWithCode text={settled.text} codeClassName="text-zinc-200" />
        </p>
      )}
      {!settled && shownProse && <p className={`${ROW_TEXT} whitespace-pre-wrap`}>{shownProse}</p>}
      {!settled && agentWords && (
        <>
          <Disclosure open={showAgentWords} onToggle={() => setShowAgentWords(v => !v)}>
            {showAgentWords ? 'Hide what the agent wrote' : 'What the agent wrote'}
          </Disclosure>
          {showAgentWords && (
            // Quoted, and said to be unchecked, so it never reads as Backenly's.
            <p className={`${ROW_TEXT} whitespace-pre-wrap border-l-2 border-white/[0.10] pl-3`}>
              “{agentWords}” <span className="text-faint">Backenly has not checked this.</span>
            </p>
          )}
        </>
      )}
      {!settled && shownStatements.length > 0 && <CodeBlock>{shownStatements.join('\n')}</CodeBlock>}
      {!settled && long && (
        <Disclosure open={showFull} onToggle={() => setShowFull(v => !v)}>
          {showFull ? 'Show less' : 'Show the full request'}
        </Disclosure>
      )}
      <Facts>
        <Fact>{fromBackenly ? 'From Backenly' : 'From your agent'}</Fact>
        {a.rowCount !== null && a.rowCount > 0 && (
          <Fact strong>
            <span className="tabular-nums">{rows(a.rowCount)}</span>
          </Fact>
        )}
        <Fact>{restore ? 'Current state protected first' : a.reversible ? 'Restore point available' : 'Not auto-reversible'}</Fact>
        <Fact><Time iso={a.createdAt} /></Fact>
        {restore && a.changeId && (
          <a
            href={`/app/projects/${projectId}/changes?change=${encodeURIComponent(a.changeId)}`}
            className="text-zinc-300 underline decoration-white/20 underline-offset-2 hover:text-zinc-50"
          >
            View details
          </a>
        )}
        {a.tool === 'rollback_deploy' && (
          <a
            href={`/app/projects/${projectId}/changes`}
            className="text-zinc-300 underline decoration-white/20 underline-offset-2 hover:text-zinc-50"
          >
            Open History
          </a>
        )}
      </Facts>
      {!settled && a.tool === 'rollback_deploy' && (
        <p className="mt-2 text-[12.5px] leading-[18px] text-faint">Stops at the first change that can’t be restored.</p>
      )}
      {!settled && unreadable && (
        <p className="mt-2.5 text-[12.5px] leading-[18px] text-zinc-50">
          The exact call is kept in the project’s region and could not be read just now. Refresh to try again.
        </p>
      )}
      {!settled && !canDecide && <p className="mt-2.5 text-[12.5px] leading-[18px] text-faint">{ADMINS_DECIDE}</p>}
      {state.phase === 'error' && <RefusedLine className="mt-2.5">{state.message}</RefusedLine>}
    </Row>
  )
}

/** Statements shown before "Show the full request". */
const MAX_STATEMENTS = 6

/**
 * A request's text, split where a merge lists what it applies: the sentence
 * that introduces them, and the statements, one per line. The headline already
 * names the target, so the sentence that repeats it, and the "Requested by an
 * agent over MCP" prefix the facts say again, are left out of the sentence.
 */
function splitRequest(message: string, target: string): { prose: string; statements: string[] } {
  const at = message.search(/in order:\s*\n/)
  let prose = at === -1 ? message : message.slice(0, message.indexOf(':', at) + 1)
  const statements = at === -1
    ? []
    : message.slice(message.indexOf(':', at) + 1).split('\n').map(s => s.trim()).filter(Boolean)
  prose = prose.replace(/^Requested by an agent[^:\n]*:\s*/, '')
  if (statements.length > 0 && prose.startsWith(`${target}.`)) prose = prose.slice(target.length + 1).trim()
  return { prose: prose.trim(), statements }
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
    <Row
      lead="well"
      icon={approvalIcon(a.tool)}
      busy={running}
      id={`approval-${a.id}`}
      title={
        <p className={ROW_TITLE}>
          {running ? 'Approved, running now: ' : 'Approved, but the outcome is unknown: '}
          <TextWithCode text={approvalTitle(a.tool, a.target)} codeClassName="text-zinc-100" />
        </p>
      }
    >
      {!running && a.resultSummary && <p className={`${ROW_TEXT} !text-zinc-50`}>{resultWords(a.resultSummary)}</p>}
      <Facts>
        <Fact>From your agent</Fact>
        <Fact><Time iso={a.createdAt} /></Fact>
      </Facts>
    </Row>
  )
}

/**
 * The request handed to the user's coding agent. Some fixes genuinely belong
 * in the user's frontend code, and losing that door would have made the
 * single queue a net loss of capability.
 */
export function agentPrompt<T extends GroupableFinding>(g: FindingGroup<T>): string {
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

/** "Copy for agent", with the copy confirmed in place. */
export function CopyForAgent({ prompt, label = 'Copy for agent' }: { prompt: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <KitButton
      variant="secondary"
      onClick={() => {
        navigator.clipboard?.writeText(prompt).then(
          () => {
            setCopied(true)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 1800)
          },
          () => {},
        )
      }}
    >
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </KitButton>
  )
}

function ApprovalRow({
  group: g,
  state,
  settled,
  canDecide,
  onApprove,
  onApproveProposal,
  onDismiss,
  onResetError,
}: {
  group: FindingGroup<PendingApproval>
  state: RowState
  settled?: Settled
  canDecide: boolean
  onApprove: () => void
  onApproveProposal: (proposal: NonNullable<PendingApproval['proposal']>) => void
  onDismiss: () => void
  onResetError: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const head = g.members[0]
  const critical = g.severity === 'critical'
  const many = g.members.length > 1
  // A proposal is bound to one finding, so it is offered on single rows only.
  const proposal = !many ? head.proposal : undefined
  // A row whose approval removes a rule says so on its buttons.
  const labels = !many ? decisionLabels(head.type) : null
  const title = <p className={ROW_TITLE}><TextWithCode text={g.title} codeClassName="text-zinc-100" /></p>
  const busy = state.phase === 'applying' || state.phase === 'dismissing'
  const fixable = !!proposal || g.actionable

  // "Waiting for your review" under a heading that already says so says
  // nothing; every other reason (a guardrail, an escalation) is the point.
  const reason = reasonForApproval(head)
  const diag = diagnosisOf(head)

  return (
    <Row
      lead="well"
      icon={findingIcon(g.category)}
      tone={settled ? 'done' : 'neutral'}
      busy={state.phase === 'applying'}
      id={`finding-${g.key}`}
      title={title}
      actions={
        settled ? (
          <SettledWord settled={settled} />
        ) : state.phase === 'error' ? (
          <KitButton variant="secondary" onClick={onResetError}>Try again</KitButton>
        ) : canDecide ? (
          <>
            {!fixable && <CopyForAgent prompt={agentPrompt(g)} />}
            <KitButton variant="secondary" onClick={onDismiss} disabled={busy} loading={state.phase === 'dismissing'}>
              {labels?.dismiss ?? 'Dismiss'}
            </KitButton>
            {/* The fix button exists only when a fix does: `fixableCount` is
                computed from the executor's own action mapping. */}
            {proposal && (
              <KitButton variant="primary" onClick={() => onApproveProposal(proposal)} disabled={busy} loading={state.phase === 'applying'}>
                {state.phase === 'applying' ? 'Applying…' : 'Approve & fix'}
              </KitButton>
            )}
            {!proposal && g.actionable && (
              <KitButton variant="primary" onClick={onApprove} disabled={busy} loading={state.phase === 'applying'}>
                {state.phase === 'applying'
                  ? (g.fixableCount > 1 ? `Applying ${g.fixableCount}…` : labels?.busy ?? 'Applying…')
                  : (g.fixableCount > 1 ? `Approve & fix all ${g.fixableCount}` : labels?.approve ?? 'Approve & fix')}
              </KitButton>
            )}
            {fixable && (
              <OverflowMenu
                label={`More actions for: ${g.title}`}
                disabled={busy}
                width="w-[230px]"
                items={[{ label: 'Copy for agent', icon: ClipboardCopy, onClick: () => { void navigator.clipboard?.writeText(agentPrompt(g)) } }]}
              />
            )}
          </>
        ) : undefined
      }
    >
      {settled?.text && (
        <p role="status" className={`${ROW_TEXT} !text-zinc-300`}>
          <TextWithCode text={settled.text} codeClassName="text-zinc-200" />
        </p>
      )}
      {!settled && heldKindLabel(head) && (
        <p className="mt-1 text-[12.5px] font-medium leading-[18px] text-zinc-50">{heldKindLabel(head)}</p>
      )}
      {!settled && reason !== WAITING_FOR_REVIEW && <p className={ROW_TEXT}>{reason}</p>}
      {!settled && diag && (
        <div className="mt-2.5 border-l-2 border-white/[0.08] pl-3">
          <p className="text-[12px] font-medium leading-[16px] text-faint">
            {diag.provenance === 'investigation'
              ? `Confirmed by investigation${diag.observations ? `, ${diag.observations} observation${diag.observations === 1 ? '' : 's'}` : ''}`
              : 'AI hypothesis, not verified'}
          </p>
          {diag.rootCause && <p className="mt-1 text-[13px] leading-[19px] text-zinc-300">{diag.rootCause}</p>}
          {diag.recommendation && (
            <p className="mt-1 text-[13px] leading-[19px] text-zinc-400">
              <span className="text-zinc-300">Recommended:</span> {diag.recommendation}
            </p>
          )}
        </div>
      )}
      {/* An AI-proposed repair: what it does, in one line; the rest is the facts. */}
      {!settled && proposal && state.phase !== 'error' && (
        <p className={ROW_TEXT}>
          <span className="text-zinc-300">Proposed repair:</span> {proposal.summary}
        </p>
      )}
      <Facts>
        {critical && <Fact strong><span className="font-medium text-zinc-50">Critical</span></Fact>}
        <Fact>{CATEGORY_LABEL[g.category]}</Fact>
        {!many && head.resource && <Fact><MetaCode>{head.resource}</MetaCode></Fact>}
        {head.source && head.source !== 'autonomy' && (
          <Fact>{head.source === 'brain-risk' ? 'Raised by an AI agent' : 'From the backend build'}</Fact>
        )}
        {proposal && <Fact>AI-proposed, recorded as fixed only if a re-check confirms it</Fact>}
        {!fixable && <Fact>No automatic fix</Fact>}
        <Fact><Time iso={head.detectedAt} /></Fact>
      </Facts>

      {/* No auto-repair exists for this row. Say so HERE, before the user
          spends a click discovering it, and say what to do instead. The
          hint is the same sentence the approve route would have returned,
          read from the one fix mapping (lib/core/fix-actions.ts). */}
      {!settled && !fixable && state.phase !== 'error' && g.manualHint && (
        <p className={ROW_TEXT}>{g.manualHint}</p>
      )}

      {/* The fold is never a hiding place: every member is one click away,
          and the count is stated before you click. */}
      {many && (
        <>
          <Disclosure open={expanded} onToggle={() => setExpanded(v => !v)}>
            {g.members.length} findings, one cause
          </Disclosure>
          {expanded && (
            <ul className="mt-2 space-y-1 border-l-2 border-white/[0.08] pl-3">
              {g.members.map((m, i) => (
                <li key={m.id} className="font-mono text-[12px] leading-[19px] text-zinc-400">
                  {g.subjects[i] ?? m.resource ?? m.reason}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {!settled && !canDecide && <p className="mt-2.5 text-[12.5px] leading-[18px] text-faint">{DEVELOPERS_DECIDE}</p>}
      {state.phase === 'error' && <RefusedLine className="mt-2.5">{state.message}</RefusedLine>}
    </Row>
  )
}

/** The fallback reason, which the "Waiting on you" heading already says. */
const WAITING_FOR_REVIEW = 'Waiting for your review.'

/** Cut at the last word boundary within `max` characters and mark the cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`
}
