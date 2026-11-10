/**
 * The test an index trial keeps or removes an index on (lib/autonomy/
 * index-trial-stats.ts). Every expected number below was computed with SciPy
 * 1.13.1 (scipy.stats.t.cdf, scipy.stats.ttest_ind with equal_var=False), not
 * with this code.
 */

import {
  addTimes,
  sampleVariance,
  studentTCdf,
  timesFromStatement,
  timesSince,
  welch,
  type TimeSums,
} from '@/lib/autonomy/index-trial-stats'

const sums = (xs: number[]): TimeSums => ({
  n: xs.length,
  sum: xs.reduce((a, b) => a + b, 0),
  sumSq: xs.reduce((a, b) => a + b * b, 0),
  blocks: 0,
})

describe("Student's t CDF", () => {
  it.each([
    [1.0, 1, 0.75],
    [1.0, 2, 0.788675134595],
    [1.812461, 10, 0.949999989981],
    [2.228139, 10, 0.975000006274],
    [-0.7, 3.5, 0.263817071173],
    [0.3, 57.2, 0.617367645007],
    [4.2, 24.98, 0.999851796219],
    [2.0, 1000, 0.977114826753],
  ])('t=%p, df=%p matches SciPy', (t, df, expected) => {
    expect(studentTCdf(t, df)).toBeCloseTo(expected, 9)
  })
})

describe("Welch's t-test from sums", () => {
  // Wikipedia's Welch example samples.
  const A = [27.5, 21.0, 19.0, 23.6, 17.0, 17.9, 16.9, 20.1, 21.9, 22.6, 23.1, 19.6, 19.0, 21.7, 21.4]
  const B = [27.1, 22.0, 20.8, 23.4, 23.4, 23.5, 25.8, 22.0, 24.8, 20.2, 21.9, 22.1, 22.9, 20.5, 24.4]

  it('gives SciPy statistic, degrees of freedom and one-sided p', () => {
    const w = welch(sums(A), sums(B))!
    expect(w.t).toBeCloseTo(-2.455356398286006, 9)
    expect(w.df).toBeCloseTo(24.988529290231416, 9)
    // "after" (B) is higher: SciPy alternative='less' on (A, B).
    expect(w.pSlower).toBeCloseTo(0.010689000731433492, 9)
    expect(w.pFaster).toBeCloseTo(1 - 0.010689000731433492, 9)
  })

  it('handles skewed latency-like samples of unequal size', () => {
    // 60 log-normal times around 120 ms before, 25 around 100 ms after
    // (numpy default_rng(7)); SciPy alternative='greater' on (before, after).
    const before = { n: 60, sum: 7140.380279873909, sumSq: 1026923.188496191 }
    const after = { n: 25, sum: 2658.287733306624, sumSq: 353168.1305149348 }
    const w = welch(before, after)!
    expect(w.t).toBeCloseTo(0.9791593039705, 9)
    expect(w.df).toBeCloseTo(45.44330645160381, 8)
    expect(w.pFaster).toBeCloseTo(0.16634273615725076, 9)
  })

  it('has no answer with fewer than two calls on a side', () => {
    expect(welch(sums([1, 2, 3]), sums([4]))).toBeNull()
  })

  it('answers with certainty when neither side varies', () => {
    const w = welch(sums([5, 5, 5]), sums([1, 1, 1]))!
    expect(w.pFaster).toBe(0)
    expect(w.pSlower).toBe(1)
  })
})

describe('sums from pg_stat_statements', () => {
  it('rebuilds the sum of squares from calls, total and the population stddev', () => {
    const xs = [12, 15, 9, 30, 22, 18]
    const n = xs.length
    const mean = xs.reduce((a, b) => a + b, 0) / n
    const popSd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / n)
    const t = timesFromStatement(n, mean * n, popSd)
    expect(t.sumSq).toBeCloseTo(sums(xs).sumSq, 9)
    expect(sampleVariance(t)).toBeCloseTo(sampleVariance(sums(xs)), 9)
  })

  it('takes the calls between two readings, and all of them when the count went backwards', () => {
    const earlier = sums([10, 20, 30])
    const later = addTimes(earlier, sums([5, 5]))
    expect(timesSince(earlier, later)).toEqual(sums([5, 5]))
    // Evicted and counted again from zero since `earlier`.
    expect(timesSince(sums([1, 1, 1, 1]), sums([7, 9]))).toEqual(sums([7, 9]))
    expect(timesSince(undefined, sums([3]))).toEqual(sums([3]))
  })
})
