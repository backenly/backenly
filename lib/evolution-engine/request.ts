/**
 * APPROVAL REQUESTS — asking a person, in the queue they already use
 * ==================================================================
 *
 * An architecture change that is ready to run is asked for in the Autonomy
 * page's "Waiting on you" queue, as a HealthFinding of type
 * `architecture_evolution`. Not a new table, not a new page, not a new tab: the
 * queue already has a badge, a dismiss path that doubles as "no", and the
 * guarantee that nothing an agent holds can decide it (every decision route
 * needs a platform session; MCP credentials are API keys).
 *
 * ── Three doors that must stay shut ─────────────────────────────────────────
 *
 *   status is never `open`     the Detected panel offers "Fix now" on every
 *                              open row
 *   details carry no `fix`     the approvals API runs `details.fix.sql` as
 *                              written
 *   no tableName / location    harm, repair and recurrence counters read those
 *                              as evidence about the table; a request is not
 *                              a problem with it
 *
 * Generic approve paths refuse this type outright (`isEvolutionApprovalFinding`).
 * Consent goes only through `approveRequest` in ./engine.ts, which binds it to
 * the plan version the person was shown, rebuilt from the live system.
 *
 * ── What the row is, through a change's life ────────────────────────────────
 *
 *   pending_approval  waiting on the person: approve a proposal, or decide what
 *                     happens to a change that stopped (`ask`)
 *   approving         claimed by one approval request; a second click gets 409
 *   approved          consent given; the change runs and is reported in the
 *                     activity feed, not the queue
 *   dismissed         the person said no (the decline is remembered)
 *   resolved          the change finished, or was undone
 *
 * The lifecycle itself lives in architecture memory (./memory.ts); this row is
 * only the handle a person acts on.
 */

import { prisma } from '@/lib/db'
import { EVOLUTION_FINDING_TYPE } from '@/lib/core/types'
import type { EvolutionLevel } from './levels'
import type { RiskLevel } from './policy'
import type { UserFacingSummary } from './primitive'

export type RequestAsk =
  /** Approve a prepared, rehearsed change. */
  | 'approve'
  /** A change stopped part-way and needs a decision: resume it or undo it. */
  | 'resume_or_undo'

export type RequestStatus = 'pending_approval' | 'approving' | 'approved' | 'dismissed' | 'resolved'

/** `details.evolution` of an `architecture_evolution` finding. */
export interface EvolutionRequestDetails {
  v: 1
  primitive: string
  decisionId: string
  concernKey: string
  proposalKey: string
  planId: string
  /** The exact version consent will be bound to. */
  planVersion: string
  /** What it is about, e.g. the table name. For display only. */
  subject: string
  /** What consent binds to. Read from here at approval, never from the request body. */
  spec: unknown
  level: EvolutionLevel
  ask: RequestAsk
  /** Plain words: headline, what changes, why, compatibility, undo. */
  summary: UserFacingSummary
  risk: RiskLevel
  rehearsal: {
    planVersion: string
    passed: boolean
    authorization: 'passed' | 'failed' | 'unavailable'
    detail: string
    at: string
  }
  /** Why a change stopped, for `ask: 'resume_or_undo'`. */
  stoppedBecause?: string
  /**
   * Opt-in detail, never shown by default: the steps with their exact SQL, the
   * evidence, what this change deliberately does not decide, what a person
   * must migrate before the old columns could ever be retired.
   */
  technical: {
    steps: Array<{ title: string; why: string; tier: number; humanOnly: boolean; sql: string[] }>
    evidence: Array<{ family: string; verdict: string; detail: string }>
    pressure: Array<{ kind: string; class: string; detail: string }>
    semanticBoundary: string
    contractBlockers: string[]
    caveats: string[]
    clientMigration: Array<{ purpose: string; before: string; after: string }>
  }
}

export interface EvolutionRequest {
  findingId: string
  status: RequestStatus
  detectedAt: Date
  evolution: EvolutionRequestDetails
}

const SELECT = { id: true, status: true, detectedAt: true, details: true } as const

function coerce(row: { id: string; status: string; detectedAt: Date; details: unknown }): EvolutionRequest | null {
  const ev = ((row.details ?? {}) as { evolution?: EvolutionRequestDetails }).evolution
  if (!ev || ev.v !== 1) return null
  return { findingId: row.id, status: row.status as RequestStatus, detectedAt: row.detectedAt, evolution: ev }
}

/** Requests still in play for a concern: waiting on a person, or approved and running. */
export async function liveRequestFor(projectId: string, concernKey: string): Promise<EvolutionRequest | null> {
  const row = await prisma.healthFinding.findFirst({
    where: {
      projectId,
      type: EVOLUTION_FINDING_TYPE,
      status: { in: ['pending_approval', 'approving', 'approved'] },
      details: { path: ['evolution', 'concernKey'], equals: concernKey },
    },
    orderBy: { detectedAt: 'desc' },
    select: SELECT,
  })
  return row ? coerce(row) : null
}

export async function requestById(projectId: string, findingId: string): Promise<EvolutionRequest | null> {
  const row = await prisma.healthFinding.findFirst({
    where: { id: findingId, projectId, type: EVOLUTION_FINDING_TYPE },
    select: SELECT,
  })
  return row ? coerce(row) : null
}

export async function requestForDecision(projectId: string, decisionId: string): Promise<EvolutionRequest | null> {
  const row = await prisma.healthFinding.findFirst({
    where: { projectId, type: EVOLUTION_FINDING_TYPE, details: { path: ['evolution', 'decisionId'], equals: decisionId } },
    orderBy: { detectedAt: 'desc' },
    select: SELECT,
  })
  return row ? coerce(row) : null
}

/**
 * Raise a request, or update the one already waiting for this concern in place
 * (a new plan version replaces the old one; the person never sees two rows for
 * one decision). Returns the finding id.
 */
export async function raiseRequest(projectId: string, evolution: EvolutionRequestDetails): Promise<string> {
  // The only shape this row may ever have. Spelled out so nobody adds `fix`.
  const details = { evolution } as object
  const existing = await liveRequestFor(projectId, evolution.concernKey)
  // Mid-approval: the claim holder decides what the row becomes next.
  if (existing?.status === 'approving') return existing.findingId
  if (existing) {
    await prisma.healthFinding.update({
      where: { id: existing.findingId },
      data: { details, status: 'pending_approval', severity: 'info' },
    })
    return existing.findingId
  }
  const row = await prisma.healthFinding.create({
    data: {
      projectId,
      type: EVOLUTION_FINDING_TYPE,
      severity: 'info',
      category: 'reliability',
      source: 'evolution_engine',
      status: 'pending_approval',
      details,
    },
    select: { id: true },
  })
  return row.id
}

/**
 * Claim a waiting request for one approval attempt. Atomic: of two clicks, or
 * two tabs, exactly one gets it.
 */
export async function claimRequest(projectId: string, findingId: string): Promise<boolean> {
  const r = await prisma.healthFinding.updateMany({
    where: { id: findingId, projectId, type: EVOLUTION_FINDING_TYPE, status: 'pending_approval' },
    data: { status: 'approving' },
  })
  return r.count === 1
}

export async function setRequestStatus(
  projectId: string,
  findingId: string,
  status: RequestStatus,
  patch?: Partial<EvolutionRequestDetails>,
): Promise<void> {
  const current = await requestById(projectId, findingId)
  if (!current) return
  await prisma.healthFinding.update({
    where: { id: findingId },
    data: {
      status,
      ...(patch ? { details: { evolution: { ...current.evolution, ...patch } } as object } : {}),
      ...(status === 'resolved' ? { fixAppliedAt: new Date() } : {}),
    },
  })
}

/** Has the person declined this concern, and when? Read from dismissed requests. */
export async function lastDeclined(projectId: string, concernKey: string): Promise<Date | null> {
  const row = await prisma.healthFinding.findFirst({
    where: {
      projectId,
      type: EVOLUTION_FINDING_TYPE,
      status: 'dismissed',
      details: { path: ['evolution', 'concernKey'], equals: concernKey },
    },
    orderBy: { detectedAt: 'desc' },
    select: { detectedAt: true },
  })
  return row?.detectedAt ?? null
}
