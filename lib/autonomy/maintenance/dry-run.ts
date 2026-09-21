/**
 * DRY RUN — what would happen, computed without anything happening
 * ================================================================
 *
 * Answers, for one named plan, whether each rung WOULD execute right now and
 * where the ladder would stop. It writes nothing at all — not even a ledger
 * row — so it is safe to point at production before mutations are enabled
 * anywhere.
 *
 * ── Why it does not just call the executor with mutations off ───────────────
 *
 * That was the obvious implementation and it answers a narrower question. The
 * executor halts at the FIRST mutating step, so a run with mutations off
 * reports on rung one and says nothing about rungs two through six — which is
 * precisely the part an operator needs to see before enabling writes. It also
 * writes a ledger row, which is a side effect a dry run should not have.
 *
 * So the gates are evaluated here, per step, from the same functions the
 * executor uses: `classifyMaintenanceStep` for capability and tier,
 * `isTierAutoAllowed` for the dial, `approvalStillValid` for consent,
 * `isPlanStale` for the fingerprint. Not reimplemented — imported. If those
 * ever disagree with the executor it is because someone changed one of them,
 * and that is a fact worth failing over rather than a difference to paper over.
 *
 * ── It reports what it cannot see ───────────────────────────────────────────
 *
 * `uncontrollableReaders` is the string `unknown-standing-fact`, not a number.
 * PostgREST clients pick their own columns and direct-database connection
 * strings answer to nobody, so the count is unknown rather than zero — and a
 * report that printed `0` there would be the single most misleading number on
 * the page.
 */

import { isTierAutoAllowed, type AutonomyLevel } from '../autonomy-level'
import { approvalStillValid, isPlanStale, type MaintenancePlan } from './plan'
import { classifyMaintenanceStep, OPTIONAL_TERMINAL_STEPS } from './step'
import { computeCatalogFingerprint } from './resolve'
import { inventoryReaders } from './readers'
import type { StepBinding } from './execute'

export type DryRunVerdict =
  /** Every rung would run and the ladder would finish. */
  | 'WOULD_RUN_TO_COMPLETION'
  /** Every executable rung would run; it stops where a person takes over. */
  | 'WOULD_STOP_AWAITING_HUMAN_CONTRACT'
  /** A ladder-level gate fails; nothing would run at all. */
  | 'WOULD_REFUSE'
  /** A rung in the middle would not execute, so the ladder would halt there. */
  | 'WOULD_HALT_MID_LADDER'

export interface DryRunStep {
  ordinal: number
  kind: string
  /** 'executable' | 'human_only' | 'not_implemented' | … — the capability. */
  classification: string
  tier: number
  wouldExecute: boolean
  /** Why not, when it would not. Null when it would. */
  blockedBy: string | null
}

export interface DryRunReport {
  projectId: string
  planId: string
  planVersion: string
  catalogFingerprintMatches: boolean
  approvalValid: boolean
  mutationsEnvironmentEnabled: boolean
  planValidity: MaintenancePlan['validity']
  /**
   * What the planner concluded and what its instruments could see.
   *
   * A dry run that reports only a verdict makes every "why" question a new
   * deployment. The diagnosis is already part of the plan; printing it costs
   * nothing and is the first thing anyone reads after a refusal.
   */
  diagnosis: MaintenancePlan['diagnosis']
  steps: DryRunStep[]
  controllableReaders: number
  /** Never a number. See the header. */
  uncontrollableReaders: 'unknown-standing-fact'
  /** True only if a binding was supplied for every executable step. */
  bindingsComplete: boolean
  /** Ladder-level reasons nothing would run. Empty unless WOULD_REFUSE. */
  refusals: string[]
  verdict: DryRunVerdict
  /** Stated so nobody has to infer it from the absence of an id. */
  ledgerWritten: false
}

export interface DryRunInput {
  plan: MaintenancePlan
  projectId: string
  table: string
  sourceColumn: string
  /** TEST SEAM. Omit it: a dry run reads the catalog itself. See execute.ts. */
  currentCatalogFingerprint?: string
  autonomyLevel: AutonomyLevel
  approvedPlanVersion?: string | null
  mutationsEnvironmentEnabled: boolean
  bindings?: Record<number, StepBinding>
}

export async function dryRunPlan(input: DryRunInput): Promise<DryRunReport> {
  const { plan, projectId, autonomyLevel } = input

  const liveFingerprint =
    input.currentCatalogFingerprint ?? (await computeCatalogFingerprint(projectId))
  const catalogFingerprintMatches = !isPlanStale(plan, liveFingerprint)
  const approvalValid = input.approvedPlanVersion
    ? approvalStillValid(plan, input.approvedPlanVersion)
    : false

  const refusals: string[] = []
  // With the reasons. `blocked_by_capability` has always carried them and
  // `invalid` has not, so the one refusal an operator can do nothing about was
  // also the only one that would not say why — which is backwards, since an
  // invalid plan means the diagnosis or the ladder gate rejected it and that
  // is precisely what has to be read next.
  if (plan.validity === 'invalid') {
    refusals.push(
      plan.blockedReasons.length > 0
        ? `the plan is invalid and should not exist: ${plan.blockedReasons.join('; ')}`
        : 'the plan is invalid and should not exist',
    )
  }
  if (plan.validity === 'blocked_by_capability') {
    refusals.push(`the ladder is blocked by capability: ${plan.blockedReasons.join('; ')}`)
  }
  if (!catalogFingerprintMatches) {
    refusals.push(
      'the catalog moved since this plan was built, so its preconditions describe a schema that no longer exists ' +
        `(planned against ${plan.catalogFingerprint}, catalog is now ${liveFingerprint})`,
    )
  }

  const steps: DryRunStep[] = plan.steps.map(step => {
    const c = classifyMaintenanceStep(step)
    const human = OPTIONAL_TERMINAL_STEPS.includes(step.kind)

    // Evaluated in the order the executor applies them, so the FIRST reason is
    // the one an operator would actually hit.
    let blockedBy: string | null = null
    if (human) blockedBy = `${c.capability}: performed by a person`
    else if (!c.executable) blockedBy = `capability is ${c.capability}`
    else if (c.tier >= 3) blockedBy = 'tier 3 is never executed here'
    else if (c.tier >= 2 && !approvalValid) blockedBy = 'tier 2 requires an approval bound to this plan version'
    else if (c.tier < 2 && !isTierAutoAllowed(autonomyLevel, c.tier as 0 | 1)) {
      blockedBy = `the autonomy level ${autonomyLevel} does not permit tier ${c.tier}`
    } else if (step.kind !== 'verify' && !input.mutationsEnvironmentEnabled) {
      blockedBy = 'mutations are not enabled in this environment'
    } else if (input.bindings && !input.bindings[step.ordinal]) {
      blockedBy = 'no binding was supplied for this step'
    } else if (refusals.length > 0) {
      blockedBy = 'the ladder would be refused before this step'
    }

    return {
      ordinal: step.ordinal,
      kind: step.kind,
      classification: c.capability,
      tier: c.tier,
      wouldExecute: blockedBy === null,
      blockedBy,
    }
  })

  const inventory = await inventoryReaders(projectId, input.table, input.sourceColumn).catch(() => null)

  // Bindings are only required for steps that would actually run.
  const needBindings = plan.steps.filter(s => !OPTIONAL_TERMINAL_STEPS.includes(s.kind))
  const bindingsComplete = input.bindings
    ? needBindings.every(s => input.bindings![s.ordinal]?.kind === s.kind)
    : false

  const verdict: DryRunVerdict = (() => {
    if (refusals.length > 0) return 'WOULD_REFUSE'
    const executable = steps.filter(s => !OPTIONAL_TERMINAL_STEPS.includes(s.kind as never))
    if (!executable.every(s => s.wouldExecute)) return 'WOULD_HALT_MID_LADDER'
    return steps.some(s => OPTIONAL_TERMINAL_STEPS.includes(s.kind as never))
      ? 'WOULD_STOP_AWAITING_HUMAN_CONTRACT'
      : 'WOULD_RUN_TO_COMPLETION'
  })()

  return {
    projectId,
    planId: plan.planId,
    planVersion: plan.planVersion,
    catalogFingerprintMatches,
    approvalValid,
    mutationsEnvironmentEnabled: input.mutationsEnvironmentEnabled,
    planValidity: plan.validity,
    diagnosis: plan.diagnosis,
    steps,
    controllableReaders: inventory?.controllable.length ?? 0,
    uncontrollableReaders: 'unknown-standing-fact',
    bindingsComplete,
    refusals,
    verdict,
    ledgerWritten: false,
  }
}
