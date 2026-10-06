/**
 * BENEFIT — did the change actually make the backend better?
 * ==========================================================
 *
 * Verification proves a change WORKED: the data agrees, clients still work,
 * access is unchanged. That is necessary and it is not the claim an
 * architecture engine exists to make. This asks the second question, and
 * answers it only as far as the numbers allow:
 *
 *   beneficial             something the change was meant to improve improved
 *                          beyond noise, and nothing regressed
 *   neutral                comparable numbers exist and none moved enough to
 *                          matter either way
 *   regressed              a correctness check failed, or a number got worse
 *                          beyond noise
 *   insufficient_evidence  the numbers that would decide it are not available
 *                          or rest on too few samples. Said plainly, never
 *                          rounded up to "beneficial".
 *
 * ── Rules this file enforces ────────────────────────────────────────────────
 *
 * A measurement with a missing side is not a zero. A measurement with fewer
 * than MIN_SAMPLES on either side is reported and excluded from the verdict.
 * Thresholds are deliberately wide — a 10% gain or a 20% loss — because small
 * movements in request latency are mostly traffic mix, and an engine that calls
 * noise an improvement teaches its owner to stop reading its reports.
 *
 * Pure.
 */

import type { Measurement } from './primitive'

export type BenefitVerdict = 'beneficial' | 'neutral' | 'regressed' | 'insufficient_evidence'

/** Samples required on each side before a measurement can decide anything. */
export const MIN_SAMPLES = 200
/** Relative improvement that counts as real. */
export const IMPROVEMENT = 0.1
/** Relative regression that counts as real. */
export const REGRESSION = 0.2
/** For rates already in [0, 1]: an absolute move of half a percentage point. */
export const RATE_REGRESSION_ABS = 0.005

export interface Comparison {
  name: string
  scope: string
  direction: 'improved' | 'regressed' | 'unchanged' | 'not_comparable'
  /** before → after, formatted, or why it could not be compared. */
  text: string
  relativeChange: number | null
}

const fmt = (v: number, unit: string) =>
  unit === 'ms'
    ? `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}ms`
    : unit === 'ratio'
      ? `${Math.round(v * 1000) / 10}%`
      : `${Math.round(v * 100) / 100}${unit ? ` ${unit}` : ''}`

export function compare(m: Measurement): Comparison {
  const base = { name: m.name, scope: m.scope }
  if (m.before === null || m.after === null) {
    return {
      ...base,
      direction: 'not_comparable',
      text: `${m.name}: not measurable here${m.unavailableReason ? ` (${m.unavailableReason})` : ''}`,
      relativeChange: null,
    }
  }
  const thin = (n: number | null) => n !== null && n < MIN_SAMPLES
  if (thin(m.samplesBefore) || thin(m.samplesAfter)) {
    return {
      ...base,
      direction: 'not_comparable',
      text: `${m.name}: ${fmt(m.before, m.unit)} → ${fmt(m.after, m.unit)}, on too few samples to mean anything (${m.samplesBefore ?? '?'} before, ${m.samplesAfter ?? '?'} after)`,
      relativeChange: null,
    }
  }

  const isRate = m.unit === 'ratio'
  const delta = m.after - m.before
  const rel = m.before === 0 ? (m.after === 0 ? 0 : Infinity) : delta / Math.abs(m.before)
  const worse = m.better === 'lower' ? delta > 0 : delta < 0
  const better = m.better === 'lower' ? delta < 0 : delta > 0
  const pct = Number.isFinite(rel) ? `${rel > 0 ? '+' : ''}${Math.round(rel * 100)}%` : 'from zero'

  let direction: Comparison['direction'] = 'unchanged'
  if (isRate) {
    if (worse && Math.abs(delta) >= RATE_REGRESSION_ABS) direction = 'regressed'
    else if (better && Math.abs(delta) >= RATE_REGRESSION_ABS) direction = 'improved'
  } else if (worse && Math.abs(rel) >= REGRESSION) {
    direction = 'regressed'
  } else if (better && Math.abs(rel) >= IMPROVEMENT) {
    direction = 'improved'
  }

  return {
    ...base,
    direction,
    text: `${m.name}: ${fmt(m.before, m.unit)} → ${fmt(m.after, m.unit)} (${pct})`,
    relativeChange: Number.isFinite(rel) ? rel : null,
  }
}

export interface CorrectnessChecks {
  correctness: 'pass' | 'fail' | 'not_run'
  compatibility: 'pass' | 'fail' | 'not_run'
  authorization: 'pass' | 'fail' | 'not_run'
}

export interface BenefitReport {
  verdict: BenefitVerdict
  checks: CorrectnessChecks
  comparisons: Comparison[]
  /** One sentence for a person. */
  summary: string
}

export function assessBenefit(checks: CorrectnessChecks, measurements: Measurement[]): BenefitReport {
  const comparisons = measurements.map(compare)
  const failed = (Object.entries(checks) as Array<[keyof CorrectnessChecks, string]>).filter(([, v]) => v === 'fail').map(([k]) => k)
  if (failed.length > 0) {
    return { verdict: 'regressed', checks, comparisons, summary: `The change broke ${failed.join(' and ')}.` }
  }
  const comparable = comparisons.filter(c => c.direction !== 'not_comparable')
  const regressed = comparable.filter(c => c.direction === 'regressed')
  const improved = comparable.filter(c => c.direction === 'improved')

  if (regressed.length > 0) {
    return { verdict: 'regressed', checks, comparisons, summary: `It made things worse: ${regressed.map(c => c.text).join('; ')}.` }
  }
  if (comparable.length === 0) {
    return {
      verdict: 'insufficient_evidence',
      checks,
      comparisons,
      summary: 'It works correctly; there is not yet enough measured traffic to say whether it made things faster or slower.',
    }
  }
  if (improved.length > 0) {
    return { verdict: 'beneficial', checks, comparisons, summary: `It improved ${improved.map(c => c.text).join('; ')}.` }
  }
  return { verdict: 'neutral', checks, comparisons, summary: 'It works correctly and performance is unchanged within normal variation.' }
}
