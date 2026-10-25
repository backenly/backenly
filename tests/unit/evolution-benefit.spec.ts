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
 *   - "beneficial" needing less evidence than "neutral": both need the
 *     existing clients checked, and thin traffic must not hide a decisive rise
 *     in errors (the measurement review's probe C)
 *   - a count that moved within chance (3 → 2) reading as a benefit, or one
 *     benefit that improved hiding another that got worse
 */

import {
  assessBenefit,
  compare,
  binomialAtMost,
  LATENCY_MIN_MS,
  pooledZ,
  RATE_MIN_EVENTS,
  type CorrectnessChecks,
} from '@/lib/evolution-engine/benefit'
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

/** hot_host_change: changes to the concern that locked all of the host, in two equal windows. */
const locks = (before: number, after: number): Measurement => ({
  name: 'refund changes that locked all of orders',
  role: 'benefit',
  unit: 'changes',
  before,
  after,
  better: 'lower',
  samplesBefore: before,
  samplesAfter: after,
  minSamples: 0,
  scope: 'in the 30 days before the change and the 30 days after',
})

/** attributed_repairs: problems found on the concern's columns, in two equal windows. */
const problems = (before: number, after: number): Measurement => ({
  name: 'problems found on refund columns',
  role: 'benefit',
  unit: 'problems',
  before,
  after,
  better: 'lower',
  samplesBefore: before,
  samplesAfter: after,
  minSamples: 0,
  scope: 'problems located on refund_amount in the 30 days before and after',
})

/** The database's own statement time on the host, which watches clients the API does not see. */
const dbTime = (over: Partial<Measurement> = {}): Measurement =>
  latency({ name: 'orders write time in the database', minSamples: 100, population: 'database', ...over })

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

  it('lets a counted benefit be zero after: that is the answer hoped for, and the test says when it is enough', () => {
    expect(compare(problems(6, 0)).direction).toBe('improved')
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

describe('benefits counted in whole events: an exact test between equal windows', () => {
  it('puts each event in either window with even odds, were nothing different', () => {
    expect(binomialAtMost(0, 5)).toBeCloseTo(1 / 32, 10)
    expect(binomialAtMost(2, 5)).toBeCloseTo(16 / 32, 10)
    expect(binomialAtMost(5, 5)).toBe(1)
    // Past a thousand events, the normal approximation.
    expect(binomialAtMost(1000, 2000)).toBeCloseTo(0.509, 2)
  })

  it('calls a fall a benefit only when chance alone rarely gives it', () => {
    expect(compare(locks(5, 0)).direction).toBe('improved') // p = 1/32
    expect(compare(locks(4, 0)).direction).toBe('unchanged') // p = 1/16
    expect(compare(locks(2, 1)).direction).toBe('unchanged')
    expect(compare(problems(10, 2)).direction).toBe('improved') // p ≈ 0.019
    expect(compare(problems(10, 7)).direction).toBe('unchanged')
  })

  it('3 → 2 is chance, and says so (probe A)', () => {
    const c = compare(problems(3, 2))
    expect(c.direction).toBe('unchanged')
    expect(c.text).toBe('problems found on refund columns: 3 → 2, within what chance alone gives')
    expect(assessBenefit(PASS, [latency(), problems(3, 2)]).verdict).toBe('neutral')
  })

  it('has nothing to compare when nothing happened on either side', () => {
    const c = compare(locks(0, 0))
    expect(c).toMatchObject({ direction: 'not_comparable', reason: 'insufficient_sample' })
    expect(c.text).toBe('refund changes that locked all of orders: none before or since, so nothing to compare yet')
  })

  it('reports a benefit that got worse, and does not call the change a regression for it', () => {
    expect(compare(problems(2, 12))).toMatchObject({ direction: 'regressed', role: 'benefit' })
    const r = assessBenefit(PASS, [latency(), problems(2, 12)])
    expect(r.verdict).toBe('neutral')
    expect(r.summary).toBe(
      'It works correctly. Existing apps were unaffected, but what it was made to improve got worse: ' +
        'problems found on refund columns rose from 2 to 12.',
    )
  })

  it('is never beneficial while another benefit it was made for got worse (probe D)', () => {
    const r = assessBenefit(PASS, [latency(), locks(6, 0), problems(2, 12)])
    expect(r.verdict).toBe('neutral')
    expect(r.summary).toBe(
      'It works correctly. Existing apps were unaffected, but what it was made to improve got worse: ' +
        'problems found on refund columns rose from 2 to 12, although refund changes that locked all of orders went from 6 to 0.',
    )
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
    const r = assessBenefit(PASS, [locks(5, 0), latency({ name: 'orders write p95', before: 40, after: 90 })])
    expect(r.verdict).toBe('regressed')
  })

  it('2. …including a decisive rise in errors on fewer requests than a p95 needs (probe C)', () => {
    // 0 of 1,000 requests failing before, 100 of 150 after, and a benefit that
    // improved: it used to be called beneficial because too few requests
    // followed the change for the guardrail to be compared at all.
    const errors = rate(0, 1_000, 100, 150, { population: 'api' })
    const p95 = latency({ name: 'orders write p95', before: 40, after: 900, samplesAfter: 150, population: 'api' })
    const c = compare(errors)
    expect(c.direction).toBe('regressed')
    expect(c.text).toBe('orders server errors: 0% → 66.7%, on few requests (1000 before, 150 after; 200 needed) but beyond chance')
    expect(compare(p95).direction).toBe('not_comparable')
    const r = assessBenefit(PASS, [errors, p95, locks(5, 0)])
    expect(r).toMatchObject({ verdict: 'regressed', safety: 'regressed' })
    expect(r.summary).toBe('It made things worse: orders server errors rose from 0% to 66.7%.')
    // A rise the test does not call decisive is still not decided on so few.
    expect(compare(rate(0, 1_000, 3, 150)).direction).toBe('not_comparable')
  })

  it('3. an improved benefit is beneficial only once existing clients were checked', () => {
    const r = assessBenefit(PASS, [latency(), locks(5, 0)])
    expect(r).toMatchObject({ verdict: 'beneficial', safety: 'held' })
    expect(r.summary).toBe(
      'It works correctly. It helped: refund changes that locked all of orders went from 5 to 0 ' +
        '(in the 30 days before the change and the 30 days after).',
    )
    // Thin traffic: no longer beneficial, and it says why, naming what moved.
    const thin = assessBenefit(PASS, [thinTraffic, locks(5, 0)])
    expect(thin).toMatchObject({ verdict: 'insufficient_evidence', safety: 'unknown' })
    expect(thin.summary).toBe(
      'It works correctly. It may have helped (refund changes that locked all of orders went from 5 to 0), ' +
        'but there is too little traffic so far to show existing apps were unaffected.',
    )
    expect(thin.unmeasured).toEqual(['orders read p95: 240ms → 240ms, too few to judge (30 before, 12 after; 200 needed)'])
  })

  it('4. a measured benefit that did not move, with existing clients checked, is neutral', () => {
    const r = assessBenefit(PASS, [latency(), locks(3, 1)])
    expect(r.verdict).toBe('neutral')
    expect(r.summary).toBe(
      'It works correctly. Existing apps were unaffected, but it has not paid off yet: ' +
        'refund changes that locked all of orders: 3 → 1, within what chance alone gives.',
    )
  })

  it('5. otherwise insufficient evidence, saying why in plain words', () => {
    // The benefit moved nothing, but a guardrail could not be compared.
    const thin = assessBenefit(PASS, [thinTraffic, locks(3, 1)])
    expect(thin.verdict).toBe('insufficient_evidence')
    expect(thin.summary).toBe('It works correctly. Too early to say whether it helped: there is too little traffic so far to show existing apps were unaffected.')

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
    const r = assessBenefit({ ...PASS, correctness: 'not_run' }, [latency(), locks(5, 0)])
    expect(r.verdict).toBe('beneficial')
    expect(r.summary).toMatch(/^Backenly could not confirm its data still matches\. It helped:/)
  })
})

describe('what a person reads by default', () => {
  // `summary` carries the numbers, for whoever opens the details; `plain` is the
  // same verdict without them, for the card, the activity feed and a stop reason.
  const thinTraffic = latency({ samplesBefore: 30, samplesAfter: 12 })
  const cases: Array<[string, ReturnType<typeof assessBenefit>, string]> = [
    ['beneficial', assessBenefit(PASS, [latency(), locks(5, 0), problems(6, 0)]), 'It helped: fewer refund changes that locked all of orders and fewer problems found on refund columns.'],
    ['neutral', assessBenefit(PASS, [latency(), locks(3, 1)]), 'Existing apps were unaffected, but it has not paid off yet.'],
    ['neutral, worse', assessBenefit(PASS, [latency(), locks(1, 9)]), 'Existing apps were unaffected, but what it was made to improve got worse.'],
    ['may have helped', assessBenefit(PASS, [thinTraffic, locks(5, 0)]), 'It may have helped, but it is too early to say.'],
    ['too early', assessBenefit(PASS, [thinTraffic, locks(3, 1)]), 'Too early to say whether it helped.'],
    ['slower', assessBenefit(PASS, [latency({ name: 'orders write p95', before: 40, after: 90 })]), 'It made things worse: requests got slower.'],
    ['slower and failing', assessBenefit(PASS, [latency({ before: 40, after: 90 }), rate(0, 1_000, 100, 1_000)]), 'It made things worse: requests got slower and requests failed more often.'],
    ['data', assessBenefit({ ...PASS, correctness: 'fail' }, []), 'It made things worse: its data stopped matching.'],
  ]

  it.each(cases)('%s: one sentence, and no number in it', (_label, report, plain) => {
    expect(report.plain).toBe(plain)
    expect(report.plain).not.toMatch(/\d/)
  })

  it('says it helped only when the verdict is beneficial', () => {
    for (const [, report] of cases) {
      if (report.verdict !== 'beneficial') expect(report.plain).not.toMatch(/^It helped/)
    }
  })

  it('says the data could not be confirmed, when it could not', () => {
    const r = assessBenefit({ ...PASS, correctness: 'not_run' }, [latency(), locks(5, 0)])
    expect(r.plain).toBe('Backenly could not confirm its data still matches. It helped: fewer refund changes that locked all of orders.')
  })
})

describe('whose traffic must be checked', () => {
  const api = (over: Partial<Measurement> = {}) => latency({ population: 'api', ...over })
  const notServed = (name: string) =>
    api({ name, before: null, after: null, reason: 'table_not_served_over_api', unavailableReason: 'no writes to orders were recorded' })
  const evicted = () => dbTime({ before: null, after: null, reason: 'statements_evicted' })

  it("the API's clients, when the table has them; the database's statements do not then decide (probe F)", () => {
    const r = assessBenefit(PASS, [api(), notServed('orders write p95'), evicted(), locks(5, 0)])
    expect(r).toMatchObject({ verdict: 'beneficial', safety: 'held' })
    // What was not compared is listed, so nobody reads it as checked.
    expect(r.unmeasured).toEqual([
      'orders write p95: not measured (no writes to orders were recorded)',
      'orders write time in the database: not measured (the statement statistics dropped entries in between)',
    ])
  })

  it("the database's statements, when nothing reaches the table over the API", () => {
    const everyApi = [notServed('orders read p95'), notServed('orders write p95')]
    expect(assessBenefit(PASS, [...everyApi, dbTime(), locks(5, 0)])).toMatchObject({ verdict: 'beneficial', safety: 'held' })
    const r = assessBenefit(PASS, [...everyApi, evicted(), locks(5, 0)])
    expect(r).toMatchObject({ verdict: 'insufficient_evidence', safety: 'unknown' })
    expect(r.summary).toBe(
      'It works correctly. It may have helped (refund changes that locked all of orders went from 5 to 0), ' +
        'but orders write time in the database could not be measured.',
    )
  })

  it('holds neutral to exactly the same check as beneficial', () => {
    expect(assessBenefit(PASS, [api({ samplesAfter: 12 }), locks(3, 1)]).verdict).toBe('insufficient_evidence')
    expect(assessBenefit(PASS, [api(), locks(3, 1)]).verdict).toBe('neutral')
  })
})

describe('costs', () => {
  it('are listed in words and never decide the verdict', () => {
    const r = assessBenefit(PASS, [storage(48 * 1024)])
    expect(r.verdict).toBe('insufficient_evidence')
    expect(r.costs).toEqual(['storage taken by order_refunds: 0 B → 48 KB (from zero)'])
    expect(assessBenefit(PASS, [latency(), storage(10 * 1024 ** 3), locks(5, 0)]).verdict).toBe('beneficial')
  })
})
