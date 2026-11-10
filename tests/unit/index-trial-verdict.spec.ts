/**
 * The verdict on an index Backenly built on its own (lib/autonomy/
 * index-trials.ts): kept only when the queries it was built for got faster
 * beyond noise; removed when it made them slower, was never used, cost writes
 * more than it saved, or showed nothing in 72 hours. Pure: no database.
 */

import {
  accumulate,
  attemptsOf,
  buildWaitOf,
  judgeTrial,
  TRIAL_MAX_MS,
  TRIAL_MIN_MS,
  type TrialEntry,
  type TrialReading,
} from '@/lib/autonomy/index-trials'
import type { TimeSums } from '@/lib/autonomy/index-trial-stats'

const BUILT = Date.parse('2026-11-09T10:00:00.000Z')
const MIN = 60_000

/**
 * n calls with this mean and (population) standard deviation, touching this
 * many shared pages each, as pg_stat_statements keeps them.
 */
const calls = (n: number, mean: number, sd: number, pages = 2000): TimeSums => ({
  n,
  sum: n * mean,
  sumSq: n * (sd * sd + mean * mean),
  blocks: n * pages,
})

function reading(over: Partial<TrialReading> = {}): TrialReading {
  return {
    at: new Date(BUILT).toISOString(),
    statements: 'ok',
    statsReset: '2026-11-01T00:00:00.000Z',
    tableOid: '16384',
    index: { valid: true, scans: 0 },
    reads: {},
    writes: {},
    ...over,
  }
}

/** A trial whose before side is 200 calls at 120 ms ± 20, with `since` already accumulated. */
function trial(since: { reads?: Record<string, TimeSums>; writes?: Record<string, TimeSums>; scans?: number }, writesBefore: Record<string, TimeSums> = {}): TrialEntry {
  return {
    v: 1,
    table: 'orders',
    column: 'customer_ref',
    status: 'observing',
    indexName: 'idx_orders_customer_ref',
    builtAt: new Date(BUILT).toISOString(),
    before: { reads: { q1: calls(200, 120, 20) }, writes: writesBefore },
    since: { reads: since.reads ?? {}, writes: since.writes ?? {}, scans: since.scans ?? 0 },
    last: reading(),
  }
}

const at = (ms: number) => BUILT + ms

describe('a regression is acted on at once', () => {
  it('removes an index that made the measured queries slower, even inside the first 30 minutes', () => {
    const j = judgeTrial(trial({ reads: { q1: calls(40, 300, 40) }, scans: 40 }), reading(), at(10 * MIN))
    expect(j.kind).toBe('remove')
    expect(j.kind === 'remove' && j.why).toBe('regressed')
    expect(j.kind === 'remove' && j.finding).toContain('120 ms before, 300 ms since (40 queries)')
  })

  it('does not call noise a regression', () => {
    const j = judgeTrial(trial({ reads: { q1: calls(40, 124, 20) }, scans: 40 }), reading(), at(10 * MIN))
    expect(j.kind).toBe('observe')
  })
})

describe('nothing else is decided in the first 30 minutes', () => {
  it('waits even when the queries are already much faster', () => {
    const j = judgeTrial(trial({ reads: { q1: calls(40, 2, 0.5) }, scans: 40 }), reading(), at(TRIAL_MIN_MS - MIN))
    expect(j.kind).toBe('observe')
  })
})

describe('after 30 minutes', () => {
  it('keeps an index that made the measured queries faster, and says by how much', () => {
    const j = judgeTrial(trial({ reads: { q1: calls(40, 2, 0.5) }, scans: 40 }), reading(), at(31 * MIN))
    expect(j.kind).toBe('keep')
    expect(j.kind === 'keep' && j.finding).toBe('queries filtering orders.customer_ref went from 120 ms to 2.0 ms on average (40 queries measured)')
  })

  it('removes an index PostgreSQL never used', () => {
    const j = judgeTrial(trial({ reads: { q1: calls(40, 118, 20) }, scans: 0 }), reading(), at(31 * MIN))
    expect(j.kind === 'remove' && j.why).toBe('unused')
    expect(j.kind === 'remove' && j.finding).toContain('did not use it for any of the 40 queries')
  })

  it('removes an index whose write cost is larger than the query time it saved', () => {
    // Reads 120 → 100 ms over 40 calls saves 800 ms; writes 2 → 3 ms over 5,000 calls adds 5 s.
    const j = judgeTrial(
      trial({ reads: { q1: calls(40, 100, 20) }, writes: { w1: calls(5000, 3, 0.5) }, scans: 40 }, { w1: calls(500, 2, 0.5) }),
      reading(),
      at(31 * MIN),
    )
    expect(j.kind === 'remove' && j.why).toBe('net_cost')
    expect(j.kind === 'remove' && j.finding).toBe('it saved 800 ms of query time and added 5.0 s to writes on orders')
  })

  it('keeps an index whose savings outweigh a measured write cost', () => {
    const j = judgeTrial(
      trial({ reads: { q1: calls(400, 2, 0.5) }, writes: { w1: calls(5000, 3, 0.5) }, scans: 400 }, { w1: calls(500, 2, 0.5) }),
      reading(),
      at(31 * MIN),
    )
    expect(j.kind).toBe('keep')
  })

  it('keeps waiting while the index is used but no faster, until 72 hours', () => {
    const t = trial({ reads: { q1: calls(40, 118, 20) }, scans: 40 })
    expect(judgeTrial(t, reading(), at(31 * MIN)).kind).toBe('observe')
    const j = judgeTrial(t, reading(), at(TRIAL_MAX_MS))
    expect(j.kind === 'remove' && j.why).toBe('no_improvement')
    expect(j.kind === 'remove' && j.finding).toContain('were not measurably faster in the 72 hours')
  })

  it('removes an index too few queries ran against in 72 hours to show it helps', () => {
    const j = judgeTrial(trial({ reads: { q1: calls(5, 2, 0.5) }, scans: 5 }), reading(), at(TRIAL_MAX_MS))
    expect(j.kind === 'remove' && j.why).toBe('no_improvement')
    expect(j.kind === 'remove' && j.finding).toContain('only 5 queries filtered orders.customer_ref')
  })

  it('removes an index nobody could measure, at 72 hours and not before', () => {
    expect(judgeTrial(trial({}), reading({ statements: 'missing' }), at(2 * 3_600_000)).kind).toBe('observe')
    const j = judgeTrial(trial({}), reading({ statements: 'missing' }), at(TRIAL_MAX_MS))
    expect(j.kind === 'remove' && j.why).toBe('unmeasurable')
  })
})

describe('the index is credited or blamed only for what it changed', () => {
  it('keeps an index whose scans were not reported yet, when its queries read far fewer pages', () => {
    // Backends report index scans late; pages per call are recorded as each statement ends.
    const j = judgeTrial(trial({ reads: { q1: calls(40, 2, 0.5, 4) }, scans: 0 }), reading(), at(31 * MIN))
    expect(j.kind).toBe('keep')
  })

  it('does not credit an unused index for a warmer cache', () => {
    // Faster, but the same pages per call and no scans: the plan did not change.
    const j = judgeTrial(trial({ reads: { q1: calls(40, 60, 10) }, scans: 0 }), reading(), at(31 * MIN))
    expect(j.kind === 'remove' && j.why).toBe('unused')
  })

  it('does not blame an index for a slowdown it had no part in', () => {
    const j = judgeTrial(trial({ reads: { q1: calls(40, 300, 40) }, scans: 0 }), reading(), at(10 * MIN))
    expect(j.kind).toBe('observe')
  })
})

describe('the trial ends when what it measures is gone', () => {
  it('ends when someone removed the index', () => {
    const j = judgeTrial(trial({}), reading({ index: null }), at(31 * MIN))
    expect(j.kind === 'ended' && j.why).toBe('index_gone')
  })

  it('ends when the table was dropped and created again', () => {
    const j = judgeTrial(trial({}), reading({ tableOid: '99999' }), at(31 * MIN))
    expect(j.kind === 'ended' && j.why).toBe('table_recreated')
  })
})

describe('calls since the build are counted pass by pass', () => {
  const base = (): TrialEntry => ({ ...trial({}), last: reading({ reads: { q1: calls(200, 120, 20) }, index: { valid: true, scans: 3 } }) })

  it('adds what each pass counted since the previous one', () => {
    const next = accumulate(base(), reading({ reads: { q1: calls(230, 120 * 200 / 230 + 2 * 30 / 230, 1) }, index: { valid: true, scans: 33 } }))
    expect(next.since!.reads.q1.n).toBe(30)
    expect(next.since!.scans).toBe(30)
  })

  it('counts everything after a statistics reset as new', () => {
    const next = accumulate(base(), reading({ statsReset: '2026-11-09T11:00:00.000Z', reads: { q1: calls(12, 2, 0.5) } }))
    expect(next.since!.reads.q1.n).toBe(12)
  })

  it('counts an entry that was evicted and started again as new', () => {
    const next = accumulate(base(), reading({ reads: { q1: calls(7, 2, 0.5) } }))
    expect(next.since!.reads.q1.n).toBe(7)
  })

  it('compares only statements that were measured before the build', () => {
    const next = accumulate(base(), reading({ reads: { q1: calls(200, 120, 20), q9: calls(50, 1, 0.1) } }))
    expect(next.since!.reads.q9).toBeUndefined()
  })
})

describe('what the authority decision is told', () => {
  const removedEntry = (status: TrialEntry['status'], untilMs: number): TrialEntry => ({
    ...trial({}),
    status,
    verdict: { why: 'unused', finding: 'PostgreSQL did not use it', decidedAt: new Date(at(3 * 86_400_000)).toISOString() },
    cooldownUntil: new Date(untilMs).toISOString(),
  })

  it('reports a removal until its cooldown ends, and by whom', () => {
    const now = at(4 * 86_400_000)
    expect(attemptsOf(removedEntry('undone', at(33 * 86_400_000)), now).removed?.by).toBe('backenly')
    expect(attemptsOf(removedEntry('ended', at(33 * 86_400_000)), now).removed?.by).toBe('someone_else')
    expect(attemptsOf(removedEntry('undone', at(3.5 * 86_400_000)), now).removed).toBeNull()
  })

  it('paces a failed build: an hour after the first, four after the second, then a person', () => {
    const failed = (n: number, ago: number): TrialEntry => ({
      v: 1,
      table: 'orders',
      column: 'customer_ref',
      status: 'build_failed',
      failures: Array.from({ length: n }, () => ({ at: new Date(Date.now() - ago).toISOString(), reason: 'lock timeout' })),
    })
    expect(buildWaitOf(failed(1, 10 * MIN))).toContain('Backenly will try again after')
    expect(buildWaitOf(failed(1, 61 * MIN))).toBeNull()
    expect(buildWaitOf(failed(2, 61 * MIN))).not.toBeNull()
    expect(buildWaitOf(failed(2, 241 * MIN))).toBeNull()
    // Three in a row: the decision hands it to a person; no timer.
    expect(buildWaitOf(failed(3, 10 * MIN))).toBeNull()
    expect(attemptsOf(failed(3, 10 * MIN)).failures).toBe(3)
  })
})
