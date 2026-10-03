/**
 * OBSERVATION — did switching the readers make anything worse?
 * ============================================================
 *
 * Compares a window of real traffic before a reader switch against a window
 * after it, and answers whether the project regressed. `regressed` is the
 * revert trigger; everything else leaves the new readers in place.
 *
 * ── Zero traffic is not "fine" ──────────────────────────────────────────────
 *
 * The outcome that matters most here is `insufficient_sample`. A quiet project
 * produces a perfect error rate and a perfect latency profile, because nothing
 * happened. Reading that as "stable" would retain a switch that has never been
 * exercised, and would do it most confidently for exactly the projects where the
 * evidence is weakest.
 *
 * This is the same doctrine as the rest of the stack — a probe that did not run
 * is not a probe that found nothing — applied to traffic. It is also why the
 * user base being synthetic matters: on this platform most projects ARE quiet,
 * so `insufficient_sample` is the common case and not an edge case.
 *
 * ── Two signals, both of which a switch can plausibly break ─────────────────
 *
 *   errors   `ApiRequestLog.statusCode >= 400`, and `AiFunctionLog.success`
 *            false. A function reading a column that is not what it expects
 *            fails here first.
 *   latency  p95 of `ApiRequestLog.duration`. A switch that moved reads onto an
 *            unindexed column shows up here and nowhere else.
 *
 * Both are required to be non-worse. A switch that halves errors while tripling
 * p95 is a regression, and averaging the two into one score would hide it.
 */

import { prisma } from '@/lib/db'

/** Relative error-rate worsening that counts as a regression. */
export const ERROR_RATE_TOLERANCE = 0.02

/** Relative p95 worsening that counts as a regression. */
export const LATENCY_TOLERANCE = 0.25

/** Below this many requests in EITHER window, nothing is concluded. */
export const MIN_SAMPLE = 20

export type ObservationOutcome = 'improved' | 'neutral' | 'regressed' | 'insufficient_sample'

export interface TrafficWindow {
  requests: number
  errors: number
  errorRate: number
  p95DurationMs: number | null
  functionRuns: number
  functionFailures: number
}

export interface Observation {
  outcome: ObservationOutcome
  before: TrafficWindow
  after: TrafficWindow
  /** True only for `regressed`. The revert trigger, stated once. */
  shouldRevert: boolean
  reason: string
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  // Nearest-rank. With small samples an interpolating p95 invents a number
  // between two observations, and every value here is a real measurement.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

export async function measureWindow(
  projectId: string,
  from: Date,
  to: Date,
): Promise<TrafficWindow> {
  const requests = await prisma.apiRequestLog
    .findMany({
      // End-user traffic only; /api/ rows are the platform's AI rate limiter.
      where: { projectId, timestamp: { gte: from, lt: to }, NOT: { path: { startsWith: '/api/' } } },
      select: { statusCode: true, duration: true },
    })
    .catch(() => [] as Array<{ statusCode: number; duration: number }>)

  const fnRuns = await prisma.aiFunctionLog
    .findMany({
      where: { projectId, createdAt: { gte: from, lt: to } },
      select: { success: true },
    })
    .catch(() => [] as Array<{ success: boolean }>)

  const errors = requests.filter(r => r.statusCode >= 400).length
  return {
    requests: requests.length,
    errors,
    errorRate: requests.length === 0 ? 0 : errors / requests.length,
    p95DurationMs: percentile(requests.map(r => r.duration), 95),
    functionRuns: fnRuns.length,
    functionFailures: fnRuns.filter(r => !r.success).length,
  }
}

/**
 * Decide the outcome from two measured windows.
 *
 * Pure, so the thresholds are testable without a database and without waiting
 * for an observation window to elapse.
 */
export function judge(before: TrafficWindow, after: TrafficWindow): Observation {
  const base = { before, after }

  // Checked first, and on BOTH windows. A comparison needs two sides: plenty of
  // traffic after a switch proves nothing if there was none before it.
  if (before.requests < MIN_SAMPLE || after.requests < MIN_SAMPLE) {
    return {
      ...base,
      outcome: 'insufficient_sample',
      shouldRevert: false,
      reason:
        `${before.requests} request(s) before and ${after.requests} after, below the ${MIN_SAMPLE} ` +
        'needed to compare. Nothing was demonstrated either way.',
    }
  }

  const errorDelta = after.errorRate - before.errorRate
  const latencyRatio =
    before.p95DurationMs && after.p95DurationMs ? after.p95DurationMs / before.p95DurationMs : null

  // A function that started failing is a regression on its own, whatever the
  // request mix did: it is the most direct symptom of a reader reading the
  // wrong column.
  const functionsGotWorse =
    after.functionRuns > 0 &&
    before.functionRuns > 0 &&
    after.functionFailures / after.functionRuns > before.functionFailures / before.functionRuns

  if (errorDelta > ERROR_RATE_TOLERANCE) {
    return {
      ...base,
      outcome: 'regressed',
      shouldRevert: true,
      reason: `error rate rose from ${(before.errorRate * 100).toFixed(1)}% to ${(after.errorRate * 100).toFixed(1)}%`,
    }
  }
  if (latencyRatio !== null && latencyRatio > 1 + LATENCY_TOLERANCE) {
    return {
      ...base,
      outcome: 'regressed',
      shouldRevert: true,
      reason: `p95 rose from ${before.p95DurationMs}ms to ${after.p95DurationMs}ms`,
    }
  }
  if (functionsGotWorse) {
    return {
      ...base,
      outcome: 'regressed',
      shouldRevert: true,
      reason: `function failures rose from ${before.functionFailures}/${before.functionRuns} to ${after.functionFailures}/${after.functionRuns}`,
    }
  }

  if (errorDelta < -ERROR_RATE_TOLERANCE || (latencyRatio !== null && latencyRatio < 1 - LATENCY_TOLERANCE)) {
    return { ...base, outcome: 'improved', shouldRevert: false, reason: 'errors or latency measurably better' }
  }
  return { ...base, outcome: 'neutral', shouldRevert: false, reason: 'no measurable change in errors or latency' }
}

/**
 * Measure both windows around `switchedAt` and judge them.
 *
 * The windows are equal length and adjacent to the switch, so a daily traffic
 * cycle biases both sides the same way rather than one.
 */
export async function observeSwitch(
  projectId: string,
  switchedAt: Date,
  windowMs: number,
  now: Date = new Date(),
): Promise<Observation> {
  const before = await measureWindow(projectId, new Date(switchedAt.getTime() - windowMs), switchedAt)
  const after = await measureWindow(projectId, switchedAt, new Date(Math.min(switchedAt.getTime() + windowMs, now.getTime())))
  return judge(before, after)
}
