/**
 * DEVIATION — is this normal for THIS backend?
 * =============================================
 *
 * Pure. No database, no clock, no I/O. Split out for the reason this codebase
 * keeps relearning: a detector that has never been observed producing a finding
 * is not evidence of anything, and the only way to prove this one CAN fire is to
 * hand it numbers in a unit test.
 *
 * ── Why a baseline rather than a threshold ──────────────────────────────────
 *
 * Every performance check in the platform before this one compared against a
 * fixed number: 100ms for a slow query, 500 rows for a table worth indexing,
 * 40% dead tuples. Fixed thresholds answer "is this bad in general". They cannot
 * answer the question a developer actually asks, which is "is this bad for ME" —
 * a query that went from 4ms to 60ms is still fast by any threshold, fifteen
 * times worse than it was, and almost certainly the thing they noticed.
 *
 * ── The four rules that keep this from being a noise generator ──────────────
 *
 *  1. ENOUGH HISTORY. Below MIN_BASELINE_SAMPLES there is no baseline, only a
 *     few numbers, and the honest answer is "not enough history yet". A ratio
 *     computed from two samples is arithmetic, not evidence.
 *
 *  2. MEDIAN, NOT MEAN. One deploy-day spike would drag a mean upward and then
 *     mask the regression it caused. The median of the trailing window is what
 *     "normal" means when the window contains abnormal hours — which it always
 *     eventually does.
 *
 *  3. AN ABSOLUTE FLOOR. A query going from 0.2ms to 3ms is a 15x regression and
 *     nobody cares. Ratios on tiny numbers are how a monitoring system teaches
 *     its owner to ignore it.
 *
 *  4. STABLE HISTORY. A subject whose own baseline swings wildly has no normal
 *     to deviate from. Comparing against the median of a bimodal series produces
 *     a finding on every tick in one of the two modes. When the historical
 *     spread is itself larger than the threshold, this reports nothing.
 */

/** One hourly observation. */
export interface Sample {
  /** Milliseconds, bytes, scans — whatever the subject measures. */
  value: number
  /** Underlying observations behind this value. */
  samples: number
}

export interface DeviationInput {
  /** Trailing history, oldest first, EXCLUDING the current value. */
  baseline: Sample[]
  /** The value being judged. */
  current: number
  /** Ratio above the baseline median that counts as a regression, e.g. 3 = 3x. */
  threshold: number
  /** Values at or below this are never reported, whatever the ratio. */
  floor: number
}

export type DeviationVerdict =
  /** Enough history, and the current value is far above this subject's normal. */
  | { kind: 'regressed'; baseline: number; current: number; ratio: number; observations: number }
  /** Enough history and nothing unusual. */
  | { kind: 'normal'; baseline: number; current: number; ratio: number; observations: number }
  /** Not enough history to say anything. Never treated as healthy. */
  | { kind: 'insufficient_history'; observations: number; needed: number }
  /** History exists but is too erratic to have a normal. */
  | { kind: 'unstable'; baseline: number; spreadRatio: number; observations: number }
  /** Above the ratio but below the floor — real, and not worth anyone's time. */
  | { kind: 'below_floor'; baseline: number; current: number; floor: number }

/**
 * Hours of history before a baseline means anything.
 *
 * Twelve, so a subject has been observed across most of a day. Fewer and a
 * backend that is quiet overnight and busy in the morning reports a regression
 * every morning — the daily cycle IS its normal, and a window shorter than the
 * cycle cannot contain it.
 */
export const MIN_BASELINE_SAMPLES = 12

/**
 * How much the baseline itself may vary before it has no normal to speak of.
 *
 * Expressed as p75/p25 — the interquartile ratio — and that choice is the whole
 * point rather than a detail. The obvious measure is p90/median, and it is blind
 * to the exact case this rule exists for: a subject with ten quiet hours at 2ms
 * and ten busy hours at 200ms has a MEDIAN of 101, sitting in the empty space
 * between its two modes, and a p90/median of only 2. It reads as stable, its
 * "normal" is a value it never actually takes, and every busy hour is then
 * judged against a number from nowhere.
 *
 * p25 and p75 land inside the two modes rather than between them, so the same
 * series reports a spread of 100 and is correctly refused.
 *
 * At 4, a subject whose quiet and busy quarters differ by less than the
 * regression threshold still qualifies — so a deviation above the threshold is
 * genuinely outside its range rather than the top of it.
 */
export const MAX_BASELINE_SPREAD = 4

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * Judge one value against its own history.
 *
 * Total: every input produces a verdict, and "I cannot say" is one of them.
 */
export function judgeDeviation(input: DeviationInput): DeviationVerdict {
  const { baseline, current, threshold, floor } = input

  // Only observations with real weight behind them. An hour that saw two calls
  // is a rounding error being treated as a data point.
  const usable = baseline.filter(s => s.samples > 0 && Number.isFinite(s.value))
  const observations = usable.length

  if (observations < MIN_BASELINE_SAMPLES) {
    return { kind: 'insufficient_history', observations, needed: MIN_BASELINE_SAMPLES }
  }

  const sorted = usable.map(s => s.value).sort((a, b) => a - b)
  const median = quantile(sorted, 0.5)
  const p25 = quantile(sorted, 0.25)
  const p75 = quantile(sorted, 0.75)

  // A subject whose own history spans more than MAX_BASELINE_SPREAD has no
  // single normal. Reporting against its median would fire on every hour that
  // lands in the upper part of its own range.
  //
  // p25 of zero means at least a quarter of the observed hours saw nothing at
  // all. There is no ratio against that, and more importantly a subject that is
  // idle a quarter of the time has no steady rate to regress FROM — its busy
  // hours are not a deviation, they are the other half of how it behaves.
  // Checked BEFORE the spread, because the two degenerate cases are different
  // facts and deserve different answers.
  //
  // p75 of zero means even the busy quarter of the observed hours saw nothing:
  // the subject has effectively never been observed doing this, so there is no
  // history of the measure at all. That is not instability, and it is not a
  // regression from nothing to something either — a first non-zero hour is a
  // subject starting to be used.
  if (p75 <= 0) {
    return { kind: 'insufficient_history', observations, needed: MIN_BASELINE_SAMPLES }
  }

  const spreadRatio = p25 > 0 ? p75 / p25 : Infinity
  if (spreadRatio > MAX_BASELINE_SPREAD) {
    return { kind: 'unstable', baseline: median, spreadRatio, observations }
  }

  const ratio = current / median

  if (ratio < threshold) {
    return { kind: 'normal', baseline: median, current, ratio, observations }
  }
  if (current <= floor) {
    return { kind: 'below_floor', baseline: median, current, floor }
  }
  return { kind: 'regressed', baseline: median, current, ratio, observations }
}

/** One line a human can read, with the numbers in it. */
export function describeDeviation(
  subject: string,
  unit: string,
  v: Extract<DeviationVerdict, { kind: 'regressed' }>,
): string {
  const fmt = (n: number) => (n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1))
  return (
    `${subject} is at ${fmt(v.current)}${unit}, against a normal of ` +
    `${fmt(v.baseline)}${unit} measured across ${v.observations} hours — ` +
    `${v.ratio.toFixed(1)}× its own baseline.`
  )
}
