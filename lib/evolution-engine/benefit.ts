/**
 * BENEFIT — did the change actually make the backend better?
 * ==========================================================
 *
 * Verification proves a change WORKED: the data agrees, clients still work,
 * access is unchanged. That is necessary and it is not the claim an
 * architecture engine exists to make. This asks the second question, and
 * answers it only as far as the numbers allow:
 *
 *   beneficial             something the change was made to improve improved
 *                          beyond noise, and nothing regressed
 *   neutral                what it was made to improve was measured and did
 *                          not improve, and every guardrail could be compared
 *                          and held
 *   regressed              a correctness check failed, or a guardrail got
 *                          worse beyond noise
 *   insufficient_evidence  the numbers that would decide it are not available
 *                          or rest on too few samples. Said plainly, never
 *                          rounded up to "beneficial".
 *
 * ── Three kinds of number, three different powers ──────────────────────────
 *
 * Every measurement says what it is allowed to decide (`role`):
 *
 *   guardrail  latency, server errors, refusals on what already existed. It
 *              can say "regressed" and nothing else. A change that only ADDS
 *              work — a structural extraction before anyone drops a column
 *              adds a trigger and a second row — cannot make the host faster,
 *              so a p95 that fell afterwards is a change in the traffic mix.
 *              The improvement is shown in the comparisons and never counted.
 *   benefit    tied to the cost that justified the change: schema changes to
 *              the concern no longer locking the host, fewer repairs on its
 *              columns. The only kind that can make a change "beneficial". A
 *              benefit that got worse is shown too, and is not a regression of
 *              the change: the change did not pay off, it did not break
 *              anything.
 *   cost       the price: storage, extra row writes. Reported in words so the
 *              owner sees it, and never a verdict on its own.
 *
 * ── When a number moved enough to matter ───────────────────────────────────
 *
 *   rates (unit 'ratio')   regressed only when ALL of: at least
 *                          RATE_MIN_EVENTS bad events after, an absolute rise
 *                          of RATE_MIN_ABS, and a pooled two-proportion z of
 *                          RATE_MIN_Z with the request counts as denominators.
 *                          An absolute floor alone flips on one extra error in
 *                          two hundred; a z-test alone calls 0.01% → 0.02%
 *                          significant on a busy table. Together they need
 *                          both size and certainty.
 *   latency (unit 'ms')    after/before of LATENCY_RATIO and a rise of
 *                          LATENCY_MIN_MS. Request durations are whole
 *                          milliseconds end to end, so 2ms → 3ms is +50% and
 *                          means nothing.
 *   anything else          a relative move of REGRESSION.
 *   benefits               a relative move of IMPROVEMENT, or, for benefits
 *                          counted in whole events, the threshold their unit
 *                          names in COUNT_IMPROVEMENT.
 *
 * The same thresholds, mirrored, decide whether a guardrail "improved" — which
 * is reported and decides nothing.
 *
 * ── Samples ─────────────────────────────────────────────────────────────────
 *
 * Each measurement carries its own minimum, because a p95 needs more requests
 * than a mean of statement times and a repair count needs three incidents
 * before it says anything. Both sides must reach it, or the measurement is
 * `not_comparable` and the counts are in its text. A missing side is not a
 * zero: it is "not measured", with the reason.
 *
 * A benefit or cost side whose sample size is null is an event count over a
 * window as long as the other side's, where zero is the answer hoped for; it
 * has no minimum. A guardrail with an unknown sample size is never compared.
 *
 * ── The verdict, in order ───────────────────────────────────────────────────
 *
 *   1. a correctness check failed                                → regressed
 *   2. a guardrail regressed                                     → regressed
 *   3. a benefit improved                                        → beneficial
 *   4. a benefit was measured with enough evidence and did not
 *      improve, and every guardrail could be compared            → neutral
 *   5. anything else                                             → insufficient_evidence
 *
 * Guardrails that lacked samples do not block (3): the benefits that can fire
 * it are counted in schema changes and repairs, which do not depend on how
 * busy the table is. They are listed in `unmeasured`, so the report never
 * implies they were checked.
 *
 * Pure.
 */

import type { Measurement, MeasurementRole, UnavailableReason } from './primitive'

export type BenefitVerdict = 'beneficial' | 'neutral' | 'regressed' | 'insufficient_evidence'

/** Bad events needed on the worse side before a rate can be called a regression. */
export const RATE_MIN_EVENTS = 5
/** Absolute rise a rate needs: half a percentage point. */
export const RATE_MIN_ABS = 0.005
/** Pooled two-proportion z a rate needs. */
export const RATE_MIN_Z = 3
/** p95 after / p95 before that counts as slower. */
export const LATENCY_RATIO = 1.25
/** And the rise in milliseconds it also needs. */
export const LATENCY_MIN_MS = 20
/** Relative move that counts as worse, for units with no rule of their own. */
export const REGRESSION = 0.2
/** Relative move that counts as a real benefit. */
export const IMPROVEMENT = 0.1

/**
 * Benefits counted in whole events, by unit, and how far the count must fall
 * to be called an improvement.
 *
 *   repairs  MATERIAL_CHANGE (0.3), the same bar lib/autonomy/maintenance/
 *            outcome.ts sets for "the repair helped". Restated, not imported,
 *            to keep this module free of the database; a test holds them equal.
 *   changes  1: every change to the concern since must have stayed off the
 *            table it left. One that still landed there means the concern is
 *            still growing in the old place, and the saving has not shown.
 */
export const COUNT_IMPROVEMENT: Readonly<Record<string, number>> = { repairs: 0.3, changes: 1 }

export interface Comparison {
  name: string
  scope: string
  role: MeasurementRole
  direction: 'improved' | 'regressed' | 'unchanged' | 'not_comparable'
  /** before → after, formatted, or why it could not be compared. */
  text: string
  relativeChange: number | null
  /** Why it could not be compared, when it could not. */
  reason: UnavailableReason | null
}

/** Words for each reason, used when a measurement carries no detail of its own. */
const REASON_TEXT: Record<UnavailableReason, string> = {
  extension_missing: 'statement statistics are not installed on this database',
  statement_text_hidden: "the database hides other roles' statements from Backenly",
  stats_reset: 'the database statistics were reset in between',
  statements_evicted: 'the statement statistics dropped entries in between',
  relation_recreated: 'the table was dropped and created again in between',
  request_log_unreadable: 'the request log could not be read',
  history_unreadable: "Backenly's own record of repairs could not be read",
  no_traffic_recorded: 'no requests were recorded',
  table_not_served_over_api: 'the table is not reached through the API',
  insufficient_sample: 'too few samples',
  window_aged_out: 'the request log no longer holds that period',
  not_applicable_before_contract: 'it can only change once the old columns are removed',
  not_yet_measurable: 'it cannot be measured yet',
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places

function fmt(v: number, unit: string): string {
  if (unit === 'ms') return `${v >= 100 ? Math.round(v) : round(v, 1)}ms`
  if (unit === 'ratio') return `${round(v * 100, v < 0.01 ? 2 : 1)}%`
  if (unit === 'bytes') {
    const steps: Array<[number, string]> = [[1024 ** 3, 'GB'], [1024 ** 2, 'MB'], [1024, 'KB']]
    for (const [size, label] of steps) if (v >= size) return `${round(v / size, 1)} ${label}`
    return `${Math.round(v)} B`
  }
  if (unit in COUNT_IMPROVEMENT) return String(Math.round(v))
  return `${round(v, 2)}${unit ? ` ${unit}` : ''}`
}

/** Two-proportion z with a pooled variance; 0 when there is no variance at all. */
export function pooledZ(eventsBefore: number, nBefore: number, eventsAfter: number, nAfter: number): number {
  if (nBefore <= 0 || nAfter <= 0) return 0
  const p = (eventsBefore + eventsAfter) / (nBefore + nAfter)
  const se = Math.sqrt(p * (1 - p) * (1 / nBefore + 1 / nAfter))
  if (se === 0) return 0
  return (eventsAfter / nAfter - eventsBefore / nBefore) / se
}

interface Side {
  value: number
  samples: number | null
  events: number | null
}

/**
 * Whether `to` is worse than `from` beyond noise, by the rule for this
 * measurement's unit. Called as (before, after) for a regression and as
 * (after, before) for an improvement, so the two are judged by one rule.
 */
function worseBeyondNoise(m: Measurement, from: Side, to: Side): boolean {
  const worse = m.better === 'lower' ? to.value > from.value : to.value < from.value
  if (!worse) return false
  if (m.unit === 'ratio') {
    if (from.samples === null || to.samples === null) return false
    const eventsTo = to.events ?? Math.round(to.value * to.samples)
    const eventsFrom = from.events ?? Math.round(from.value * from.samples)
    const z = Math.abs(pooledZ(eventsFrom, from.samples, eventsTo, to.samples))
    return eventsTo >= RATE_MIN_EVENTS && Math.abs(to.value - from.value) >= RATE_MIN_ABS && z >= RATE_MIN_Z
  }
  if (m.unit === 'ms') {
    const [lo, hi] = m.better === 'lower' ? [from.value, to.value] : [to.value, from.value]
    return hi - lo >= LATENCY_MIN_MS && (lo === 0 || hi / lo >= LATENCY_RATIO)
  }
  const rel = from.value === 0 ? Infinity : Math.abs(to.value - from.value) / Math.abs(from.value)
  return rel >= REGRESSION
}

function relative(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : after > 0 ? Infinity : -Infinity
  return (after - before) / Math.abs(before)
}

function samplesText(m: Measurement): string {
  const sides = [
    m.samplesBefore !== null ? `${m.samplesBefore} before` : null,
    m.samplesAfter !== null ? `${m.samplesAfter} after` : null,
  ].filter(Boolean)
  return `${sides.join(', ')}; ${m.minSamples} needed`
}

export function compare(m: Measurement): Comparison {
  const base = { name: m.name, scope: m.scope, role: m.role }
  if (m.before === null || m.after === null) {
    const why = m.unavailableReason ?? (m.reason ? REASON_TEXT[m.reason] : 'no value was recorded')
    return { ...base, direction: 'not_comparable', text: `${m.name}: not measured (${why})`, relativeChange: null, reason: m.reason ?? 'not_yet_measurable' }
  }

  // A guardrail must know its sample sizes; a benefit or cost side without one
  // is an event count over an equal window and has no minimum (see header).
  const unknown = (n: number | null) => n === null && m.role === 'guardrail'
  const thin = (n: number | null) => n !== null && n < m.minSamples
  if (unknown(m.samplesBefore) || unknown(m.samplesAfter)) {
    return {
      ...base,
      direction: 'not_comparable',
      text: `${m.name}: ${fmt(m.before, m.unit)} → ${fmt(m.after, m.unit)}, but how many samples lie behind it is unknown`,
      relativeChange: null,
      reason: 'insufficient_sample',
    }
  }
  if (thin(m.samplesBefore) || thin(m.samplesAfter)) {
    return {
      ...base,
      direction: 'not_comparable',
      text: `${m.name}: ${fmt(m.before, m.unit)} → ${fmt(m.after, m.unit)}, too few to judge (${samplesText(m)})`,
      relativeChange: null,
      reason: 'insufficient_sample',
    }
  }

  const rel = relative(m.before, m.after)
  const change =
    m.unit === 'ratio'
      ? `${m.after >= m.before ? '+' : ''}${round((m.after - m.before) * 100, 2)} points`
      : Number.isFinite(rel)
        ? `${rel > 0 ? '+' : ''}${Math.round(rel * 100)}%`
        : 'from zero'
  const text = `${m.name}: ${fmt(m.before, m.unit)} → ${fmt(m.after, m.unit)} (${change})`

  let direction: Comparison['direction'] = 'unchanged'
  if (m.role === 'benefit') {
    const threshold = COUNT_IMPROVEMENT[m.unit] ?? IMPROVEMENT
    const better = m.better === 'lower' ? m.after < m.before : m.after > m.before
    const moved = Math.abs(rel) >= threshold - 1e-9
    if (moved) direction = better ? 'improved' : 'regressed'
  } else {
    const before: Side = { value: m.before, samples: m.samplesBefore, events: m.eventsBefore ?? null }
    const after: Side = { value: m.after, samples: m.samplesAfter, events: m.eventsAfter ?? null }
    if (worseBeyondNoise(m, before, after)) direction = 'regressed'
    else if (worseBeyondNoise(m, after, before)) direction = 'improved'
  }

  return { ...base, direction, text, relativeChange: Number.isFinite(rel) ? rel : null, reason: null }
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
  /** Two or three sentences for a business owner. */
  summary: string
  /** What could not be measured, and why, one line each. */
  unmeasured: string[]
  /** What the change costs, one line each. Never part of the verdict. */
  costs: string[]
}

const CHECK_WORDS: Record<keyof CorrectnessChecks, string> = {
  correctness: 'its data stopped matching',
  compatibility: 'a problem showed up while it was being watched',
  authorization: 'who may read or change the data did not stay the same',
}

/** "orders write p95 rose from 40ms to 90ms". */
function movement(m: Measurement, verb: 'went' | 'moved'): string {
  const b = fmt(m.before!, m.unit)
  const a = fmt(m.after!, m.unit)
  if (verb === 'went') return `${m.name} went from ${b} to ${a}`
  return `${m.name} ${m.after! > m.before! ? 'rose' : 'fell'} from ${b} to ${a}`
}

const sentenceList = (xs: string[]) =>
  xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

/** The comparison's own detail, without its name, for a sentence. */
const why = (c: Comparison) => c.text.slice(c.name.length + 2)

export function assessBenefit(checks: CorrectnessChecks, measurements: Measurement[]): BenefitReport {
  const comparisons = measurements.map(compare)
  const pairs = measurements.map((m, i) => ({ m, c: comparisons[i] }))
  const unmeasured = comparisons.filter(c => c.direction === 'not_comparable').map(c => c.text)
  const costs = comparisons.filter(c => c.role === 'cost' && c.direction !== 'not_comparable').map(c => c.text)
  const report = (verdict: BenefitVerdict, summary: string): BenefitReport => ({
    verdict,
    checks,
    comparisons,
    summary,
    unmeasured,
    costs,
  })

  const failed = (Object.keys(CHECK_WORDS) as Array<keyof CorrectnessChecks>).filter(k => checks[k] === 'fail')
  if (failed.length > 0) {
    return report('regressed', `It made things worse: ${sentenceList(failed.map(k => CHECK_WORDS[k]))}.`)
  }

  const guardrails = pairs.filter(p => p.m.role === 'guardrail')
  const benefits = pairs.filter(p => p.m.role === 'benefit')
  const regressed = guardrails.filter(p => p.c.direction === 'regressed')
  if (regressed.length > 0) {
    return report('regressed', `It made things worse: ${sentenceList(regressed.map(p => movement(p.m, 'moved')))}.`)
  }

  const lead = checks.correctness === 'pass' ? 'It works correctly.' : 'Backenly could not confirm its data still matches.'
  const improved = benefits.filter(p => p.c.direction === 'improved')
  if (improved.length > 0) {
    const helped = improved.map(p => `${movement(p.m, 'went')}${p.m.scope ? ` (${p.m.scope})` : ''}`)
    return report('beneficial', `${lead} It helped: ${sentenceList(helped)}.`)
  }

  const measured = benefits.filter(p => p.c.direction !== 'not_comparable')
  const guardrailsComparable = guardrails.every(p => p.c.direction !== 'not_comparable')
  if (measured.length > 0 && guardrailsComparable) {
    return report(
      'neutral',
      `${lead} Nothing got worse, but what it was made to improve has not improved yet: ${measured.map(p => p.c.text).join('; ')}.`,
    )
  }

  // Say the most useful reason it is undecided: first what the change was made
  // for, then whether too little traffic kept a slowdown from being ruled out.
  const thinTraffic = guardrails.some(
    p => p.c.reason === 'insufficient_sample' || p.c.reason === 'no_traffic_recorded' || p.c.reason === 'table_not_served_over_api',
  )
  // A benefit that was not measured explains itself in its detail ("refund has
  // not changed since"); one measured on too little keeps its name and counts.
  const benefitWhy = benefits
    .filter(p => p.c.direction === 'not_comparable')
    .map(p => (p.m.before === null || p.m.after === null ? why(p.c).replace(/^not measured \((.*)\)$/, '$1') : p.c.text))
  const cause =
    benefits.length === 0
      ? 'nothing it was made to improve can be measured here'
      : benefitWhy.length > 0
        ? benefitWhy.join('; ')
        : thinTraffic
          ? 'too little traffic so far to rule out a slowdown'
          : `${guardrails.filter(p => p.c.direction === 'not_comparable').map(p => p.m.name).join(', ')} could not be measured`
  return report('insufficient_evidence', `${lead} Too early to say whether it helped: ${cause}.`)
}
