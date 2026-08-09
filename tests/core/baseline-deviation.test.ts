/**
 * DEVIATION — the rules that keep a baseline from becoming a noise generator
 * ---------------------------------------------------------------------------
 * This is the first check in the platform that compares against the project's
 * own history rather than a fixed threshold, which makes it the first one that
 * can be wrong in a NEW way: not by missing something, but by firing constantly.
 *
 * Four rules stand between it and that, and each is pinned here:
 *
 *   1. enough history        — a ratio from three data points is arithmetic
 *   2. median, not mean      — one spike must not raise "normal" and mask the
 *                              regression it caused
 *   3. an absolute floor     — 0.2ms → 3ms is 15x and nobody cares
 *   4. stable history        — a subject with two modes has no normal
 *
 * Pure, so this runs in CI with no database and cannot pass vacuously.
 */

import { describe, test, expect } from '@jest/globals'
import {
  judgeDeviation,
  describeDeviation,
  MIN_BASELINE_SAMPLES,
  MAX_BASELINE_SPREAD,
} from '@/lib/autonomy/baseline/deviation'

/** `n` hours of a steady value, with real weight behind each hour. */
const steady = (value: number, n = MIN_BASELINE_SAMPLES + 4) =>
  Array.from({ length: n }, () => ({ value, samples: 100 }))

const judge = (baseline: ReturnType<typeof steady>, current: number, over = {}) =>
  judgeDeviation({ baseline, current, threshold: 3, floor: 25, ...over })

describe('rule 1 — enough history before any claim', () => {
  test('three hours of history says nothing, however extreme the value', () => {
    const v = judge(steady(4, 3), 4000)
    expect(v.kind).toBe('insufficient_history')
    if (v.kind === 'insufficient_history') expect(v.needed).toBe(MIN_BASELINE_SAMPLES)
  })

  test('the window is at least half a day, so a daily cycle fits inside it', () => {
    // Shorter than the cycle and a backend that is quiet overnight reports a
    // regression every morning: the cycle IS its normal.
    expect(MIN_BASELINE_SAMPLES).toBeGreaterThanOrEqual(12)
  })

  test('hours with no observations behind them do not count as history', () => {
    const empty = Array.from({ length: 20 }, () => ({ value: 4, samples: 0 }))
    expect(judge(empty, 400).kind).toBe('insufficient_history')
  })

  test('a baseline of zero is not a regression from nothing to something', () => {
    // A subject that has never been observed doing anything is not regressing
    // when it starts — it is starting to be used.
    expect(judge(steady(0), 500).kind).toBe('insufficient_history')
  })

  test('a subject that is idle much of the time has no rate to regress from', () => {
    // Median zero but genuinely active sometimes. Judging a busy hour against a
    // typical hour of nothing produces a finding every time it is used.
    const mostlyIdle = [
      ...Array.from({ length: 14 }, () => ({ value: 0, samples: 100 })),
      ...Array.from({ length: 6 }, () => ({ value: 900, samples: 100 })),
    ]
    expect(judgeDeviation({ baseline: mostlyIdle, current: 900, threshold: 3, floor: 25 }).kind)
      .toBe('unstable')
  })
})

describe('rule 2 — median, not mean', () => {
  test('one enormous spike in history does not raise "normal"', () => {
    // The mean of this series is ~85ms, so a mean-based baseline would call
    // 120ms normal — and 120ms is exactly the regression being hunted.
    const history = [...steady(4, 15), { value: 1200, samples: 100 }]
    const v = judgeDeviation({ baseline: history, current: 120, threshold: 3, floor: 25 })
    expect(v.kind).toBe('regressed')
    if (v.kind === 'regressed') {
      expect(v.baseline).toBe(4)
      expect(v.ratio).toBe(30)
    }
  })
})

describe('rule 3 — an absolute floor', () => {
  test('a huge ratio on tiny numbers is not reported', () => {
    const v = judge(steady(0.2), 3)
    expect(v.kind).toBe('below_floor')
  })

  test('the same ratio above the floor is reported', () => {
    expect(judge(steady(20), 300).kind).toBe('regressed')
  })
})

describe('rule 4 — a subject with no normal has nothing to deviate from', () => {
  test('a bimodal history is reported as unstable, not as a regression', () => {
    // Quiet hours at 2ms, busy hours at 200ms. Against the median this fires on
    // every busy hour forever.
    const bimodal = [
      ...Array.from({ length: 10 }, () => ({ value: 2, samples: 100 })),
      ...Array.from({ length: 10 }, () => ({ value: 200, samples: 100 })),
    ]
    const v = judgeDeviation({ baseline: bimodal, current: 200, threshold: 3, floor: 25 })
    expect(v.kind).toBe('unstable')
    if (v.kind === 'unstable') expect(v.spreadRatio).toBeGreaterThan(MAX_BASELINE_SPREAD)
  })

  test('ordinary variation still counts as stable', () => {
    const wobbly = Array.from({ length: 20 }, (_, i) => ({
      value: 10 + (i % 5) * 2, // 10..18
      samples: 100,
    }))
    expect(judgeDeviation({ baseline: wobbly, current: 12, threshold: 3, floor: 25 }).kind)
      .toBe('normal')
  })
})

describe('the verdicts a healthy backend produces', () => {
  test('unchanged behaviour is normal', () => {
    const v = judge(steady(40), 42)
    expect(v.kind).toBe('normal')
  })

  test('just under the threshold is still normal', () => {
    const v = judge(steady(40), 40 * 2.9)
    expect(v.kind).toBe('normal')
  })

  test('at the threshold it regresses', () => {
    const v = judge(steady(40), 40 * 3)
    expect(v.kind).toBe('regressed')
  })

  test('an improvement is never a finding', () => {
    expect(judge(steady(400), 4).kind).toBe('normal')
  })
})

describe('the sentence a human reads', () => {
  test('carries both numbers, the ratio, and how much history is behind it', () => {
    const v = judge(steady(4), 60)
    expect(v.kind).toBe('regressed')
    if (v.kind !== 'regressed') return
    const line = describeDeviation('The query SELECT …', 'ms', v)
    expect(line).toContain('60.0ms')
    expect(line).toContain('4.0ms')
    expect(line).toContain('15.0×')
    expect(line).toContain(`${v.observations} hours`)
  })
})
