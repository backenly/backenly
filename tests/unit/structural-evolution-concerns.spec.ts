/**
 * STRUCTURAL EVOLUTION — the decision, without a database
 * =======================================================
 *
 * The engine's judgement lives in pure functions so it can be held here, input
 * by input. What these pin is mostly what must NOT happen:
 *
 *   - churn can never fire a proposal (the gate cannot even see it)
 *   - names alone never prove a concern
 *   - a measured contradiction beats any amount of agreement
 *   - a dense concern is never split
 *   - a blind instrument is reported as blind, not as "found nothing"
 *
 * The database half — sampling, history, the ladder itself — is
 * tests/integration/structural-evolution.spec.ts.
 */

import {
  analyzeTable,
  firesConcernExtraction,
  isCohesive,
  partitionColumns,
  priorityOf,
  type ColumnHistory,
  type PresenceSample,
  type TableAnalysisInput,
} from '@/lib/structural-evolution/concerns'
import { defaultSatelliteName, plural, readName, singular, stem } from '@/lib/structural-evolution/lexicon'
import { columnHistory } from '@/lib/structural-evolution/sensing'
import { col, ordersFacts } from '../helpers/structural-evolution-fixtures'

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * 200 rows. Refunds on rows 0-39 (all three columns together), coupons on rows
 * 0-59 and discounts on rows 100-159 (never together), shipping on rows 0-79.
 */
function presence(columns: string[], lagSeconds = 2 * 86_400): PresenceSample {
  const setOn: Record<string, (i: number) => boolean> = {
    refund_amount: i => i < 40,
    refund_reason: i => i < 40,
    refunded_at: i => i < 40,
    coupon_code: i => i < 60,
    discount_amount: i => i >= 100 && i < 160,
    shipping_address: i => i < 80,
    shipping_method: i => i < 80,
  }
  const rows = Array.from({ length: 200 }, (_, i) => columns.map(c => (setOn[c]?.(i) ? '1' : '0')).join(''))
  return {
    columns,
    rows,
    lags: { refunded_at: Array.from({ length: 40 }, () => lagSeconds) },
    creationColumn: 'created_at',
    method: 'full',
  }
}

const NOW = new Date('2026-10-01T00:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

/** v1 the table, v2 refunds bolted on 60 days ago, v3 coupons + discounts 20 days ago. */
function history(): ColumnHistory {
  return {
    available: true,
    hostBirthVersion: 1,
    births: {
      id: { version: 1, at: daysAgo(400) },
      user_id: { version: 1, at: daysAgo(400) },
      total: { version: 1, at: daysAgo(400) },
      status: { version: 1, at: daysAgo(400) },
      created_at: { version: 1, at: daysAgo(400) },
      shipping_address: { version: 1, at: daysAgo(400) },
      shipping_method: { version: 1, at: daysAgo(400) },
      refund_amount: { version: 2, at: daysAgo(60) },
      refund_reason: { version: 2, at: daysAgo(60) },
      refunded_at: { version: 2, at: daysAgo(60) },
      coupon_code: { version: 3, at: daysAgo(20) },
      discount_amount: { version: 3, at: daysAgo(20) },
    },
    events: [
      { version: 2, at: daysAgo(60), columns: ['refund_amount', 'refund_reason', 'refunded_at'], kinds: ['added'] },
      { version: 3, at: daysAgo(20), columns: ['coupon_code', 'discount_amount'], kinds: ['added'] },
    ],
  }
}

function input(over: Partial<TableAnalysisInput> = {}): TableAnalysisInput {
  const facts = over.facts ?? ordersFacts()
  const { eligible } = partitionColumns(facts)
  return {
    facts,
    presence: presence(eligible),
    history: history(),
    pressure: { windowDays: 90, repairs: [], hostRequests: 5_000, consumers: [], now: NOW },
    ...over,
  }
}

const concern = (r: ReturnType<typeof analyzeTable>, member: string) => r.concerns.find(c => c.members.includes(member))

// ── Lexicon ──────────────────────────────────────────────────────────────────

describe('the lexicon', () => {
  it.each([
    ['refunded', 'refund'],
    ['refunds', 'refund'],
    ['shipping', 'ship'],
    ['shipped', 'ship'],
    ['coupons', 'coupon'],
    ['address', 'address'],
    ['billing', 'bill'],
    ['categories', 'category'],
  ])('stems %s to %s', (word, expected) => {
    expect(stem(word)).toBe(expected)
  })

  it('reads a qualifier past to the concern, and refuses to name the row itself', () => {
    expect(readName('is_refunded', 'order').stem).toBe('refund')
    expect(readName('refundedAt', 'order').stem).toBe('refund')
    expect(readName('status', 'order').stem).toBeNull()
    expect(readName('created_at', 'order').stem).toBeNull()
    expect(readName('order_number', 'order').stem).toBeNull()
    expect(readName('user_id', 'order').stem).toBeNull()
  })

  it('names the satellite the way a person would', () => {
    expect(singular('orders')).toBe('order')
    expect(singular('addresses')).toBe('address')
    expect(plural('refund')).toBe('refunds')
    expect(plural('shipping')).toBe('shipping')
    expect(defaultSatelliteName('orders', 'refund')).toBe('order_refunds')
    expect(defaultSatelliteName('categories', 'translation')).toBe('category_translations')
  })

  it('sees numbered copies of one field', () => {
    expect(readName('coupon_1', null)).toMatchObject({ ordinal: 1, ordinalBase: 'coupon' })
    expect(readName('coupon2_code', null)).toMatchObject({ ordinal: 2, ordinalBase: 'coupon_code' })
  })
})

// ── The gate ─────────────────────────────────────────────────────────────────

describe('the firing gate', () => {
  const base = { supporting: ['lexical', 'co_presence'] as const, contradicting: [] as never[], separable: true, dense: false, pressureCount: 1 }

  it('cannot see churn — the signature has no place for it', () => {
    // A compile-time property, asserted at runtime so a refactor that adds a
    // churn parameter has to delete this test to do it.
    expect(firesConcernExtraction.length).toBe(1)
    const keys = ['supporting', 'contradicting', 'separable', 'dense', 'pressureCount']
    expect(Object.keys({ ...base }).sort()).toEqual(keys.sort())
  })

  it('fires on cohesion, separability and a measured cost', () => {
    expect(firesConcernExtraction({ ...base, supporting: [...base.supporting] })).toBe(true)
  })

  it('never fires on names alone, however many columns agree', () => {
    expect(isCohesive(['lexical'], [])).toBe(false)
    expect(isCohesive(['lexical', 'lexical'], [])).toBe(false)
  })

  it('needs something measured, and is vetoed by a measured contradiction', () => {
    expect(isCohesive(['lexical', 'cohort'], [])).toBe(true)
    expect(isCohesive(['cohort', 'reference'], [])).toBe(true)
    expect(isCohesive(['lexical', 'cohort', 'lifecycle'], ['co_presence'])).toBe(false)
  })

  it('does not fire without pressure, on a dense concern, or when inseparable', () => {
    const s = [...base.supporting]
    expect(firesConcernExtraction({ ...base, supporting: s, pressureCount: 0 })).toBe(false)
    expect(firesConcernExtraction({ ...base, supporting: s, dense: true })).toBe(false)
    expect(firesConcernExtraction({ ...base, supporting: s, separable: false })).toBe(false)
  })

  it('ranks by churn only among proposals that already fired', () => {
    const quiet = priorityOf({ pressureCount: 1, changeEvents: 0, consumers: 0, presenceRate: 0.2, supportingFamilies: 2 })
    const busy = priorityOf({ pressureCount: 1, changeEvents: 6, consumers: 0, presenceRate: 0.2, supportingFamilies: 2 })
    expect(busy.score).toBeGreaterThan(quiet.score)
  })
})

// ── The analysis ─────────────────────────────────────────────────────────────

describe('analysing orders', () => {
  it('keeps the row itself in place and offers only optional, named data', () => {
    const { core, eligible } = partitionColumns(ordersFacts())
    expect(core).toEqual(expect.arrayContaining(['id', 'user_id', 'total', 'status', 'created_at']))
    expect(eligible).toEqual(
      expect.arrayContaining(['refund_amount', 'refund_reason', 'refunded_at', 'coupon_code', 'discount_amount']),
    )
    expect(eligible).not.toContain('status')
  })

  it('proposes refunds, on four independent families and a hot-table change', () => {
    const r = analyzeTable(input())
    const refunds = concern(r, 'refund_amount')!
    expect(refunds.members).toEqual(['refund_amount', 'refund_reason', 'refunded_at'])
    expect(refunds.fires).toBe(true)
    expect(refunds.label).toBe('refund')
    expect(refunds.defaultSatellite).toBe('order_refunds')
    const verdicts = Object.fromEntries(refunds.families.map(f => [f.family, f.verdict]))
    expect(verdicts).toEqual({
      lexical: 'supports',
      co_presence: 'supports',
      cohort: 'supports',
      lifecycle: 'supports',
      reference: 'silent',
    })
    expect(refunds.pressure.map(p => p.kind)).toEqual(['hot_host_change'])
    expect(refunds.presenceRate).toBeCloseTo(0.2)
    expect(refunds.shape).toBe('optional_one_to_one')
  })

  it('does not group coupons with discounts: they arrived together and are set on different rows', () => {
    const r = analyzeTable(input())
    const mixed = r.concerns.find(c => c.members.includes('coupon_code') && c.members.includes('discount_amount'))
    expect(mixed).toBeDefined()
    expect(mixed!.families.find(f => f.family === 'co_presence')!.verdict).toBe('contradicts')
    expect(mixed!.cohesive).toBe(false)
    expect(mixed!.fires).toBe(false)
    expect(mixed!.verdict).toMatch(/co_presence measured that these columns do not belong together/)
  })

  it('watches a cohesive concern that has cost nothing yet', () => {
    const r = analyzeTable(input())
    const shipping = concern(r, 'shipping_address')!
    expect(shipping.cohesive).toBe(true)
    expect(shipping.pressure).toEqual([])
    expect(shipping.fires).toBe(false)
    expect(shipping.verdict).toMatch(/^Watching/)
  })

  it('does not call a busy table under construction a problem: no traffic, no proposal', () => {
    const r = analyzeTable(
      input({
        facts: ordersFacts({ stats: { liveRows: 12, inserts: 0, updates: 0, hotUpdates: 0, deletes: 0, seqScans: 0, idxScans: 0 } }),
        pressure: { windowDays: 90, repairs: [], hostRequests: 3, consumers: [], now: NOW },
      }),
    )
    expect(concern(r, 'refund_amount')!.fires).toBe(false)
    expect(concern(r, 'refund_amount')!.cohesive).toBe(true)
  })

  it('counts repairs on the concern\'s own columns as pressure, even on a quiet table', () => {
    const r = analyzeTable(
      input({
        facts: ordersFacts({ stats: null }),
        pressure: {
          windowDays: 90,
          repairs: [{ findingId: 'f1', type: 'invalid_state', column: 'refund_amount', at: daysAgo(3) }],
          hostRequests: 0,
          consumers: [],
          now: NOW,
        },
      }),
    )
    const refunds = concern(r, 'refund_amount')!
    expect(refunds.pressure.map(p => p.kind)).toEqual(['attributed_repairs'])
    expect(refunds.fires).toBe(true)
  })

  it('reports a blind instrument as unavailable, never as a finding', () => {
    const r = analyzeTable(input({ presence: null, presenceUnavailableReason: 'rows could not be read: timeout' }))
    const refunds = concern(r, 'refund_amount')!
    expect(refunds.families.find(f => f.family === 'co_presence')).toMatchObject({ verdict: 'unavailable', detail: /timeout/ })
    expect(refunds.families.find(f => f.family === 'lifecycle')!.verdict).toBe('unavailable')
    expect(refunds.presenceRate).toBeNull()
    // Lexical + cohort still prove cohesion; the blind probes do not veto it.
    expect(refunds.cohesive).toBe(true)
    expect(r.coverage.presence).toBe('unavailable')
  })

  it('never splits a concern nearly every row carries', () => {
    const facts = ordersFacts()
    const { eligible } = partitionColumns(facts)
    const dense: PresenceSample = {
      ...presence(eligible),
      rows: Array.from({ length: 200 }, (_, i) =>
        eligible.map(c => (c.startsWith('refund') || c === 'refunded_at' ? (i < 195 ? '1' : '0') : '0')).join(''),
      ),
    }
    const refunds = concern(analyzeTable(input({ presence: dense })), 'refund_amount')!
    expect(refunds.shape).toBe('dense_one_to_one')
    expect(refunds.fires).toBe(false)
    expect(refunds.verdict).toMatch(/would add a join to nearly every read/)
  })

  it('refuses to propose on a table without a single-column key', () => {
    const r = analyzeTable(input({ facts: ordersFacts({ primaryKey: [] }) }))
    const refunds = concern(r, 'refund_amount')!
    expect(refunds.fires).toBe(false)
    expect(refunds.separability.expandBlockers.join(' ')).toMatch(/single-column primary key/)
  })

  it('separates what blocks the ladder from what only blocks dropping the columns', () => {
    const facts = ordersFacts({
      dependents: [
        { kind: 'view', object: 'refund_report', column: 'refund_amount' },
        { kind: 'policy', object: 'refunds_visible', column: 'refund_reason' },
      ],
    })
    const refunds = concern(analyzeTable(input({ facts })), 'refund_amount')!
    expect(refunds.separability.expandBlockers).toEqual([])
    expect(refunds.fires).toBe(true)
    expect(refunds.separability.contractBlockers.join('\n')).toMatch(/view refund_report reads refund_amount/)
    expect(refunds.separability.contractBlockers.join('\n')).toMatch(/cannot be enumerated/)
  })
})

// ── History ──────────────────────────────────────────────────────────────────

describe('schema history', () => {
  const snap = (v: number, cols: string[], at = daysAgo(100 - v)) => ({
    versionNum: v,
    createdAt: new Date(at),
    tables: [{ name: 'orders', columns: cols.map(name => ({ name, type: 'text', nullable: true, default: null })) }],
  })

  it('does not claim a column was bolted on when the table predates history', () => {
    const h = columnHistory([snap(1, ['id', 'refund_amount']), snap(2, ['id', 'refund_amount', 'refund_reason'])], 'orders')
    expect(h.hostBirthVersion).toBeNull()
    expect(h.births.refund_amount.version).toBeNull()
    expect(h.births.refund_reason.version).toBe(2)
  })

  it('dates births and changes when the table is born inside it', () => {
    const h = columnHistory(
      [
        { versionNum: 1, createdAt: new Date(daysAgo(200)), tables: [] },
        snap(2, ['id']),
        snap(3, ['id', 'refund_amount']),
        { ...snap(4, ['id', 'refund_amount']), tables: [{ name: 'orders', columns: [{ name: 'id', type: 'text', nullable: true, default: null }, { name: 'refund_amount', type: 'numeric', nullable: true, default: null }] }] },
      ],
      'orders',
    )
    expect(h.hostBirthVersion).toBe(2)
    expect(h.births.refund_amount.version).toBe(3)
    expect(h.events.map(e => [e.version, e.kinds])).toEqual([[3, ['added']], [4, ['altered']]])
  })

  it('is unavailable, not empty, with fewer than two snapshots', () => {
    expect(columnHistory([snap(1, ['id'])], 'orders')).toMatchObject({ available: false })
    expect(columnHistory({ unavailable: 'db down' }, 'orders')).toMatchObject({ available: false, reason: 'db down' })
  })
})
