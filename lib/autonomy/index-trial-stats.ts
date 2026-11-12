/**
 * WELCH'S t-TEST OVER STATEMENT STATISTICS
 * ========================================
 *
 * An index Backenly builds on its own is kept only if the queries it was built
 * for got measurably faster (./index-trials.ts). "Measurably" is this file: the
 * statements' times before the index and since, compared by Welch's unequal-
 * variances t-test, one-sided.
 *
 * pg_stat_statements keeps, per statement, the number of calls, their total
 * time and the population standard deviation of their times. Those are kept
 * here as additive sums (n, Σx, Σx²), so the calls since a snapshot are the
 * difference of two readings, and several rows of one statement (one per role)
 * add up. The sample variance and the test are computed from the sums.
 *
 * Pure.
 */

/**
 * Additive summary of a set of statement times, in milliseconds, and of the
 * shared buffer pages the calls touched (hit or read): how much of the table a
 * plan visits, which a change of plan moves and the state of the cache does not.
 */
export interface TimeSums {
  n: number
  sum: number
  sumSq: number
  blocks?: number
}

export const NO_TIMES: TimeSums = Object.freeze({ n: 0, sum: 0, sumSq: 0, blocks: 0 })

/**
 * One pg_stat_statements row as sums. `stddev` is the population standard
 * deviation the extension reports (`stddev_exec_time`); `blocks` is
 * shared_blks_hit + shared_blks_read.
 */
export function timesFromStatement(calls: number, totalMs: number, stddevMs: number, blocks = 0): TimeSums {
  const n = Number(calls) || 0
  if (n <= 0) return { ...NO_TIMES }
  const sum = Number(totalMs) || 0
  const mean = sum / n
  const sd = Number(stddevMs) || 0
  return { n, sum, sumSq: n * (sd * sd + mean * mean), blocks: Number(blocks) || 0 }
}

export function addTimes(a: TimeSums, b: TimeSums): TimeSums {
  return { n: a.n + b.n, sum: a.sum + b.sum, sumSq: a.sumSq + b.sumSq, blocks: (a.blocks ?? 0) + (b.blocks ?? 0) }
}

/** Pages touched per call, or null with no calls. */
export function blocksPerCall(t: TimeSums): number | null {
  return t.n > 0 ? (t.blocks ?? 0) / t.n : null
}

/**
 * The calls between two readings of the same statement. A count that went
 * backwards means the entry was dropped and counted again from zero since the
 * earlier reading, so everything the later one holds came after it.
 */
export function timesSince(earlier: TimeSums | undefined, later: TimeSums | undefined): TimeSums {
  if (!later) return { ...NO_TIMES }
  if (!earlier || later.n < earlier.n) return { ...later }
  return {
    n: later.n - earlier.n,
    sum: Math.max(0, later.sum - earlier.sum),
    sumSq: Math.max(0, later.sumSq - earlier.sumSq),
    blocks: Math.max(0, (later.blocks ?? 0) - (earlier.blocks ?? 0)),
  }
}

export function meanOf(t: TimeSums): number {
  return t.n > 0 ? t.sum / t.n : 0
}

/** Unbiased sample variance, never negative (float error on near-constant times). */
export function sampleVariance(t: TimeSums): number {
  if (t.n < 2) return 0
  const v = (t.sumSq - (t.sum * t.sum) / t.n) / (t.n - 1)
  return v > 0 ? v : 0
}

// ── Student's t distribution ─────────────────────────────────────────────────

/** ln Γ(z), Lanczos approximation (g = 7, nine coefficients). */
function logGamma(z: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  const x = z - 1
  let a = c[0]
  for (let i = 1; i < 9; i++) a += c[i] / (x + i)
  const t = x + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const TINY = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < TINY) d = TINY
  d = 1 / d
  let h = d
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-15) break
  }
  return h
}

/** The regularized incomplete beta function I_x(a, b). */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b
}

/** P(T ≤ t) for Student's t with `df` degrees of freedom (df may be fractional). */
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0
  const tail = 0.5 * regularizedBeta(df / (df + t * t), df / 2, 0.5)
  return t >= 0 ? 1 - tail : tail
}

// ── The test ─────────────────────────────────────────────────────────────────

export interface WelchResult {
  meanBefore: number
  meanAfter: number
  t: number
  df: number
  /** One-sided p that the times since are LOWER than before. */
  pFaster: number
  /** One-sided p that the times since are HIGHER than before. */
  pSlower: number
}

/**
 * Welch's t-test between the times before and the times since. Null when
 * either side has fewer than two calls: there is no variance to test against.
 *
 * Two sides with no spread at all (every call took the same time) differ with
 * certainty or not at all, and are answered that way rather than dividing by
 * zero.
 */
export function welch(before: TimeSums, after: TimeSums): WelchResult | null {
  if (before.n < 2 || after.n < 2) return null
  const m1 = meanOf(before)
  const m2 = meanOf(after)
  const a = sampleVariance(before) / before.n
  const b = sampleVariance(after) / after.n
  const se2 = a + b
  if (se2 <= 0) {
    const faster = m2 < m1 ? 0 : 1
    const slower = m2 > m1 ? 0 : 1
    return { meanBefore: m1, meanAfter: m2, t: m2 === m1 ? 0 : m2 < m1 ? Infinity : -Infinity, df: before.n + after.n - 2, pFaster: faster, pSlower: slower }
  }
  // t > 0 when the times since are lower.
  const t = (m1 - m2) / Math.sqrt(se2)
  const df = (se2 * se2) / ((a * a) / (before.n - 1) + (b * b) / (after.n - 1))
  return { meanBefore: m1, meanAfter: m2, t, df, pFaster: 1 - studentTCdf(t, df), pSlower: studentTCdf(t, df) }
}
