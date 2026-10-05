/**
 * CONSENT AND THE LEDGER — the maintenance tables, for a second kind of ladder
 * ============================================================================
 *
 * Structural evolution does not get its own approval table, execution ledger or
 * lock. It writes the ones the maintenance ladder already ships:
 *
 *   maintenance_approvals        consent to one exact plan version
 *   maintenance_executions       one row per attempt
 *   maintenance_step_executions  one row per rung, keyed by idempotency key,
 *                                with observed pre/post state for rollback
 *
 * Reusing them is a decision, not a shortcut. Those tables already encode every
 * rule consent needs — bound to a version, revocable mid-flight, clamped below
 * tier 3 — and they already passed the production persistence gate. A parallel
 * set would have to re-earn both, and two ledgers for "a robot changed this
 * schema" is one more place for an operator to forget to look.
 *
 * The rows are told apart by two things, both stable:
 *
 *   findingId  starts with `evolution:` — the proposal key, not a HealthFinding
 *              id. The maintenance sweep and its pending-ladder reader only ever
 *              select `subsystem_repeat_failure` findings, so they never see it.
 *   bindings   `{ kind: 'evolution', spec }` — what the owner consented to, in
 *              real identifiers, including the satellite name they chose.
 *
 * ── You cannot approve a version that does not exist ───────────────────────
 *
 * As in the maintenance approval path: the plan is rebuilt from the live
 * catalog and the submitted spec, and consent is refused unless it hashes to
 * the version the approver was shown. A stale tab or a replayed request cannot
 * authorise SQL nobody looked at.
 */

import { prisma } from '@/lib/db'
import { MAX_APPROVABLE_TIER } from '@/lib/autonomy/maintenance/approval'
import { requiredTier, type ExtractionPlan } from './plan'
import type { ExtractionSpec } from './sql'

export const EVOLUTION_BINDING_KIND = 'evolution'
export const EVOLUTION_FINDING_PREFIX = 'evolution:'

export interface EvolutionApproval {
  id: string
  planId: string
  planVersion: string
  maxTier: number
  spec: ExtractionSpec
  approvedBy: string
  reason: string | null
  createdAt: Date
  revokedAt: Date | null
}

function coerce(row: {
  id: string
  planId: string
  planVersion: string
  maxTier: number
  bindings: unknown
  approvedBy: string
  reason: string | null
  createdAt: Date
  revokedAt: Date | null
}): EvolutionApproval | null {
  const b = (row.bindings ?? {}) as { kind?: string; spec?: ExtractionSpec }
  if (b.kind !== EVOLUTION_BINDING_KIND || !b.spec) return null
  return {
    id: row.id,
    planId: row.planId,
    planVersion: row.planVersion,
    maxTier: row.maxTier,
    spec: b.spec,
    approvedBy: row.approvedBy,
    reason: row.reason,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  }
}

const SELECT = {
  id: true,
  planId: true,
  planVersion: true,
  maxTier: true,
  bindings: true,
  approvedBy: true,
  reason: true,
  createdAt: true,
  revokedAt: true,
} as const

/** The live, unrevoked consent for one plan. Re-read before every privileged rung. */
export async function readLiveEvolutionApproval(projectId: string, planId: string): Promise<EvolutionApproval | null> {
  const row = await prisma.maintenanceApproval.findFirst({
    where: { projectId, planId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: SELECT,
  })
  return row ? coerce(row) : null
}

/** The most recent consent for a plan, revoked or not. For display and for rollback's spec. */
export async function readLatestEvolutionApproval(projectId: string, planId: string): Promise<EvolutionApproval | null> {
  const row = await prisma.maintenanceApproval.findFirst({
    where: { projectId, planId },
    orderBy: { createdAt: 'desc' },
    select: SELECT,
  })
  return row ? coerce(row) : null
}

export async function listLiveEvolutionApprovals(projectId: string): Promise<EvolutionApproval[]> {
  const rows = await prisma.maintenanceApproval.findMany({
    where: { projectId, revokedAt: null, findingId: { startsWith: EVOLUTION_FINDING_PREFIX } },
    orderBy: { createdAt: 'asc' },
    select: SELECT,
  })
  return rows.map(coerce).filter((x): x is EvolutionApproval => x !== null)
}

export type GrantResult =
  | { ok: true; approval: EvolutionApproval; plan: ExtractionPlan }
  | { ok: false; refusal: string; currentPlanVersion?: string }

export const isGrantRefusal = (r: GrantResult): r is Extract<GrantResult, { ok: false }> => !r.ok

/**
 * Record consent to one plan version.
 *
 * `resolve` is injected so this module stays free of the analysis import graph;
 * every production caller passes `resolveExtractionPlan`.
 */
export async function grantEvolutionApproval(input: {
  projectId: string
  spec: ExtractionSpec
  planVersion: string
  approvedBy: string
  reason?: string | null
  resolve: (projectId: string, spec: ExtractionSpec) => Promise<{ plan: ExtractionPlan } | { refusal: string }>
}): Promise<GrantResult> {
  const { projectId, approvedBy } = input
  if (!approvedBy.trim()) return { ok: false, refusal: 'an approval must name who gave it' }

  const resolved = await input.resolve(projectId, input.spec)
  if ('refusal' in resolved) return { ok: false, refusal: resolved.refusal }
  const { plan } = resolved

  if (plan.planVersion !== input.planVersion) {
    return {
      ok: false,
      refusal:
        `this extraction is now version ${plan.planVersion}, not ${input.planVersion}. The table, its grants, the ` +
        'chosen name or the executor moved since it was shown, so it has to be re-read before it can be approved.',
      currentPlanVersion: plan.planVersion,
    }
  }
  if (plan.validity !== 'executable') {
    return { ok: false, refusal: `the plan is ${plan.validity}: ${plan.blockedReasons.join('; ')}` }
  }
  const tier = requiredTier(plan)
  if (tier > MAX_APPROVABLE_TIER) {
    return { ok: false, refusal: `the plan needs tier ${tier}, above anything a person may approve for a robot` }
  }

  const row = await prisma.maintenanceApproval.upsert({
    where: { planId_planVersion: { planId: plan.planId, planVersion: plan.planVersion } },
    create: {
      projectId,
      findingId: plan.proposalKey,
      planId: plan.planId,
      planVersion: plan.planVersion,
      maxTier: MAX_APPROVABLE_TIER,
      approvedBy,
      reason: input.reason ?? null,
      bindings: { kind: EVOLUTION_BINDING_KIND, spec: plan.spec } as object,
    },
    update: {
      approvedBy,
      reason: input.reason ?? null,
      bindings: { kind: EVOLUTION_BINDING_KIND, spec: plan.spec } as object,
      revokedAt: null,
      revokedBy: null,
    },
    select: SELECT,
  })
  return { ok: true, approval: coerce(row)!, plan }
}

export type RevokeResult = { ok: true; id: string } | { ok: false; refusal: string }

/** `strict` is off in this repo, so a boolean discriminant does not narrow. */
export const isRevokeRefusal = (r: RevokeResult): r is Extract<RevokeResult, { ok: false }> => !r.ok

export async function revokeEvolutionApproval(input: {
  projectId: string
  approvalId: string
  revokedBy: string
}): Promise<RevokeResult> {
  // Scoped to the validated project and to this kind of ladder, so an id learned
  // elsewhere cannot withdraw consent across a tenancy boundary or a subsystem.
  const row = await prisma.maintenanceApproval.findFirst({
    where: { id: input.approvalId, projectId: input.projectId },
    select: SELECT,
  })
  if (!row) return { ok: false, refusal: 'no such approval' }
  if (!coerce(row)) return { ok: false, refusal: 'that approval is not for a structural evolution' }
  if (row.revokedAt) return { ok: true, id: row.id }
  await prisma.maintenanceApproval.update({
    where: { id: row.id },
    data: { revokedAt: new Date(), revokedBy: input.revokedBy },
  })
  return { ok: true, id: row.id }
}

// ── Ledger reads ─────────────────────────────────────────────────────────────

export interface LedgerStep {
  ordinal: number
  kind: string
  status: string
  idempotencyKey: string
  result: unknown
  observedPostState: unknown
  rollbackStatus: string | null
  completedAt: Date | null
}

export interface LedgerRun {
  executionId: string
  status: string
  haltReason: string | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
}

export async function latestRun(projectId: string, planId: string): Promise<LedgerRun | null> {
  const row = await prisma.maintenanceExecution.findFirst({
    where: { projectId, planId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, haltReason: true, startedAt: true, completedAt: true, createdAt: true },
  })
  return row
    ? { executionId: row.id, status: row.status, haltReason: row.haltReason, startedAt: row.startedAt, completedAt: row.completedAt, createdAt: row.createdAt }
    : null
}

/** Every rung this plan ever ran, across attempts, newest state per rung. */
export async function ledgerSteps(projectId: string, planId: string): Promise<LedgerStep[]> {
  const rows = await prisma.maintenanceStepExecution.findMany({
    where: { execution: { projectId, planId } },
    orderBy: [{ ordinal: 'asc' }, { updatedAt: 'desc' }],
    select: {
      ordinal: true,
      stepKind: true,
      status: true,
      idempotencyKey: true,
      result: true,
      observedPostState: true,
      rollbackStatus: true,
      completedAt: true,
    },
  })
  const seen = new Set<number>()
  const out: LedgerStep[] = []
  for (const r of rows) {
    if (seen.has(r.ordinal)) continue
    seen.add(r.ordinal)
    out.push({
      ordinal: r.ordinal,
      kind: r.stepKind,
      status: r.status,
      idempotencyKey: r.idempotencyKey,
      result: r.result,
      observedPostState: r.observedPostState,
      rollbackStatus: r.rollbackStatus,
      completedAt: r.completedAt,
    })
  }
  return out
}
