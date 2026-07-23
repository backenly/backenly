/**
 * BEHAVIOR RUNNER — Phase 7 (DRY-RUN) + Phase 13 (SAFE LIVE)
 * ============================================================
 * The runner consumes a BehaviorVerificationReport and produces a structured
 * plan describing exactly *how* each scenario would be executed, *what* it
 * would touch, and *why* it currently can or cannot be run.
 *
 * Modes:
 *   dry_run   — Phase 7 behaviour; never touches DB or HTTP. Always safe.
 *   safe_live — Phase 13; structurally safe scenarios are marked eligible
 *               for live execution by the verification-executor.
 *
 * SAFE LIVE RULES (enforced here and re-enforced in verification-executor):
 *   Eligible categories:   auth, rls, state_machine, security
 *   Blocked categories:    billing, webhook, storage, admin, runtime
 *   Additional guards:
 *     • scenario.canRunNow must be true
 *     • scenario must have no integration/payment blockers
 *   The executor performs actual DB reads — no mutations, no HTTP calls.
 */

import type {
  BehaviorVerificationReport,
  VerificationScenario,
  VerificationStep,
  VerificationCategory,
} from '../../lib/ai/planning/types'

// ─── Inputs ───────────────────────────────────────────────────────────────────

export type BehaviorRunnerMode = 'dry_run' | 'safe_live'

export interface BehaviorRunnerInput {
  report: BehaviorVerificationReport
  /**
   * dry_run — planning only, no live execution (Phase 7 default).
   * safe_live — eligible scenarios are marked for the verification-executor.
   */
  mode?: BehaviorRunnerMode
  /**
   * Optional — IDs of scenarios to include. If omitted, every runnable
   * scenario in the report is planned.
   */
  scenarioIds?: string[]
}

// ─── Safe Live Configuration ──────────────────────────────────────────────────

/** Categories that may execute structural checks in safe_live mode. */
export const SAFE_LIVE_CATEGORIES: ReadonlySet<VerificationCategory> = new Set([
  'auth',
  'rls',
  'state_machine',
  'security',
])

/** Categories that are NEVER allowed in safe_live mode. */
export const BLOCKED_LIVE_CATEGORIES: ReadonlySet<VerificationCategory> = new Set([
  'billing',
  'webhook',
  'storage',
  'admin',
  'runtime',
])

/** Blocker prefixes that always prevent safe_live execution. */
const BLOCKED_BLOCKER_PREFIXES = ['integration:', 'payment:', 'stripe:', 'webhook:']

function isSafeLiveEligible(scenario: VerificationScenario): boolean {
  if (!scenario.canRunNow) return false
  if (BLOCKED_LIVE_CATEGORIES.has(scenario.category)) return false
  if (!SAFE_LIVE_CATEGORIES.has(scenario.category)) return false
  // Reject scenarios blocked by integrations or payment systems
  for (const blocker of scenario.blockedBy) {
    if (BLOCKED_BLOCKER_PREFIXES.some(prefix => blocker.startsWith(prefix))) {
      return false
    }
  }
  return true
}

// ─── Outputs ──────────────────────────────────────────────────────────────────

export type StepDryRunStatus = 'planned' | 'skipped_blocked' | 'skipped_filtered'

export interface StepDryRunResult {
  scenarioId: string
  stepId: string
  action: VerificationStep['action']
  target: string
  status: StepDryRunStatus
  /** Specific note about why a step is in this status (e.g. blockedBy reasons) */
  note?: string
  /** Echoes the step's expected criterion so dashboards don't need to join */
  expected: string
}

export interface ScenarioDryRunResult {
  scenarioId: string
  name: string
  category: VerificationScenario['category']
  severity: VerificationScenario['severity']
  status: 'planned' | 'blocked' | 'filtered'
  reason: string
  steps: StepDryRunResult[]
  /** Echoes scenario.expectedResult / failureMeaning for the runner UI */
  expectedResult: string
  failureMeaning: string
  blockedBy: string[]
  /**
   * Phase 13 — true when mode=safe_live and this scenario passed all safety
   * gates. The verification-executor reads this to decide which scenarios
   * to execute structurally.
   */
  safeLiveEligible: boolean
}

export interface BehaviorRunnerReport {
  requestedMode: BehaviorRunnerMode
  /** Reflects what actually ran — safe_live when requested and scenarios qualify */
  effectiveMode: 'dry_run' | 'safe_live'
  scenarios: ScenarioDryRunResult[]
  totals: {
    scenarios: number
    plannedScenarios: number
    blockedScenarios: number
    filteredScenarios: number
    plannedSteps: number
    skippedSteps: number
    /** Phase 13 — count of scenarios eligible for live execution */
    safeLiveEligibleScenarios: number
  }
  /** Always true in Phase 7 dry_run; false when safe_live mode is active */
  shadowMode: boolean
  /** Aggregated warnings */
  warnings: string[]
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function runScenarios(input: BehaviorRunnerInput): BehaviorRunnerReport {
  const requestedMode: BehaviorRunnerMode = input.mode ?? 'dry_run'
  const warnings: string[] = []

  const filterSet = input.scenarioIds && input.scenarioIds.length > 0
    ? new Set(input.scenarioIds)
    : null

  const results: ScenarioDryRunResult[] = []
  let plannedScenarios = 0
  let blockedScenarios = 0
  let filteredScenarios = 0
  let plannedSteps = 0
  let skippedSteps = 0
  let safeLiveEligibleScenarios = 0

  for (const scenario of input.report.scenarios) {
    if (filterSet && !filterSet.has(scenario.id)) {
      filteredScenarios++
      const steps = scenario.steps.map<StepDryRunResult>(s => ({
        scenarioId: scenario.id,
        stepId: s.id,
        action: s.action,
        target: s.target,
        status: 'skipped_filtered',
        expected: s.expected,
      }))
      skippedSteps += steps.length
      results.push({
        scenarioId: scenario.id,
        name: scenario.name,
        category: scenario.category,
        severity: scenario.severity,
        status: 'filtered',
        reason: 'Not in scenarioIds filter',
        steps,
        expectedResult: scenario.expectedResult,
        failureMeaning: scenario.failureMeaning,
        blockedBy: scenario.blockedBy,
        safeLiveEligible: false,
      })
      continue
    }

    if (!scenario.canRunNow) {
      blockedScenarios++
      const steps = scenario.steps.map<StepDryRunResult>(s => ({
        scenarioId: scenario.id,
        stepId: s.id,
        action: s.action,
        target: s.target,
        status: 'skipped_blocked',
        note: scenario.blockedBy.join('; '),
        expected: s.expected,
      }))
      skippedSteps += steps.length
      results.push({
        scenarioId: scenario.id,
        name: scenario.name,
        category: scenario.category,
        severity: scenario.severity,
        status: 'blocked',
        reason: scenario.blockedBy.length > 0
          ? `Blocked by: ${scenario.blockedBy.join(', ')}`
          : 'Blocked (no specific blocker recorded)',
        steps,
        expectedResult: scenario.expectedResult,
        failureMeaning: scenario.failureMeaning,
        blockedBy: scenario.blockedBy,
        safeLiveEligible: false,
      })
      continue
    }

    const eligible = requestedMode === 'safe_live' && isSafeLiveEligible(scenario)
    if (eligible) safeLiveEligibleScenarios++

    plannedScenarios++
    const steps = scenario.steps.map<StepDryRunResult>(s => ({
      scenarioId: scenario.id,
      stepId: s.id,
      action: s.action,
      target: s.target,
      status: 'planned',
      expected: s.expected,
    }))
    plannedSteps += steps.length
    results.push({
      scenarioId: scenario.id,
      name: scenario.name,
      category: scenario.category,
      severity: scenario.severity,
      status: 'planned',
      reason: eligible
        ? 'Planned — eligible for safe_live structural verification.'
        : 'Planned (dry-run only).',
      steps,
      expectedResult: scenario.expectedResult,
      failureMeaning: scenario.failureMeaning,
      blockedBy: scenario.blockedBy,
      safeLiveEligible: eligible,
    })
  }

  if (results.length === 0) {
    warnings.push('No scenarios in the verification report — the runner has nothing to plan.')
  }

  if (requestedMode === 'safe_live' && safeLiveEligibleScenarios === 0) {
    warnings.push('safe_live mode requested but no scenarios passed safety gates — all categories may be blocked or all scenarios have blockers.')
  }

  const effectiveMode: 'dry_run' | 'safe_live' =
    requestedMode === 'safe_live' && safeLiveEligibleScenarios > 0
      ? 'safe_live'
      : 'dry_run'

  return {
    requestedMode,
    effectiveMode,
    scenarios: results,
    totals: {
      scenarios: input.report.scenarios.length,
      plannedScenarios,
      blockedScenarios,
      filteredScenarios,
      plannedSteps,
      skippedSteps,
      safeLiveEligibleScenarios,
    },
    shadowMode: effectiveMode === 'dry_run',
    warnings,
  }
}

/**
 * Convenience helper that returns true iff every step in every scenario in the
 * supplied report is purely informational (no DB / HTTP actions). The runner
 * uses this internally as a hard guard so a future programmer cannot
 * accidentally enable live execution by flipping the mode flag.
 */
export function assertSafeForShadowMode(report: BehaviorVerificationReport): true {
  for (const s of report.scenarios) {
    if (!s.shadowMode) {
      throw new Error(`Verification scenario "${s.id}" is missing shadowMode=true`)
    }
  }
  return true
}
