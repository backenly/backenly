/**
 * PHASE 8 — did the repair actually help?
 * =======================================
 *
 * Measures a subsystem before and after a maintenance execution and says
 * whether things got better. Three signals, each one a count of something that
 * really happened:
 *
 *   incidents   HealthFinding rows for the project. The symptom.
 *   repairs     MaintenanceExecution rows. Repairing the same thing repeatedly
 *               is itself a finding — a fix that keeps being needed did not fix.
 *   latency     p95 request duration, from ./observe.ts.
 *
 * ── The hard boundary on what this is allowed to change ────────────────────
 *
 * Learning here may adjust **remedy ranking and priors only**. It may never
 * touch:
 *
 *   detection truth        a detector that fires still fires. An outcome
 *                          measurement is not evidence about whether a problem
 *                          exists, only about whether a remedy helped.
 *   approval requirements  consent is not earned by a good track record.
 *   safety tiers           blast radius is a property of the action.
 *
 * That boundary is not advice; `RemedyAdjustment` is the entire output type and
 * it cannot express anything else. The reason it is drawn so hard: a system that
 * learns "this detector is usually a false alarm" stops detecting, and the
 * failure is invisible because the symptom is silence. `fix-acceptance.ts`
 * records the case where every signal was green for months while the schema was
 * wrong.
 *
 * ── insufficient_sample is the honest default ───────────────────────────────
 *
 * The user base is synthetic and most projects are quiet. A subsystem with two
 * incidents before and one after has not demonstrated an improvement, and
 * reporting one would be reading noise. The threshold is deliberately high
 * enough that most measurements return `insufficient_sample`, which is the
 * correct answer for most of them.
 */

import { prisma } from '@/lib/db'
import type { ObservationOutcome, TrafficWindow } from './observe'
import { measureWindow } from './observe'

/** Incidents needed in the BEFORE window before any comparison is attempted. */
export const MIN_INCIDENTS = 3

/** Relative change that counts as more than noise. */
export const MATERIAL_CHANGE = 0.3

/** How far a prior may move on one measurement. */
export const MAX_PRIOR_STEP = 0.05

/** Absolute bounds a prior can never leave, however many measurements agree. */
export const PRIOR_FLOOR = 0.05
export const PRIOR_CEILING = 0.95

export interface SubsystemWindow {
  incidents: number
  repairs: number
  traffic: TrafficWindow
}

export interface OutcomeMeasurement {
  outcome: ObservationOutcome
  before: SubsystemWindow
  after: SubsystemWindow
  reason: string
}

/**
 * The only thing an outcome is allowed to influence.
 *
 * A number and a reason. No detector id, no tier, no approval field — there is
 * nowhere in this type to put them.
 */
export interface RemedyAdjustment {
  hypothesisId: string
  /** Signed, bounded, and applied to the remedy's prior. Never to a threshold. */
  priorDelta: number
  reason: string
}

export async function measureSubsystemWindow(
  projectId: string,
  from: Date,
  to: Date,
): Promise<SubsystemWindow> {
  const incidents = await prisma.healthFinding
    .count({ where: { projectId, detectedAt: { gte: from, lt: to } } })
    .catch(() => 0)

  const repairs = await prisma.maintenanceExecution
    .count({ where: { projectId, createdAt: { gte: from, lt: to } } })
    .catch(() => 0)

  return { incidents, repairs, traffic: await measureWindow(projectId, from, to) }
}

/**
 * Compare two measured windows.
 *
 * Pure, so the thresholds are testable without waiting for a window to elapse.
 */
export function judgeOutcome(before: SubsystemWindow, after: SubsystemWindow): OutcomeMeasurement {
  const base = { before, after }

  if (before.incidents < MIN_INCIDENTS) {
    return {
      ...base,
      outcome: 'insufficient_sample',
      reason:
        `${before.incidents} incident(s) before the repair, below the ${MIN_INCIDENTS} needed to ` +
        'tell an improvement from a quiet week',
    }
  }

  const delta = (after.incidents - before.incidents) / before.incidents
  // A repair that keeps being needed did not repair. Counted separately so a
  // subsystem whose incidents fell while its repairs rose is not called
  // improved — that pattern is maintenance masking a problem, not fixing it.
  const repairsRose = after.repairs > before.repairs

  if (delta <= -MATERIAL_CHANGE && !repairsRose) {
    return {
      ...base,
      outcome: 'improved',
      reason: `incidents fell from ${before.incidents} to ${after.incidents}`,
    }
  }
  if (delta >= MATERIAL_CHANGE) {
    return {
      ...base,
      outcome: 'regressed',
      reason: `incidents rose from ${before.incidents} to ${after.incidents}`,
    }
  }
  if (repairsRose && delta > -MATERIAL_CHANGE) {
    return {
      ...base,
      outcome: 'regressed',
      reason:
        `repairs rose from ${before.repairs} to ${after.repairs} without incidents falling — ` +
        'the remedy is being re-applied rather than working',
    }
  }
  return { ...base, outcome: 'neutral', reason: 'no material change in incidents' }
}

/**
 * Turn an outcome into a bounded nudge, or into nothing.
 *
 * `insufficient_sample` and `neutral` both produce no adjustment. That is the
 * point of measuring: most measurements should change nothing, and a learner
 * that always moves something is fitting noise.
 */
export function remedyAdjustment(
  hypothesisId: string,
  measurement: OutcomeMeasurement,
): RemedyAdjustment | null {
  if (measurement.outcome === 'improved') {
    return { hypothesisId, priorDelta: MAX_PRIOR_STEP, reason: measurement.reason }
  }
  if (measurement.outcome === 'regressed') {
    return { hypothesisId, priorDelta: -MAX_PRIOR_STEP, reason: measurement.reason }
  }
  return null
}

/**
 * Apply an adjustment to a prior, clamped.
 *
 * The clamp is what stops a long run of agreeing measurements from driving a
 * remedy's prior to 0 or 1. A prior of 0 is a remedy that is never proposed
 * again, which is a detection decision reached by the back door — exactly what
 * the boundary above forbids.
 */
export function applyAdjustment(prior: number, adjustment: RemedyAdjustment | null): number {
  if (!adjustment) return prior
  const next = prior + adjustment.priorDelta
  return Math.min(PRIOR_CEILING, Math.max(PRIOR_FLOOR, next))
}

/** Measure the equal windows either side of a repair, and judge them. */
export async function measureRepairOutcome(
  projectId: string,
  repairedAt: Date,
  windowMs: number,
  now: Date = new Date(),
): Promise<OutcomeMeasurement> {
  const before = await measureSubsystemWindow(projectId, new Date(repairedAt.getTime() - windowMs), repairedAt)
  const after = await measureSubsystemWindow(
    projectId,
    repairedAt,
    new Date(Math.min(repairedAt.getTime() + windowMs, now.getTime())),
  )
  return judgeOutcome(before, after)
}
