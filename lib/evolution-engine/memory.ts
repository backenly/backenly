/**
 * ARCHITECTURE MEMORY — why the backend looks the way it does
 * ===========================================================
 *
 * Every architecture decision leaves a trail: what was detected and on what
 * evidence, what the structure was before, what was proposed and why, the exact
 * plan and the state it was bound to, the numbers before, what happened while
 * it ran, the numbers after, whether it helped, whether it was undone. Months
 * later that trail is the only honest answer to "why is refunds its own
 * table?" — and the only thing that stops an engine rediscovering, and
 * re-proposing, a change its owner already reversed.
 *
 * ── Stored as audit rows, deliberately ─────────────────────────────────────
 *
 * `audit_logs` is the one history store a normal user already sees (the
 * Autonomy page's recent actions and the Workspace Home receipts read it), it
 * has a JSON column that can be queried by path, nothing reaps it, and it
 * cascades with the project. A new table would have to re-earn all of that and
 * would be one more place for an operator to forget to look.
 *
 *   type     'architecture' — rare, so the type index is selective, and no
 *            existing substring or prefix reader matches it
 *   action   ARCHITECTURE_EVOLUTION        a milestone a person sees
 *            ARCHITECTURE_EVOLUTION_TRACE  recorded for memory, never shown
 *   details  a short render payload, including the one sentence a person reads.
 *            Never SQL.
 *   metadata { evolution: EvolutionRecord } — the structured record
 *
 * The execution ledger (maintenance_executions / _step_executions) stays the
 * source of truth for what each rung did; these rows point at it by id and
 * keep the decision around it.
 *
 * ── Lineage ────────────────────────────────────────────────────────────────
 *
 * A decision is keyed by `decisionId`; decisions about the same thing are tied
 * together by `concernKey` — the primitive's stable name for WHAT is being
 * reorganised (e.g. `orders:refund`), which survives a column being added to
 * the group. Without it, adding `refund_note` after a reversal would mint a new
 * plan id and the reversal would be forgotten.
 */

import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import type { LifecycleState } from './lifecycle'
import type { EvolutionLevel, PriorOutcome } from './levels'
import type { ObservationSignal, TelemetrySnapshot } from './primitive'
import type { ObservationPass } from './observe'

export const ARCHITECTURE_LOG_TYPE = 'architecture'
export const MILESTONE_ACTION = 'ARCHITECTURE_EVOLUTION'
export const TRACE_ACTION = 'ARCHITECTURE_EVOLUTION_TRACE'

/** Limits that keep one audit row an audit row. */
const DETAILS_MAX = 1_000
const METADATA_MAX = 16_000

export type MemoryEvent =
  /** The engine's assessment of a concern changed level. */
  | 'assessed'
  /** A lifecycle transition. `state` is the state entered. */
  | 'transition'
  /** One observation pass after cutover. */
  | 'observed'
  /** The owner declined the request. */
  | 'declined'
  /** The owner withdrew consent before it ran. */
  | 'withdrawn'
  /** A telemetry snapshot (payload.snapshot), kept so before/after outlives log retention. */
  | 'measured'
  /** A verdict on whether the change helped (payload.benefit). May be revised later. */
  | 'outcome'

export interface EvolutionRecord {
  v: 1
  decisionId: string
  /** What is being reorganised, stable across membership changes. */
  concernKey: string
  proposalKey: string
  planId: string
  planVersion?: string
  primitive: string
  subject: string
  event: MemoryEvent
  state?: LifecycleState
  from?: LifecycleState | null
  level?: EvolutionLevel
  /** Hash of the evidence that produced this decision: the "is anything new?" test. */
  evidenceHash?: string
  attempt?: number
  /** Per-event payload: evidence, before/after metrics, rehearsal, outcome. */
  payload?: Record<string, unknown>
}

export function newDecisionId(): string {
  return randomUUID()
}

/** A stable hash of evidence, so "has anything changed since?" is a comparison. */
export function evidenceHashOf(evidence: unknown): string {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex').slice(0, 16)
}

/** Keep a payload under the row limit by dropping its largest keys first, and say so. */
function bounded(record: EvolutionRecord): EvolutionRecord {
  if (JSON.stringify(record).length <= METADATA_MAX || !record.payload) return record
  const payload = { ...record.payload }
  const keys = Object.keys(payload).sort((a, b) => JSON.stringify(payload[b]).length - JSON.stringify(payload[a]).length)
  const dropped: string[] = []
  for (const k of keys) {
    if (JSON.stringify({ ...record, payload }).length <= METADATA_MAX) break
    delete payload[k]
    dropped.push(k)
  }
  return { ...record, payload: { ...payload, truncated: dropped } }
}

/**
 * Append one memory row. Idempotent per (decision, event, state, attempt): a
 * resumed ladder or a retried scheduler pass records a transition once.
 */
export async function remember(input: {
  projectId: string
  record: EvolutionRecord
  /** Shown to a person (Autonomy page, Workspace Home), or kept for memory only. */
  milestone: boolean
  /** The one sentence a person reads. Plain words, no SQL. */
  sentence: string
  userId?: string | null
}): Promise<{ written: boolean }> {
  const r = input.record
  const where = [
    { metadata: { path: ['evolution', 'decisionId'], equals: r.decisionId } },
    { metadata: { path: ['evolution', 'event'], equals: r.event } },
    ...(r.state ? [{ metadata: { path: ['evolution', 'state'], equals: r.state } }] : []),
    ...(r.attempt !== undefined ? [{ metadata: { path: ['evolution', 'attempt'], equals: r.attempt } }] : []),
  ]
  // Observation passes and assessments are a series, not a transition: each
  // one is new information and is always appended.
  if (r.event === 'transition' || r.event === 'declined' || r.event === 'withdrawn') {
    const existing = await prisma.auditLog
      .findFirst({ where: { projectId: input.projectId, type: ARCHITECTURE_LOG_TYPE, AND: where }, select: { id: true } })
      .catch(() => null)
    if (existing) return { written: false }
  }

  const details = JSON.stringify({
    v: 1,
    decisionId: r.decisionId,
    event: r.event,
    state: r.state ?? null,
    primitive: r.primitive,
    subject: r.subject,
    sentence: input.sentence,
  }).slice(0, DETAILS_MAX)

  await prisma.auditLog.create({
    data: {
      projectId: input.projectId,
      userId: input.userId ?? null,
      action: input.milestone ? MILESTONE_ACTION : TRACE_ACTION,
      type: ARCHITECTURE_LOG_TYPE,
      details,
      metadata: { evolution: bounded(r) } as object,
      timestamp: new Date(),
    },
  })
  return { written: true }
}

export interface MemoryEntry {
  at: Date
  milestone: boolean
  sentence: string
  userId: string | null
  record: EvolutionRecord
}

type MemoryRow = { timestamp: Date; action: string; details: string | null; userId: string | null; metadata: unknown }

function toEntry(row: MemoryRow): MemoryEntry | null {
  const record = ((row.metadata ?? {}) as { evolution?: EvolutionRecord }).evolution
  if (!record || record.v !== 1) return null
  let sentence = ''
  try {
    sentence = String((JSON.parse(row.details ?? '{}') as { sentence?: string }).sentence ?? '')
  } catch {
    sentence = ''
  }
  return { at: row.timestamp, milestone: row.action === MILESTONE_ACTION, sentence, userId: row.userId, record }
}

const SELECT_ROW = { timestamp: true, action: true, details: true, userId: true, metadata: true } as const

const eventIs = (event: MemoryEvent) => ({ metadata: { path: ['evolution', 'event'], equals: event } })

/** How many recent assessments a project read carries: enough for "the latest per concern". */
export const RECENT_ASSESSMENTS = 1_000

/**
 * What the engine decides from, for a whole project, oldest first.
 *
 * Every row that sets a decision's state or a concern's prior (transitions,
 * declines, withdrawals, outcomes) is read, however old: a decline must hold
 * however many rows came after it. Assessments are a series read for their
 * latest values, so only the most recent ones are. Observation passes and
 * snapshots belong to one decision and are read with its trail
 * (`decisionTrail`), never here.
 *
 * A failed read throws. "Could not read" must never look like "nothing was
 * ever decided", which would raise a declined change again.
 */
export async function readMemory(projectId: string): Promise<MemoryEntry[]> {
  const base = { projectId, type: ARCHITECTURE_LOG_TYPE }
  const [decisive, assessments] = await Promise.all([
    prisma.auditLog.findMany({
      where: { ...base, NOT: [eventIs('assessed'), eventIs('observed'), eventIs('measured')] },
      orderBy: { timestamp: 'asc' },
      select: SELECT_ROW,
    }),
    prisma.auditLog.findMany({
      where: { ...base, AND: [eventIs('assessed')] },
      orderBy: { timestamp: 'desc' },
      take: RECENT_ASSESSMENTS,
      select: SELECT_ROW,
    }),
  ])
  return [...decisive, ...(assessments as MemoryRow[]).reverse()]
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .map(toEntry)
    .filter((e): e is MemoryEntry => e !== null)
}

/** One decision, every event, oldest first — the "View details" trail. */
export async function decisionTrail(projectId: string, decisionId: string): Promise<MemoryEntry[]> {
  const rows = await prisma.auditLog
    .findMany({
      where: { projectId, type: ARCHITECTURE_LOG_TYPE, metadata: { path: ['evolution', 'decisionId'], equals: decisionId } },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true, action: true, details: true, userId: true, metadata: true },
    })
    .catch(() => [])
  return rows.map(toEntry).filter((e): e is MemoryEntry => e !== null)
}

export interface DecisionSummary {
  decisionId: string
  concernKey: string
  proposalKey: string
  planId: string
  planVersion?: string
  primitive: string
  subject: string
  /** What consent binds to, from the most recent record that carried it. */
  spec?: unknown
  /** The approval-request finding, once one was raised. */
  findingId?: string
  /** The last lifecycle state entered, if any transition was recorded. */
  state: LifecycleState | null
  /** A person approved it at some point. Changes never approved are not news to anyone. */
  everApproved: boolean
  /** Why the change last stopped (blocked/failed), in plain words. */
  stoppedBecause?: string
  declined: boolean
  withdrawn: boolean
  /** An observation or benefit verdict said it made things worse. */
  regressed: boolean
  /** When the change entered `observing`: the start of "after". */
  cutoverAt?: Date
  /**
   * When the current watch began: the latest entry into `observing`. Equal to
   * `cutoverAt` unless a person kept the change after a stop, when watching
   * starts again from that decision and earlier passes no longer judge it.
   */
  observingSince?: Date
  /** An undo removed part of the change and then failed: only undo remains. */
  undoIncomplete: boolean
  /** The latest benefit verdict, if one was reached. */
  outcome?: { verdict: string; summary: string; at: Date }
  /** The latest sentence a person was shown about this decision. */
  headline?: string
  evidenceHash?: string
  startedAt: Date
  updatedAt: Date
}

/**
 * Fold a trail into one line per decision.
 *
 * Assessments are not decisions: they record what the engine thought of a
 * concern and are read by `latestAssessment`, never folded here.
 */
export function summarizeDecisions(entries: MemoryEntry[]): DecisionSummary[] {
  const by = new Map<string, DecisionSummary>()
  for (const e of entries) {
    const r = e.record
    if (r.event === 'assessed') continue
    const d =
      by.get(r.decisionId) ??
      ({
        decisionId: r.decisionId,
        concernKey: r.concernKey,
        proposalKey: r.proposalKey,
        planId: r.planId,
        primitive: r.primitive,
        subject: r.subject,
        state: null,
        everApproved: false,
        declined: false,
        withdrawn: false,
        regressed: false,
        undoIncomplete: false,
        startedAt: e.at,
        updatedAt: e.at,
      } as DecisionSummary)
    const p = (r.payload ?? {}) as {
      spec?: unknown
      findingId?: string
      reason?: string
      verdict?: string
      benefit?: { verdict?: string; summary?: string }
      undoIncomplete?: boolean
    }
    if (r.planVersion) d.planVersion = r.planVersion
    if (r.evidenceHash) d.evidenceHash = r.evidenceHash
    if (p.spec !== undefined) d.spec = p.spec
    if (p.findingId) d.findingId = p.findingId
    if (r.event === 'transition' && r.state) {
      d.state = r.state
      if (r.state === 'approved') d.everApproved = true
      if (r.state === 'observing' && !d.cutoverAt) d.cutoverAt = e.at
      // A refused undo hands the change back to where it was: the watch goes on.
      if (r.state === 'observing' && r.from !== 'rolling_back') d.observingSince = e.at
      if (r.state === 'blocked' || r.state === 'failed') d.stoppedBecause = p.reason
      // Only a later undo, finished or not, says otherwise.
      if (r.state === 'blocked' && p.undoIncomplete) d.undoIncomplete = true
      if (r.state === 'rolling_back' || r.state === 'rolled_back') d.undoIncomplete = false
      // Re-entering a stage after a stop clears the stop; resuming is a fresh start.
      if (!['blocked', 'failed'].includes(r.state)) {
        d.stoppedBecause = undefined
        d.withdrawn = false
      }
    }
    if (r.event === 'declined') d.declined = true
    if (r.event === 'withdrawn') d.withdrawn = true
    if (r.event === 'outcome' && p.benefit?.verdict) {
      d.outcome = { verdict: p.benefit.verdict, summary: p.benefit.summary ?? '', at: e.at }
    }
    if (p.verdict === 'regressed' || p.benefit?.verdict === 'regressed') d.regressed = true
    if (e.milestone && e.sentence) d.headline = e.sentence
    d.updatedAt = e.at
    by.set(r.decisionId, d)
  }
  return [...by.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
}

/**
 * What memory says about a concern, for the level classifier.
 *
 * The LATEST decision about the concern decides: in effect, reversed (and
 * whether it was reversed for making things worse), declined by its owner, or
 * nothing. Re-proposal after a reversal or a refusal needs evidence first
 * measured afterwards — see ./levels.ts.
 */
export function priorFor(decisions: DecisionSummary[], concernKey: string): PriorOutcome {
  const mine = decisions.filter(d => d.concernKey === concernKey)
  const latest = mine[mine.length - 1]
  if (!latest) return { kind: 'none' }
  const at = latest.updatedAt.toISOString()
  if (latest.state === 'rolled_back') return { kind: 'reversed', regressed: latest.regressed, at }
  if (latest.declined) return { kind: 'declined', at }
  if (latest.state && ['expanding', 'backfilling', 'verifying', 'cutover', 'observing', 'stable'].includes(latest.state)) {
    return { kind: 'in_effect', at }
  }
  return { kind: 'none' }
}

/** The open decision for a concern, if one is still in flight or awaiting consent. */
export function openDecision(decisions: DecisionSummary[], concernKey: string): DecisionSummary | null {
  const mine = decisions.filter(d => d.concernKey === concernKey)
  const latest = mine[mine.length - 1]
  if (!latest) return null
  if (latest.declined || latest.state === 'rolled_back' || latest.state === 'stable') return null
  return latest
}

/** Every remembered prior, keyed by concern: the input the analysis consults. */
export function priorsFor(decisions: DecisionSummary[]): Record<string, PriorOutcome> {
  const out: Record<string, PriorOutcome> = {}
  for (const key of new Set(decisions.map(d => d.concernKey))) {
    const prior = priorFor(decisions, key)
    if (prior.kind !== 'none') out[key] = prior
  }
  return out
}

/** The observation passes recorded for one decision, oldest first. */
export function passesOf(trail: MemoryEntry[]): ObservationPass[] {
  return trail
    .filter(e => e.record.event === 'observed')
    .map(e => ({
      at: e.at.toISOString(),
      signals: ((e.record.payload ?? {}) as { signals?: ObservationSignal[] }).signals ?? [],
    }))
}

/** The telemetry snapshots recorded for one decision, oldest first. */
export function snapshotsOf(trail: MemoryEntry[]): TelemetrySnapshot[] {
  return trail
    .filter(e => e.record.event === 'measured')
    .map(e => ((e.record.payload ?? {}) as { snapshot?: TelemetrySnapshot }).snapshot)
    .filter((x): x is TelemetrySnapshot => !!x && x.v === 1)
}

/** The most recent assessment recorded for a concern, if any. */
export function latestAssessment(entries: MemoryEntry[], concernKey: string): MemoryEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.record.event === 'assessed' && e.record.concernKey === concernKey) return e
  }
  return null
}
