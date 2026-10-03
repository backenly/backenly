/**
 * CONSENT — who authorised this ladder, for exactly which version of it
 * =====================================================================
 *
 * `maintenance_approvals` shipped with a reader and no writer. The sweep looked
 * for consent on every pass, found none because nothing in the product could
 * create it, and reported `awaiting_approval` forever. The documented
 * activation was "insert a row by hand", which is an operator ritual, not a
 * product: consent that only a psql session can express is consent the owner of
 * the backend cannot give.
 *
 * This module is the writer, and it is the ONLY one. Everything that grants,
 * withdraws or reads consent goes through here so the rules below hold on every
 * path — the dashboard, the API, an MCP agent, and the scheduler.
 *
 * ── Consent is for a version, not a plan ───────────────────────────────────
 *
 * `planVersion` hashes the ladder, the live catalog shape and the executor's
 * capability table. Approving version N is therefore not consent for N+1: the
 * schema moved, the ladder changed, or the executor learned a new verb. A
 * re-plan produces a new version and needs a new approval, and that property is
 * the whole reason unattended execution is safe.
 *
 * ── You cannot approve a version that does not exist ───────────────────────
 *
 * `grantMaintenanceApproval` rebuilds the plan from the live catalog and
 * refuses unless it hashes to the version being approved. Without that, a stale
 * browser tab — or an agent replaying an old tool call — could authorise a
 * ladder nobody has seen, and the sweep would honour it because the row says
 * so. The rebuild is the difference between consent and a row in a table.
 *
 * ── Bindings travel WITH consent ───────────────────────────────────────────
 *
 * They are the mapping from a plan's abstract parameters to real columns.
 * Approving "consolidate the lifecycle column" without saying which column is
 * not an approval anybody could give, so bindings are validated here against
 * the executor's own classifier and stored on the approval row. A scheduler
 * that derived them instead would be guessing which column to migrate.
 */

import { prisma } from '@/lib/db'
import {
  classifyMaintenanceStep,
  OPTIONAL_TERMINAL_STEPS,
  type MaintenanceStep,
} from './step'
import { resolveMaintenancePlan, isRefusal } from './resolve'
import type { MaintenancePlan } from './plan'
import type { StepBinding } from './execute'
import type { Transform } from './transform'

/** Phase 3 raises this. It is the only finding a maintenance ladder answers. */
export const STRUCTURAL_FINDING = 'subsystem_repeat_failure'

/**
 * The ceiling a human may consent to.
 *
 * Tier 3 is `contract` — dropping the old column — and is performed by a
 * person, never authorised for a robot. Clamping here rather than trusting the
 * caller means an API body of `{ maxTier: 3 }` cannot widen the band.
 */
export const MAX_APPROVABLE_TIER = 2

export interface LiveApproval {
  id: string
  planId: string
  planVersion: string
  maxTier: number
  bindings: Record<number, StepBinding>
  approvedBy: string
  reason: string | null
  createdAt: Date
}

/** What a step needs a human to say before it can run. */
export interface BindingRequest {
  ordinal: number
  kind: MaintenanceStep['kind']
  tier: number
  executable: boolean
  /** Null for a step the executor cannot undo — which is why it is human-only. */
  rollback: string | null
  params: Record<string, unknown>
}

export interface PendingLadder {
  projectId: string
  findingId: string
  planId: string
  planVersion: string
  catalogFingerprint: string
  table: string
  diagnosis: MaintenancePlan['diagnosis']
  subsystem: MaintenancePlan['subsystem']
  validity: MaintenancePlan['validity']
  blockedReasons: string[]
  /** Steps a human must bind before the ladder can run, in execution order. */
  needsBinding: BindingRequest[]
  /** Steps the executor will never run, named so the owner knows what is left over. */
  humanOnly: BindingRequest[]
  /** The consent on file for THIS version, if any. */
  approval: LiveApproval | null
  /** Consent on file for a different version — the fix is re-approving. */
  staleApproval: { id: string; planVersion: string; createdAt: Date } | null
}

export type PendingLadderResult = PendingLadder | { refusal: string }

export const isLadderRefusal = (
  r: PendingLadderResult,
): r is { refusal: string } => (r as { refusal: string }).refusal !== undefined

function describeStep(step: MaintenanceStep): BindingRequest {
  const c = classifyMaintenanceStep(step)
  return {
    ordinal: step.ordinal,
    kind: step.kind,
    tier: c.tier,
    executable: c.executable,
    rollback: step.rollbackSpec ? step.rollbackSpec.strategy : null,
    params: step.params,
  }
}

function coerceApproval(row: {
  id: string
  planId: string
  planVersion: string
  maxTier: number
  bindings: unknown
  approvedBy: string
  reason: string | null
  createdAt: Date
}): LiveApproval {
  return {
    ...row,
    bindings: (row.bindings ?? {}) as Record<number, StepBinding>,
  }
}

/**
 * The live, unrevoked consent for one plan.
 *
 * The single read. The sweep uses it to decide eligibility and the executor
 * re-reads it immediately before each mutation, so a withdrawal made while a
 * tick was in flight stops the ladder rather than being noticed next pass.
 */
export async function readLiveApproval(planId: string): Promise<LiveApproval | null> {
  const row = await prisma.maintenanceApproval.findFirst({
    where: { planId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      planId: true,
      planVersion: true,
      maxTier: true,
      bindings: true,
      approvedBy: true,
      reason: true,
      createdAt: true,
    },
  })
  return row ? coerceApproval(row) : null
}

/**
 * Describe the ladder currently awaiting a decision on this project.
 *
 * Read-only, and the same rebuild the sweep performs — so what an owner is
 * shown is what the scheduler would run, not a cached description of it.
 */
export async function describePendingLadder(input: {
  projectId: string
}): Promise<PendingLadderResult> {
  const { projectId } = input

  const finding = await prisma.healthFinding.findFirst({
    // The same population the sweep plans from (see sweep.ts), so what an owner
    // is shown is what the scheduler would run.
    where: { projectId, type: STRUCTURAL_FINDING, status: { in: ['open', 'pending_approval'] } },
    select: { id: true },
    orderBy: { detectedAt: 'asc' },
  })
  if (!finding) return { refusal: 'no structural finding is open on this project' }

  const resolved = await resolveMaintenancePlan({ projectId, findingId: finding.id })
  if (isRefusal(resolved)) return { refusal: resolved.refusal }

  const { plan, catalogFingerprint, table } = resolved

  const required = plan.steps.filter(s => !OPTIONAL_TERMINAL_STEPS.includes(s.kind))
  const humanOnly = plan.steps.filter(s => OPTIONAL_TERMINAL_STEPS.includes(s.kind))

  const live = await readLiveApproval(plan.planId)
  const matches = live?.planVersion === plan.planVersion

  return {
    projectId,
    findingId: finding.id,
    planId: plan.planId,
    planVersion: plan.planVersion,
    catalogFingerprint,
    table,
    diagnosis: plan.diagnosis,
    subsystem: plan.subsystem,
    validity: plan.validity,
    blockedReasons: plan.blockedReasons,
    needsBinding: required.map(describeStep),
    humanOnly: humanOnly.map(describeStep),
    approval: matches ? live : null,
    staleApproval:
      live && !matches
        ? { id: live.id, planVersion: live.planVersion, createdAt: live.createdAt }
        : null,
  }
}

/**
 * What a person actually has to say to authorise a ladder.
 *
 * The planner emits abstract params on purpose — `{ tableName, purpose:
 * 'consolidated lifecycle column' }` and never a column name — so every rung
 * needs a binding before it can run. But a ladder operates on ONE table and one
 * column pair throughout, so asking for a separate binding per rung would be
 * asking the same question six times and inviting six chances to answer it
 * inconsistently.
 *
 * So the human answers once, here, and `composeBindings` fans the answer out
 * across the rungs. That keeps a single authority on what a binding means:
 * the dashboard does not build binding objects and post them, it posts the
 * answers and the server composes. An agent or a script may still post raw
 * bindings, which is the lower-level door onto the same validation.
 */
export interface LadderAnswers {
  /** The existing column whose values are being consolidated. */
  sourceColumn: string
  /** The column being introduced to replace it. */
  targetColumn: string
  /** Postgres type for the new column. */
  targetType: string
  /** How a source value becomes a target value. */
  transform: Transform
  /**
   * The domain the target is constrained to, as the approver states it.
   *
   * Checked against the domain derived from the source's own CHECK under the
   * transform, and a disagreement refuses. Neither route is trusted alone.
   */
  allowedValues?: string[]
  batchRows?: number
}

/**
 * Fan one answer out across the rungs that need a binding.
 *
 * Every step kind in the union gets the shape it declares. A kind this does not
 * know about produces no binding, which the grant path then refuses by name
 * rather than silently approving a ladder with a rung nobody described.
 */
export function composeBindings(
  steps: BindingRequest[],
  table: string,
  a: LadderAnswers,
): Record<number, StepBinding> {
  const out: Record<number, StepBinding> = {}
  const pair = {
    table,
    sourceColumn: a.sourceColumn,
    targetColumn: a.targetColumn,
    transform: a.transform,
  }
  for (const step of steps) {
    switch (step.kind) {
      case 'add_structure':
        out[step.ordinal] = {
          kind: 'add_structure',
          verb: 'ADD_COLUMN',
          table,
          column: a.targetColumn,
          columnType: a.targetType,
        }
        break
      case 'carry_constraints':
        out[step.ordinal] = {
          kind: 'carry_constraints',
          ...pair,
          allowedValues: a.allowedValues ?? [],
        }
        break
      case 'dual_write':
        out[step.ordinal] = { kind: 'dual_write', ...pair }
        break
      case 'backfill':
        out[step.ordinal] = {
          kind: 'backfill',
          ...pair,
          ...(a.batchRows ? { batchRows: a.batchRows } : {}),
        }
        break
      case 'verify':
        out[step.ordinal] = { kind: 'verify', ...pair }
        break
      case 'switch_readers':
        out[step.ordinal] = {
          kind: 'switch_readers',
          table,
          sourceColumn: a.sourceColumn,
          targetColumn: a.targetColumn,
        }
        break
      default:
        // `contract` and anything new. Deliberately unbound: contract is
        // human-only and never reaches the executor, and an unrecognised kind
        // must surface as "no binding describes what it operates on" rather
        // than be quietly skipped.
        break
    }
  }
  return out
}

export interface GrantInput {
  projectId: string
  /** The version the approver believes they are consenting to. */
  planVersion: string
  approvedBy: string
  /**
   * Raw, per-ordinal. Supply this OR `answers`, not both — `answers` wins,
   * because it is the higher-level statement of the same thing.
   */
  bindings?: Record<number, StepBinding>
  /** What the approver said, fanned out server-side by `composeBindings`. */
  answers?: LadderAnswers
  maxTier?: number
  reason?: string | null
}

export type GrantRefusal = { ok: false; refusal: string; currentPlanVersion?: string }
export type GrantResult =
  | { ok: true; approval: LiveApproval; planId: string; planVersion: string }
  | GrantRefusal

/**
 * Narrowing helper, not decoration.
 *
 * `tsconfig` has `strict: false`, so `strictNullChecks` is off and TypeScript
 * will not narrow a union on a boolean discriminant — `if (!result.ok)` leaves
 * `result` as the whole union and every field access on the refusal branch is
 * an error. An explicit predicate is how the rest of this module's callers
 * already discriminate (`isRefusal`, `isLadderRefusal`).
 */
export const isGrantRefusal = (r: GrantResult): r is GrantRefusal => !r.ok

/**
 * Record a human's consent to run one ladder, at one version.
 *
 * Refuses rather than throws: every rejection here is an answer the caller has
 * to render — the plan moved, a binding is missing, a step is bound to the
 * wrong kind — and none of them is an exceptional condition.
 */
export async function grantMaintenanceApproval(input: GrantInput): Promise<GrantResult> {
  const { projectId, planVersion, approvedBy } = input

  if (!approvedBy.trim()) return { ok: false, refusal: 'an approval must name who gave it' }

  const pending = await describePendingLadder({ projectId })
  if (isLadderRefusal(pending)) return { ok: false, refusal: pending.refusal }

  // Composed from the answers when given, so the dashboard and an agent
  // posting raw bindings land on exactly the same validation below.
  const bindings = input.answers
    ? composeBindings(pending.needsBinding, pending.table, input.answers)
    : (input.bindings ?? {})

  // The plan is rebuilt from the live catalog above. If it no longer hashes to
  // the version being approved, the approver is looking at a stale screen and
  // consenting to a ladder that no longer exists.
  if (pending.planVersion !== planVersion) {
    return {
      ok: false,
      refusal:
        `this project's ladder is now version ${pending.planVersion}, not ${planVersion}. ` +
        'The ladder, the catalog or the executor moved since that plan was shown, so it needs re-reading before it can be approved.',
      currentPlanVersion: pending.planVersion,
    }
  }

  if (pending.validity !== 'executable') {
    return {
      ok: false,
      refusal: `the plan is ${pending.validity} and cannot be approved: ${pending.blockedReasons.join('; ')}`,
    }
  }

  // Every rung the executor will actually run needs a binding, and it needs one
  // of its own kind. Checked here so a malformed approval is refused at the
  // point a person made it, rather than halting a ladder at 03:00.
  for (const step of pending.needsBinding) {
    const binding = bindings[step.ordinal]
    if (!binding) {
      return {
        ok: false,
        refusal: `step ${step.ordinal} (${step.kind}) has no binding describing what it operates on`,
      }
    }
    if (binding.kind !== step.kind) {
      return {
        ok: false,
        refusal: `step ${step.ordinal} is ${step.kind} but its binding describes a ${binding.kind}`,
      }
    }
  }

  // Clamped, never trusted. Tier 3 is human-only at every level and no request
  // body may widen that.
  const requested = Number.isFinite(input.maxTier) ? Number(input.maxTier) : MAX_APPROVABLE_TIER
  const maxTier = Math.max(0, Math.min(MAX_APPROVABLE_TIER, requested))

  const highest = Math.max(0, ...pending.needsBinding.map(s => s.tier))
  if (highest > maxTier) {
    return {
      ok: false,
      refusal:
        `this ladder needs tier ${highest} and the approval only covers up to tier ${maxTier}. ` +
        'A ladder is all-or-nothing, so partial consent would halt it half-expanded.',
    }
  }

  // One consent per version. Re-approving the same version is the same consent,
  // not a stronger one, so this is an upsert on (planId, planVersion) rather
  // than a second row that would make "who approved this" ambiguous.
  const row = await prisma.maintenanceApproval.upsert({
    where: { planId_planVersion: { planId: pending.planId, planVersion } },
    create: {
      projectId,
      findingId: pending.findingId,
      planId: pending.planId,
      planVersion,
      maxTier,
      approvedBy,
      reason: input.reason ?? null,
      bindings: bindings as object,
    },
    update: {
      maxTier,
      approvedBy,
      reason: input.reason ?? null,
      bindings: bindings as object,
      // Re-approving withdraws a prior revocation of the same version, which is
      // what "approve" means when the row already exists.
      revokedAt: null,
      revokedBy: null,
    },
    select: {
      id: true,
      planId: true,
      planVersion: true,
      maxTier: true,
      bindings: true,
      approvedBy: true,
      reason: true,
      createdAt: true,
    },
  })

  return { ok: true, approval: coerceApproval(row), planId: pending.planId, planVersion }
}

export type RevokeRefusal = { ok: false; refusal: string }
export type RevokeResult = { ok: true; id: string } | RevokeRefusal

export const isRevokeRefusal = (r: RevokeResult): r is RevokeRefusal => !r.ok

/**
 * Withdraw consent.
 *
 * Takes effect at the next gate the executor passes, including mid-ladder: the
 * executor re-reads consent before each mutation, so a withdrawal stops the
 * rung that has not started rather than only the ladder that has not begun.
 */
export async function revokeMaintenanceApproval(input: {
  projectId: string
  approvalId: string
  revokedBy: string
}): Promise<RevokeResult> {
  const { projectId, approvalId, revokedBy } = input

  const existing = await prisma.maintenanceApproval.findUnique({
    where: { id: approvalId },
    select: { id: true, projectId: true, revokedAt: true },
  })
  if (!existing) return { ok: false, refusal: 'no such approval' }
  // Scoped to the project the caller was validated against, so an approval id
  // learned elsewhere cannot be revoked across a tenancy boundary.
  if (existing.projectId !== projectId) return { ok: false, refusal: 'no such approval' }
  if (existing.revokedAt) return { ok: true, id: existing.id }

  await prisma.maintenanceApproval.update({
    where: { id: approvalId },
    data: { revokedAt: new Date(), revokedBy },
  })
  return { ok: true, id: approvalId }
}
