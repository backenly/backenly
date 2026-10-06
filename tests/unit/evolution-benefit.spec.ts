/**
 * DID THE CHANGE HELP? THE BENEFIT JUDGE, RULE BY RULE
 * ====================================================
 *
 * `assessBenefit` is the only place the engine says a change was beneficial,
 * and it is pure, so every rule is pinned here input by input. Most of what it
 * pins is what must NOT happen:
 *
 *   - a latency or error rate that IMPROVED making a change "beneficial": a
 *     change that only adds work cannot make the host faster, so that is
 *     traffic mix and is shown, never counted
 *   - one extra error on a small denominator reading as a regression
 *   - a 2ms → 3ms request reading as +50% slower
 *   - a number resting on too few samples deciding anything
 *   - "insufficient evidence" being rounded up to "neutral" or "beneficial"
 *   - a benefit that did not pay off being called a regression of the change
 */

import {
  assessBenefit,
  compare,
  COUNT_IMPROVEMENT,
  LATENCY_MIN_MS,
  pooledZ,
  RATE_MIN_EVENTS,
  type CorrectnessChecks,
} from '@/lib/evolution-engine/benefit'
import { MATERIAL_CHANGE } from '@/lib/autonomy/maintenance/outcome'
import type { Measurement } from '@/lib/evolution-engine/primitive'

const PASS: CorrectnessChecks = { correctness: 'pass', compatibility: 'pass', authorization: 'pass' }

/** A request-latency guardrail on a busy table. */
const latency = (over: Partial<Measurement> = {}): Measurement => ({
  name: 'orders read p95',
  role: 'guardrail',
  unit: 'ms',
  before: 240,
  after: 240,
  better: 'lower',
  samplesBefore: 5_000,
  samplesAfter: 5_000,
  minSamples: 200,
  scope: 'requests to orders',
  ...over,
})

/** A server-error-rate guardrail: before/after are rates, samples are requests, events are errors. */
const rate = (eb: number, nb: number, ea: number, na: number, over: Partial<Measurement> = {}): Measurement => ({
  name: 'orders server errors',
  role: 'guardrail',
  unit: 'ratio',
  before: eb / nb,
  after: ea / na,
  better: 'lower',
  samplesBefore: nb,
  samplesAfter: na,
  eventsBefore: eb,
  eventsAfter: ea,
  minSamples: 200,
  scope: 'requests to orders',
  ...over,
})

/** hot_host_change: of `total` concern changes since, `onHost` still locked the host. */
const locks = (total: number, onHost: number): Measurement => ({
  name: 'refund changes that locked orders',
  role: 'benefit',
  unit: 'changes',
  before: total,
  after: onHost,
  better: 'lower',
  samplesBefore: total,
  samplesAfter: total,
  minSamples: 1,
  scope: `${total} change(s) to refund since the change: ${total - onHost} on order_refunds, ${onHost} on orders`,
})

/** attributed_repairs: repairs on the concern's columns in equal windows. */
const repairs = (before: number, after: number): Measurement => ({
  name: 'repairs on refund columns',
  role: 'benefit',
  unit: 'repairs',
  before,
  after,
  better: 'lower',
  samplesBefore: before,
  samplesAfter: null,
  minSamples: 3,
  scope: 'repairs located on refund_amount in the 30 days before and after',
})

const storage = (bytes: number): Measurement => ({
  name: 'storage taken by order_refunds',
  role: 'cost',
  unit: 'bytes',
  before: 0,
  after: bytes,
  better: 'lower',
  samplesBefore: null,
  samplesAfter: null,
  minSamples: 0,
  scope: 'order_refunds with its indexes',
})

// ── Guardrails can only regress ──────────────────────────────────────────────

describe('guardrails', () => {
  it('shows a latency improvement with its numbers, and never calls the change beneficial for it', () => {
    const faster = latency({ after: 165 })
    const c = compare(faster)
    expect(c).toMatchObject({ direction: 'improved', role: 'guardrail' })
    expect(c.text).toBe('orders read p95: 240ms → 165ms (-31%)')

    expect(assessBenefit(PASS, [faster]).verdict).toBe('insufficient_evidence')
    // Next to a benefit that was measured and did not move: neutral, still not beneficial.
    expect(assessBenefit(PASS, [faster, locks(2, 1)]).verdict).toBe('neutral')
  })

  it('never calls the change beneficial for a lower error rate either', () => {
    const fewer = rate(300, 20_000, 40, 20_000)
    expect(compare(fewer).direction).toBe('improved')
    expect(assessBenefit(PASS, [fewer]).verdict).toBe('insufficient_evidence')
  })

  it('says how it got worse, in a sentence a business owner reads', () => {
    const r = assessBenefit(PASS, [latency({ name: 'orders write p95', before: 40, after: 90 })])
    expect(r.verdict).toBe('regressed')
    expect(r.summary).toBe('It made things worse: orders write p95 rose from 40ms to 90ms.')
  })
})

describe('latency (ms): slower only by a ratio AND a floor', () => {
  it('needs both 1.25× and +20ms', () => {
    expect(compare(latency({ before: 40, after: 90 })).direction).toBe('regressed')
    // +100% but only +10ms: whole-millisecond durations make small numbers jumpy.
    expect(compare(latency({ before: 10, after: 20 })).direction).toBe('unchanged')
    // +40ms but only 1.17×.
    expect(compare(latency({ before: 240, after: 280 })).direction).toBe('unchanged')
    expect(compare(latency({ before: 80, after: 80 + LATENCY_MIN_MS })).direction).toBe('regressed')
    expect(compare(latency({ before: 100, after: 95 })).direction).toBe('unchanged')
    expect(compare(latency({ before: 100, after: 115 })).direction).toBe('unchanged')
  })
})

describe('rates (ratio): events, an absolute rise and a z-test, all three', () => {
  it('does not regress on one extra error in two hundred', () => {
    expect(compare(rate(0, 200, 1, 200)).direction).toBe('unchanged')
  })

  it('needs at least five bad events after', () => {
    // 0% → 2% is a big absolute rise, but on four errors.
    expect(compare(rate(0, 200, RATE_MIN_EVENTS - 1, 200)).direction).toBe('unchanged')
  })

  it('needs half a percentage point, however certain', () => {
    // Very significant on a busy table, but 0.1% → 0.3% is not a change a person would act on.
    const r = rate(20, 20_000, 60, 20_000)
    expect(Math.abs(pooledZ(20, 20_000, 60, 20_000))).toBeGreaterThan(3)
    expect(compare(r).direction).toBe('unchanged')
  })

  it('needs z ≥ 3: a point higher on two hundred requests is chance', () => {
    expect(pooledZ(4, 200, 6, 200)).toBeLessThan(3)
    expect(compare(rate(4, 200, 6, 200)).direction).toBe('unchanged')
  })

  it('regresses when all three hold', () => {
    expect(compare(rate(200, 20_000, 320, 20_000)).direction).toBe('regressed')
    expect(compare(rate(5, 5_000, 45, 5_000)).direction).toBe('regressed')
    expect(compare(rate(5, 5_000, 15, 5_000)).direction).toBe('unchanged')
    const r = assessBenefit(PASS, [rate(5, 5_000, 45, 5_000)])
    expect(r.summary).toBe('It made things worse: orders server errors rose from 0.1% to 0.9%.')
  })

  it('shows a rate move in percentage points', () => {
    expect(compare(rate(5, 5_000, 45, 5_000)).text).toBe('orders server errors: 0.1% → 0.9% (+0.8 points)')
  })
})

describe('other units: a relative move of 20%', () => {
  it('applies to a guardrail with no rule of its own', () => {
    const m = (after: number) => latency({ name: 'orders size', unit: 'bytes', before: 100_000, after })
    expect(compare(m(119_000)).direction).toBe('unchanged')
    expect(compare(m(120_000)).direction).toBe('regressed')
  })
})

// ── Samples ──────────────────────────────────────────────────────────────────

describe('samples', () => {
  it('refuses to compare below the measurement\'s own minimum, on either side, and shows the counts', () => {
    const thinAfter = compare(latency({ before: 40, after: 400, samplesAfter: 199 }))
    expect(thinAfter.direction).toBe('not_comparable')
    expect(thinAfter.reason).toBe('insufficient_sample')
    expect(thinAfter.text).toBe('orders read p95: 40ms → 400ms, too few to judge (5000 before, 199 after; 200 needed)')
    expect(compare(latency({ before: 40, after: 400, samplesBefore: 12 })).direction).toBe('not_comparable')
    // The same numbers on a measurement that needs fewer samples do decide.
    expect(compare(latency({ before: 40, after: 400, samplesBefore: 12, samplesAfter: 12, minSamples: 10 })).direction).toBe('regressed')
  })

  it('never compares a guardrail whose sample size is unknown', () => {
    expect(compare(latency({ before: 40, after: 400, samplesAfter: null })).direction).toBe('not_comparable')
  })

  it('lets a benefit side without a sample size be zero: that is the answer hoped for', () => {
    expect(compare(repairs(6, 0)).direction).toBe('improved')
  })

  it('never claims anything it could not measure', () => {
    expect(assessBenefit(PASS, []).verdict).toBe('insufficient_evidence')
    const missing = assessBenefit(PASS, [latency({ after: null, reason: 'request_log_unreadable', unavailableReason: 'request log unreadable' })])
    expect(missing.verdict).toBe('insufficient_evidence')
    expect(missing.comparisons[0].text).toBe('orders read p95: not measured (request log unreadable)')
    expect(missing.unmeasured).toEqual(['orders read p95: not measured (request log unreadable)'])
    // Without a detail, the closed-set reason is put into words.
    expect(compare(latency({ before: null, reason: 'window_aged_out' })).text).toBe(
      'orders read p95: not measured (the request log no longer holds that period)',
    )
  })
})

// ── Benefits ─────────────────────────────────────────────────────────────────

describe('benefits counted in whole events', () => {
  it('hot_host_change: beneficial only when every change since stayed off the host', () => {
    expect(compare(locks(2, 0)).direction).toBe('improved')
    expect(compare(locks(2, 1)).direction).toBe('unchanged')
    expect(compare(locks(1, 1)).direction).toBe('unchanged')
    expect(compare(locks(0, 0)).direction).toBe('not_comparable')
  })

  it('attributed_repairs: needs three incidents before, and a 30% fall', () => {
    expect(COUNT_IMPROVEMENT.repairs).toBe(MATERIAL_CHANGE)
    expect(compare(repairs(10, 7)).direction).toBe('improved')
    expect(compare(repairs(10, 8)).direction).toBe('unchanged')
    const thin = compare(repairs(2, 0))
    expect(thin.direction).toBe('not_comparable')
    expect(thin.text).toBe('repairs on refund columns: 2 → 0, too few to judge (2 before; 3 needed)')
  })

  it('reports a benefit that did not pay off, and does not call the change a regression for it', () => {
    const worse = compare(repairs(3, 5))
    expect(worse).toMatchObject({ direction: 'regressed', role: 'benefit' })
    expect(assessBenefit(PASS, [repairs(3, 5)]).verdict).toBe('neutral')
  })

  it('any other benefit: a 10% move', () => {
    const hot = (after: number): Measurement => ({ ...latency(), name: 'orders HOT updates', role: 'benefit', unit: 'ratio', better: 'higher', before: 0.5, after })
    expect(compare(hot(0.55)).direction).toBe('improved')
    expect(compare(hot(0.54)).direction).toBe('unchanged')
  })
})

// ── The verdict ──────────────────────────────────────────────────────────────

describe('the verdict, in order of precedence', () => {
  const thinTraffic = latency({ samplesBefore: 30, samplesAfter: 12 })

  it('1. a failed correctness check outranks every number', () => {
    const r = assessBenefit({ ...PASS, authorization: 'fail' }, [locks(2, 0)])
    expect(r).toMatchObject({ verdict: 'regressed', summary: 'It made things worse: who may read or change the data did not stay the same.' })
    expect(assessBenefit({ ...PASS, correctness: 'fail', compatibility: 'fail' }, []).summary).toBe(
      'It made things worse: its data stopped matching and a problem showed up while it was being watched.',
    )
  })

  it('2. a regressed guardrail outranks an improved benefit', () => {
    const r = assessBenefit(PASS, [locks(2, 0), latency({ name: 'orders write p95', before: 40, after: 90 })])
    expect(r.verdict).toBe('regressed')
  })

  it('3. an improved benefit is beneficial, even when traffic was too thin for the guardrails', () => {
    const r = assessBenefit(PASS, [thinTraffic, locks(2, 0)])
    expect(r.verdict).toBe('beneficial')
    expect(r.summary).toBe(
      'It works correctly. It helped: refund changes that locked orders went from 2 to 0 ' +
        '(2 change(s) to refund since the change: 2 on order_refunds, 0 on orders).',
    )
    // …and says what was not checked, so nobody reads the guardrails as passed.
    expect(r.unmeasured).toEqual(['orders read p95: 240ms → 240ms, too few to judge (30 before, 12 after; 200 needed)'])
  })

  it('4. a measured benefit that did not move, with every guardrail compared, is neutral', () => {
    const r = assessBenefit(PASS, [latency(), locks(3, 1)])
    expect(r.verdict).toBe('neutral')
    expect(r.summary).toMatch(/^It works correctly\. Nothing got worse, but what it was made to improve has not improved yet: refund changes that locked orders: 3 → 1/)
  })

  it('5. otherwise insufficient evidence, saying why in plain words', () => {
    // The benefit moved nothing, but a guardrail could not be compared.
    const thin = assessBenefit(PASS, [thinTraffic, locks(3, 1)])
    expect(thin.verdict).toBe('insufficient_evidence')
    expect(thin.summary).toBe('It works correctly. Too early to say whether it helped: too little traffic so far to rule out a slowdown.')

    // The concern has not changed since: the saving has not had a chance to show.
    const quiet = assessBenefit(PASS, [
      latency(),
      {
        ...locks(0, 0),
        before: null,
        after: null,
        reason: 'insufficient_sample',
        unavailableReason: 'refund has not changed since the change; the saving shows when it does',
      },
    ])
    expect(quiet.verdict).toBe('insufficient_evidence')
    expect(quiet.summary).toBe(
      'It works correctly. Too early to say whether it helped: refund has not changed since the change; the saving shows when it does.',
    )

    // Nothing the change was made to improve is measurable at all.
    expect(assessBenefit(PASS, [latency()]).summary).toBe(
      'It works correctly. Too early to say whether it helped: nothing it was made to improve can be measured here.',
    )
  })

  it('does not say it works correctly when correctness was not checked', () => {
    const r = assessBenefit({ ...PASS, correctness: 'not_run' }, [locks(2, 0)])
    expect(r.verdict).toBe('beneficial')
    expect(r.summary).toMatch(/^Backenly could not confirm its data still matches\. It helped:/)
  })
})

describe('costs', () => {
  it('are listed in words and never decide the verdict', () => {
    const r = assessBenefit(PASS, [storage(48 * 1024)])
    expect(r.verdict).toBe('insufficient_evidence')
    expect(r.costs).toEqual(['storage taken by order_refunds: 0 B → 48 KB (from zero)'])
    expect(assessBenefit(PASS, [storage(10 * 1024 ** 3), locks(1, 0)]).verdict).toBe('beneficial')
  })
})
