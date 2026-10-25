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
 *                          beyond chance, nothing it was made to improve got
 *                          worse, and the change's existing clients were
 *                          checked and unaffected
 *   neutral                what it was made to improve was measured and did
 *                          not improve beyond chance (or got worse), and the
 *                          existing clients were checked and unaffected
 *   regressed              a correctness check failed, or a guardrail got
 *                          worse beyond noise
 *   insufficient_evidence  the numbers that would decide it are not available
 *                          or rest on too few samples. Said plainly, never
 *                          rounded up to "beneficial".
 *
 * "Beneficial" never needs less evidence than "neutral": both need the same
 * check of the existing clients, and "beneficial" needs a benefit on top.
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
 *              the concern no longer locking the host, fewer problems found on
 *              its columns. The only kind that can make a change "beneficial".
 *              A benefit that got worse is shown too, and is not a regression
 *              of the change: the change did not pay off, it did not break
 *              anything — but the change is then never called beneficial.
 *   cost       the price: storage, extra row writes. Reported in words so the
 *              owner sees it, and never a verdict on its own.
 *
 * ── Who must be checked ─────────────────────────────────────────────────────
 *
 * A guardrail names the clients it watches (`population`). The clients who
 * reach the table through Backenly's API are watched by the request log; when
 * there are such clients, their guardrails must all be comparable for either
 * "beneficial" or "neutral". A guardrail of a kind the table has no clients of
 * (no reads, or no writes, over the API in either window) does not apply.
 * Only when nothing reaches the table over the API do the database's own
 * statement statistics decide instead. A guardrail with no population is
 * always required. Whatever was not compared is listed in `unmeasured`.
 *
 * ── When a number moved enough to matter ───────────────────────────────────
 *
 *   rates (unit 'ratio')   regressed only when ALL of: at least
 *                          RATE_MIN_EVENTS bad events after, an absolute rise
 *                          of RATE_MIN_ABS, and a pooled two-proportion z of
 *                          RATE_MIN_Z with the request counts as denominators.
 *                          Because the test weighs the counts, a rise this
 *                          decisive regresses even below the measurement's
 *                          own minimum of requests; nothing else does.
 *   latency (unit 'ms')    after/before of LATENCY_RATIO and a rise of
 *                          LATENCY_MIN_MS. Request durations are whole
 *                          milliseconds end to end, so 2ms → 3ms is +50% and
 *                          means nothing.
 *   counted benefits       whole events (COUNT_UNITS) in two windows of equal
 *                          length: an exact one-sided binomial test at
 *                          COUNT_SIGNIFICANCE. Were nothing different, each
 *                          event would fall in either window with even odds;
 *                          3 → 2 is that, 5 → 0 is not (p ≈ 0.03).
 *   anything else          a relative move of REGRESSION for a guardrail, of
 *                          IMPROVEMENT for a benefit.
 *
 * The same thresholds, mirrored, decide whether a guardrail "improved" — which
 * is reported and decides nothing.
 *
 * ── Samples ─────────────────────────────────────────────────────────────────
 *
 * Each measurement carries its own minimum, because a p95 needs more requests
 * than a mean of statement times. Both sides must reach it, or the measurement
 * is `not_comparable` and the counts are in its text. A missing side is not a
 * zero: it is "not measured", with the reason. A guardrail with an unknown
 * sample size is never compared. A counted benefit has no minimum: the test
 * is its own measure of how much the counts can say.
 *
 * ── The verdict, in order ───────────────────────────────────────────────────
 *
 *   1. a correctness check failed                                → regressed
 *   2. a guardrail regressed                                     → regressed
 *   3. a benefit improved, none got worse, clients were checked  → beneficial
 *   4. a benefit was measured, clients were checked              → neutral
 *   5. anything else                                             → insufficient_evidence
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
/** Relative move that counts as a real benefit, for units with no rule of their own. */
export const IMPROVEMENT = 0.1
/** One-sided significance a counted benefit needs, either way. */
export const COUNT_SIGNIFICANCE = 0.05

/**
 * Units of benefits counted in whole events over two windows of equal length:
 * schema changes to the concern that locked the host, problems found on its
 * columns. Judged by an exact test (see the header), never by a relative move.
 */
export const COUNT_UNITS: ReadonlySet<string> = new Set(['changes', 'problems'])

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
  history_unreadable: "Backenly's own record of problems could not be read",
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
  if (COUNT_UNITS.has(unit)) return String(Math.round(v))
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

/** The standard normal distribution function, to six decimals (Abramowitz and Stegun 7.1.26). */
function normalCdf(z: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2)
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf = 1 - poly * Math.exp(-(z * z) / 2)
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}

/**
 * P(X ≤ k) for X ~ Binomial(n, 1/2): how often chance alone puts k or fewer of
 * n events in one of two equal windows. Exact up to a thousand events, and the
 * normal approximation with a continuity correction beyond.
 */
export function binomialAtMost(k: number, n: number): number {
  if (k < 0) return 0
  if (k >= n) return 1
  if (n > 1000) return normalCdf((k + 0.5 - n / 2) / Math.sqrt(n / 4))
  let pmf = 2 ** -n
  let sum = pmf
  for (let i = 1; i <= k; i++) {
    pmf = (pmf * (n - i + 1)) / i
    sum += pmf
  }
  return Math.min(1, sum)
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

/** A counted benefit: an exact test between two windows of equal length. */
function compareCounts(m: Measurement, base: Pick<Comparison, 'name' | 'scope' | 'role'>): Comparison {
  const before = Math.round(m.before!)
  const after = Math.round(m.after!)
  const n = before + after
  if (n === 0) {
    return {
      ...base,
      direction: 'not_comparable',
      text: `${m.name}: none before or since, so nothing to compare yet`,
      relativeChange: null,
      reason: 'insufficient_sample',
    }
  }
  const [fewer, more] = m.better === 'lower' ? [after, before] : [before, after]
  // The chance of so few on the side hoped to be smaller, and of so few on
  // the other side, were nothing different.
  const pImproved = fewer < more ? binomialAtMost(fewer, n) : 1
  const pWorse = more < fewer ? binomialAtMost(more, n) : 1
  const direction: Comparison['direction'] =
    pImproved < COUNT_SIGNIFICANCE ? 'improved' : pWorse < COUNT_SIGNIFICANCE ? 'regressed' : 'unchanged'
  const moved = before !== after && direction === 'unchanged' ? ', within what chance alone gives' : ''
  return {
    ...base,
    direction,
    text: `${m.name}: ${before} → ${after}${moved}`,
    relativeChange: before === 0 ? null : (after - before) / before,
    reason: null,
  }
}

export function compare(m: Measurement): Comparison {
  const base = { name: m.name, scope: m.scope, role: m.role }
  if (m.before === null || m.after === null) {
    const why = m.unavailableReason ?? (m.reason ? REASON_TEXT[m.reason] : 'no value was recorded')
    return { ...base, direction: 'not_comparable', text: `${m.name}: not measured (${why})`, relativeChange: null, reason: m.reason ?? 'not_yet_measurable' }
  }
  if (m.role === 'benefit' && COUNT_UNITS.has(m.unit)) return compareCounts(m, base)

  const beforeSide: Side = { value: m.before, samples: m.samplesBefore, events: m.eventsBefore ?? null }
  const afterSide: Side = { value: m.after, samples: m.samplesAfter, events: m.eventsAfter ?? null }

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
    // A rate rise the test calls decisive is a regression however few the
    // requests: the test weighs exactly that. Nothing else is decided on so few.
    if (m.role === 'guardrail' && m.unit === 'ratio' && worseBeyondNoise(m, beforeSide, afterSide)) {
      return {
        ...base,
        direction: 'regressed',
        text: `${m.name}: ${fmt(m.before, m.unit)} → ${fmt(m.after, m.unit)}, on few requests (${samplesText(m)}) but beyond chance`,
        relativeChange: relative(m.before, m.after),
        reason: null,
      }
    }
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
    const better = m.better === 'lower' ? m.after < m.before : m.after > m.before
    if (Math.abs(rel) >= IMPROVEMENT - 1e-9) direction = better ? 'improved' : 'regressed'
  } else {
    if (worseBeyondNoise(m, beforeSide, afterSide)) direction = 'regressed'
    else if (worseBeyondNoise(m, afterSide, beforeSide)) direction = 'improved'
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
  /**
   * Whether the change's existing clients were checked: `held` when every
   * guardrail that must be compared was, and none regressed; `regressed` when
   * any guardrail regressed; `unknown` otherwise. Only `held` lets anyone say
   * existing apps kept working.
   */
  safety: 'held' | 'regressed' | 'unknown'
  /** Two or three sentences for a business owner, with the numbers behind them. */
  summary: string
  /**
   * The same verdict in one or two sentences without a number: what a person
   * reads by default. `summary` is for whoever opens the details.
   */
  plain: string
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

/** What a guardrail that got worse means for the apps it watches, without its numbers. */
function harm(m: Measurement): string {
  if (m.unit === 'ms') return 'requests got slower'
  if (m.unit === 'ratio') return 'requests failed more often'
  return `${m.name} got worse`
}

/** What a benefit that moved means, without its numbers: "fewer problems found on refund columns". */
const gain = (m: Measurement) => `${m.better === 'lower' ? 'fewer' : 'more'} ${m.name}`

/** The comparison's own detail, without its name, for a sentence. */
const why = (c: Comparison) => c.text.slice(c.name.length + 2)

type Pair = { m: Measurement; c: Comparison }

/** The guardrails that must be compared for anyone to say existing clients were unaffected (see "Who must be checked"). */
function requiredGuardrails(guardrails: Pair[]): Pair[] {
  const always = guardrails.filter(p => p.m.population === undefined)
  const api = guardrails.filter(p => p.m.population === 'api' && p.c.reason !== 'table_not_served_over_api')
  const database = guardrails.filter(p => p.m.population === 'database')
  return [...always, ...(api.length > 0 ? api : database)]
}

export function assessBenefit(checks: CorrectnessChecks, measurements: Measurement[]): BenefitReport {
  const comparisons = measurements.map(compare)
  const pairs: Pair[] = measurements.map((m, i) => ({ m, c: comparisons[i] }))
  const unmeasured = comparisons.filter(c => c.direction === 'not_comparable').map(c => c.text)
  const costs = comparisons.filter(c => c.role === 'cost' && c.direction !== 'not_comparable').map(c => c.text)
  const guardrails = pairs.filter(p => p.m.role === 'guardrail')
  const benefits = pairs.filter(p => p.m.role === 'benefit')
  const regressed = guardrails.filter(p => p.c.direction === 'regressed')
  const required = requiredGuardrails(guardrails)
  const checked = required.length > 0 && required.every(p => p.c.direction !== 'not_comparable')
  const safety: BenefitReport['safety'] = regressed.length > 0 ? 'regressed' : checked ? 'held' : 'unknown'
  const report = (verdict: BenefitVerdict, summary: string, plain: string): BenefitReport => ({
    verdict,
    checks,
    comparisons,
    safety,
    summary,
    plain,
    unmeasured,
    costs,
  })

  const failed = (Object.keys(CHECK_WORDS) as Array<keyof CorrectnessChecks>).filter(k => checks[k] === 'fail')
  if (failed.length > 0) {
    const words = `It made things worse: ${sentenceList(failed.map(k => CHECK_WORDS[k]))}.`
    return report('regressed', words, words)
  }
  if (regressed.length > 0) {
    return report(
      'regressed',
      `It made things worse: ${sentenceList(regressed.map(p => movement(p.m, 'moved')))}.`,
      `It made things worse: ${sentenceList([...new Set(regressed.map(p => harm(p.m)))])}.`,
    )
  }

  const lead = checks.correctness === 'pass' ? 'It works correctly.' : 'Backenly could not confirm its data still matches.'
  // The plain sentence says only what is not already said beside it: a change
  // that works is said to work by the milestone it sits in.
  const plainLead = checks.correctness === 'pass' ? '' : `${lead} `
  const improved = benefits.filter(p => p.c.direction === 'improved')
  const worsened = benefits.filter(p => p.c.direction === 'regressed')
  const measured = benefits.filter(p => p.c.direction !== 'not_comparable')
  const helped = improved.map(p => `${movement(p.m, 'went')}${p.m.scope ? ` (${p.m.scope})` : ''}`)

  if (improved.length > 0 && worsened.length === 0 && checked) {
    return report('beneficial', `${lead} It helped: ${sentenceList(helped)}.`, `${plainLead}It helped: ${sentenceList(improved.map(p => gain(p.m)))}.`)
  }
  if (measured.length > 0 && checked) {
    if (worsened.length > 0) {
      const worse = sentenceList(worsened.map(p => movement(p.m, 'moved')))
      const also = improved.length > 0 ? `, although ${sentenceList(improved.map(p => movement(p.m, 'went')))}` : ''
      return report(
        'neutral',
        `${lead} Existing apps were unaffected, but what it was made to improve got worse: ${worse}${also}.`,
        `${plainLead}Existing apps were unaffected, but what it was made to improve got worse.`,
      )
    }
    return report(
      'neutral',
      `${lead} Existing apps were unaffected, but it has not paid off yet: ${measured.map(p => p.c.text).join('; ')}.`,
      `${plainLead}Existing apps were unaffected, but it has not paid off yet.`,
    )
  }

  // Undecided. Say the most useful reason: first what the change was made
  // for, then whether existing clients could be checked.
  const thinTraffic = required.some(
    p => p.c.reason === 'insufficient_sample' || p.c.reason === 'no_traffic_recorded' || p.c.reason === 'table_not_served_over_api',
  )
  const clients = thinTraffic
    ? 'there is too little traffic so far to show existing apps were unaffected'
    : required.length === 0
      ? 'nothing could show whether existing apps were affected'
      : `${required.filter(p => p.c.direction === 'not_comparable').map(p => p.m.name).join(', ')} could not be measured`
  if (improved.length > 0) {
    return report(
      'insufficient_evidence',
      `${lead} It may have helped (${sentenceList(improved.map(p => movement(p.m, 'went')))}), but ${clients}.`,
      `${plainLead}It may have helped, but it is too early to say.`,
    )
  }
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
        : clients
  return report('insufficient_evidence', `${lead} Too early to say whether it helped: ${cause}.`, `${plainLead}Too early to say whether it helped.`)
}
