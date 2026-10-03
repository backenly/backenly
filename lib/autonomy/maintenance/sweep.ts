/**
 * THE MAINTENANCE SWEEP — what runs a plan when nobody typed the command
 * ======================================================================
 *
 * Every gate in this system was built and proven against an operator running
 * one named plan by hand. This is the same path with the operator removed, and
 * it removes the operator ONLY from the typing. Not one refusal is relaxed:
 * the plan is rebuilt from the live catalog, the version must match what was
 * approved, Tier 2 still needs a human's consent, `contract` is still performed
 * by a person, and mutations still obey the deployment flag.
 *
 * ── It does not start what it cannot finish ────────────────────────────────
 *
 * The important difference from the manual path. Run by hand, a ladder that
 * halts at an unapproved Tier-2 rung is fine: the operator is standing there,
 * sees the halt, and decides. Unattended, that same halt leaves a table with a
 * new column nothing fills and a dual-write that was never installed — the
 * half-migrated schema `executablePrefix` exists to warn about, created by the
 * scheduler itself and left until somebody notices.
 *
 * So eligibility is decided for the WHOLE ladder before anything runs. If any
 * rung would be blocked by a missing approval or a dial that does not permit
 * it, the plan is reported as awaiting approval and nothing is executed. The
 * `contract` rung is the one exception, because it is the one step whose
 * absence leaves the ladder complete rather than half-done.
 *
 * ── Where the estate lives ─────────────────────────────────────────────────
 *
 * Here: one project, named by the caller. WHICH projects get swept is an
 * edition question answered by the fleet scheduler behind `@/lib/edition`,
 * exactly as `/api/cron/autonomy` already does for the reconciler. This file is
 * public product and behaves identically in both editions.
 *
 * ── One finding per project per pass ───────────────────────────────────────
 *
 * Deliberate. A ladder mutates the schema, which changes the catalog
 * fingerprint, which invalidates every other plan built against the old one. A
 * pass that ran two would be acting on a stale plan for the second, so the
 * second waits for the next pass and is re-planned against what the first left.
 */

import { prisma } from '@/lib/db'
import { FLAGS } from '@/lib/config/flags'
import { getProjectAutonomyLevel, isTierAutoAllowed } from '../autonomy-level'
import { executeMaintenancePlan, type StepBinding } from './execute'
import { resolveMaintenancePlan, isRefusal } from './resolve'
import { classifyMaintenanceStep, OPTIONAL_TERMINAL_STEPS } from './step'
import { readLiveApproval, type LiveApproval } from './approval'
import type { MaintenancePlan } from './plan'

/** Phase 3 raises this. It is the only finding a maintenance ladder answers. */
const STRUCTURAL_FINDING = 'subsystem_repeat_failure'

export type SweepDisposition =
  /** Rebuilt, valid, approved, and executed. */
  | 'executed'
  /** Rebuilt and valid, but a rung needs consent nobody has given. */
  | 'awaiting_approval'
  /** The approval on file is for a different version of this plan. */
  | 'approval_stale'
  /** The plan will not build, or is not executable. Reported, never forced. */
  | 'not_planable'
  /**
   * The ladder is sound and THIS DEPLOYMENT cannot safely undo it.
   *
   * Separated from `awaiting_approval` on purpose, and from `not_planable`
   * too. "Waiting on you" is a claim that a human's consent is the missing
   * prerequisite; here the missing prerequisite is an executor Backenly has
   * not built, and no approval creates one. Rendering this as an approval task
   * would put work in a person's queue that they cannot discharge, and would
   * make the trust surface count a platform gap as user-held.
   */
  | 'unsupported_recovery'
  /** Nothing to do. */
  | 'no_finding'
  /** The sweep itself is off, or mutations are. */
  | 'disabled'
  /**
   * Another instance is already running this project's ladder.
   *
   * Not a failure and not a refusal: the ladder is being run, just not here.
   * Named distinctly so a fleet log cannot read cross-instance contention as
   * a project with nothing to do.
   */
  | 'in_flight_elsewhere'

export interface SweepResult {
  projectId: string
  disposition: SweepDisposition
  findingId?: string
  planId?: string
  planVersion?: string
  /** Why, in the operator's words. Always set for a disposition that did not run. */
  reason?: string
  executionStatus?: string
  haltReason?: string | null
}

/**
 * Could every rung of this ladder run right now?
 *
 * Applied to the whole plan before any of it executes, in the executor's own
 * order, using the executor's own classifier — so the answer cannot drift from
 * what the executor would decide rung by rung.
 */
function firstUnrunnableRung(
  plan: MaintenancePlan,
  autonomyLevel: Parameters<typeof isTierAutoAllowed>[0],
  approval: LiveApproval | null,
  bindings: Record<number, StepBinding>,
): string | null {
  const approvalValid = approval !== null
  // The single exception. `contract` is performed by a person and its absence
  // leaves the ladder complete, so it never makes the rest unrunnable.
  const required = plan.steps.filter(s => !OPTIONAL_TERMINAL_STEPS.includes(s.kind))

  // Permission first, across the whole ladder, THEN bindings. Bindings arrive
  // with the approval, so an unapproved plan has none — and reporting "no
  // binding" there would name a consequence while the cause is that nobody has
  // approved it. Ordering the passes keeps the reason the one an operator acts
  // on.
  for (const step of required) {
    const c = classifyMaintenanceStep(step)
    if (!c.executable) return `${step.kind}: the executor cannot run it (${c.capability})`
    if (c.tier >= 3) return `${step.kind}: tier 3 is never executed here`
    if (c.tier >= 2 && !approvalValid) {
      return `${step.kind}: tier ${c.tier} needs an approval bound to this plan version`
    }
    // `maxTier` was stored on every approval and read by nothing, so consent
    // recorded as "up to tier 1" authorised tier 2 anyway. An approval that
    // does not reach this rung is not consent for it.
    if (c.tier >= 2 && approval && c.tier > approval.maxTier) {
      return `${step.kind}: tier ${c.tier} exceeds the approval's ceiling of tier ${approval.maxTier}`
    }
    if (c.tier < 2 && !isTierAutoAllowed(autonomyLevel, c.tier as 0 | 1)) {
      return `${step.kind}: the autonomy level ${autonomyLevel} does not permit tier ${c.tier}`
    }
  }
  for (const step of required) {
    if (!bindings[step.ordinal]) return `${step.kind}: no binding describes what it operates on`
  }
  return null
}

/**
 * Sweep one project.
 *
 * Bindings are read from the approval, not derived here and not passed in.
 * They are the operator's mapping from a plan's abstract params to real
 * columns, and they travel WITH consent because they are part of what was
 * consented to: approving "consolidate the lifecycle column" without saying
 * which column is not an approval anybody could give. Deriving them instead
 * would make this a scheduler that guesses which column to migrate.
 */
export async function sweepProjectMaintenance(input: {
  projectId: string
}): Promise<SweepResult> {
  const { projectId } = input

  if (!FLAGS.ENABLE_MAINTENANCE_SCHEDULER) {
    return { projectId, disposition: 'disabled', reason: 'ENABLE_MAINTENANCE_SCHEDULER is off' }
  }
  if (!FLAGS.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS) {
    return {
      projectId,
      disposition: 'disabled',
      reason: 'ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS is off in this deployment',
    }
  }

  // Oldest first: the finding that has been recurring longest is the one whose
  // subsystem has been failing longest.
  const finding = await prisma.healthFinding.findFirst({
    // `open` or `pending_approval`: still unresolved. The observer writes this
    // finding as pending_approval (it has no inline fix), and reading `open`
    // alone meant the sweep never once found a real one. Waiting for a person
    // is not a hole: nothing below runs without an approval bound to this exact
    // plan version. Fixed and dismissed stay out, because re-planning from a
    // dismissed finding would override a decision a person already made.
    where: { projectId, type: STRUCTURAL_FINDING, status: { in: ['open', 'pending_approval'] } },
    select: { id: true },
    orderBy: { detectedAt: 'asc' },
  })
  if (!finding) return { projectId, disposition: 'no_finding' }

  // REBUILT, every pass, from the catalog as it is now. A plan is a claim about
  // a schema and this is how the claim expires.
  const resolved = await resolveMaintenancePlan({ projectId, findingId: finding.id })
  if (isRefusal(resolved)) {
    return { projectId, disposition: 'not_planable', findingId: finding.id, reason: resolved.refusal }
  }

  const { plan } = resolved
  const base = { projectId, findingId: finding.id, planId: plan.planId, planVersion: plan.planVersion }

  if (plan.validity !== 'executable') {
    return {
      ...base,
      // A capability gap is its own answer. `not_planable` means the planner
      // could not produce a sound ladder; this means it did, and the platform
      // cannot guarantee the recovery the ladder's own safety contract
      // promises.
      disposition:
        plan.validity === 'blocked_by_capability' ? 'unsupported_recovery' : 'not_planable',
      reason: `plan is ${plan.validity}: ${plan.blockedReasons.join('; ')}`,
    }
  }

  // Consent, looked up by the version it was given for. An approval for an
  // earlier version of this plan is not consent for this one, and says so
  // rather than being silently absent.
  const approval = await readLiveApproval(plan.planId)
  const approvalValid = approval?.planVersion === plan.planVersion
  const validApproval = approvalValid ? approval : null

  // From the approval, and only when the approval is for THIS version. Reading
  // bindings off a stale consent would apply an old mapping to a new ladder.
  const bindings: Record<number, StepBinding> = validApproval?.bindings ?? {}

  const autonomyLevel = await getProjectAutonomyLevel(projectId)
  const blocked = firstUnrunnableRung(plan, autonomyLevel, validApproval, bindings)
  if (blocked) {
    // An approval exists but names another version: a distinct answer, because
    // the fix is re-approving rather than approving.
    if (approval && !approvalValid) {
      return {
        ...base,
        disposition: 'approval_stale',
        reason:
          `approved version is ${approval.planVersion}, the plan rebuilt to ${plan.planVersion}. ` +
          'The ladder, the catalog or the executor moved, so the old consent does not carry over.',
      }
    }
    return { ...base, disposition: 'awaiting_approval', reason: blocked }
  }

  const outcome = await executeMaintenancePlan({
    plan,
    projectId,
    // Deliberately NOT passed. `catalogFingerprint` here is the one the plan
    // was built from, so handing it back made `isPlanStale` compare a value to
    // itself. The executor reads the catalog again for itself.
    autonomyLevel,
    bindings,
    approvedPlanVersion: approval?.planVersion ?? null,
    approvalId: approval?.id ?? null,
    // ANDs with the deployment flag, checked at the top. Nothing here widens it.
    mutationsEnabled: true,
  })

  return {
    ...base,
    // The executor holds the per-project lock, so it is the one that discovers
    // contention. Surfaced as its own disposition rather than folded into
    // `executed`, because nothing ran and a fleet tally that said otherwise
    // would overcount the work this pass did.
    disposition: outcome.status === 'in_flight_elsewhere' ? 'in_flight_elsewhere' : 'executed',
    executionStatus: outcome.status,
    haltReason: outcome.haltReason ?? null,
  }
}
