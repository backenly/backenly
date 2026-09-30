/**
 * The pricing page states only what the product does, and only once it can.
 *
 *   - Usage pricing appears only when published (NEXT_PUBLIC_USAGE_PRICING),
 *     which the release turns on with production in shadow mode or later.
 *   - Each rate appears only once the catalog publishes it: a rate is published
 *     when measured cost confirms it sits above its floor. Database is held back
 *     until the backup dumps move to S3 and that cost is measured.
 *   - The rates shown are the rates billed: one catalog feeds both.
 */
import {
  axisBillable,
  egressBillable,
  formatRate,
  includedEgressMb,
  overageCents,
  OVERAGE_RATE_PUBLISHED,
  PRO_INCLUDED,
  proUsagePriceRows,
  usagePricingPublished,
  GIB,
} from '@/lib/pricing/catalog'

describe('charging egress: one switch, and never the direct rate', () => {
  it('is billable only with the explicit flag AND the CDN terms', () => {
    expect(egressBillable({})).toBe(false)
    expect(egressBillable({ BACKENLY_EGRESS_BILLING: 'enabled' })).toBe(false)
    expect(egressBillable({ BACKENLY_EGRESS_BILLING: 'enabled', BACKENLY_EGRESS_TERMS: 'direct' })).toBe(false)
    expect(egressBillable({ BACKENLY_EGRESS_TERMS: 'cdn' })).toBe(false)
    expect(egressBillable({ BACKENLY_EGRESS_BILLING: 'true', BACKENLY_EGRESS_TERMS: 'cdn' })).toBe(false)
    expect(egressBillable({ BACKENLY_EGRESS_BILLING: 'enabled', BACKENLY_EGRESS_TERMS: 'cdn' })).toBe(true)
  })

  it('decides per axis: egress follows the switch, the rest follow the plan', () => {
    for (const axis of ['mau', 'db_bytes', 'file_bytes', 'fn_runs'] as const) {
      expect(axisBillable('BUILDER', axis, false)).toBe(true)
      expect(axisBillable('SANDBOX', axis, true)).toBe(false)
      expect(axisBillable('SCALE', axis, true)).toBe(false)
    }
    expect(axisBillable('BUILDER', 'egress_bytes', false)).toBe(false)
    expect(axisBillable('BUILDER', 'egress_bytes', true)).toBe(true)
    expect(axisBillable('SANDBOX', 'egress_bytes', true)).toBe(false)
  })
})

describe('publishing', () => {
  it('shows usage pricing only when published', () => {
    expect(usagePricingPublished(undefined)).toBe(false)
    expect(usagePricingPublished('shadow')).toBe(false)
    expect(usagePricingPublished('published')).toBe(true)
  })

  it('publishes every rate that clears cost, and holds the database rate back', () => {
    expect(OVERAGE_RATE_PUBLISHED).toEqual({
      mau: true,
      db_bytes: false,
      file_bytes: true,
      fn_runs: true,
      egress_bytes: true,
    })
  })
})

describe('the Pro usage table', () => {
  it('lists what Pro includes and each published rate past it', () => {
    expect(proUsagePriceRows()).toEqual([
      { axis: 'mau', label: 'Monthly active users', included: '100,000', rate: '$0.003 per MAU' },
      { axis: 'db_bytes', label: 'Database', included: '8 GB', rate: null },
      { axis: 'file_bytes', label: 'File storage', included: '100 GB', rate: '$0.03 per GB-month' },
      { axis: 'fn_runs', label: 'Function runs', included: '2M', rate: '$2.00 per 1M runs' },
      { axis: 'egress_bytes', label: 'Egress', included: '250 GB', rate: '$0.12 per GB' },
    ])
  })

  it('advertises the competitive included quotas', () => {
    expect(PRO_INCLUDED).toEqual({ mau: 100_000, fnRuns: 2_000_000, dbGib: 8, fileGib: 100 })
  })

  it('includes 250 GB of egress on Pro whichever path the bytes leave by', () => {
    expect(includedEgressMb('BUILDER', 'direct')).toBe(250 * 1024)
    expect(includedEgressMb('BUILDER', 'cdn')).toBe(250 * 1024)
    expect(includedEgressMb('SANDBOX', 'direct')).toBe(5 * 1024)
  })

  it('bills exactly the rate it shows', () => {
    expect(overageCents('mau', 1_000)).toBeCloseTo(300, 9)
    expect(overageCents('fn_runs', 1_000_000)).toBeCloseTo(200, 9)
    expect(overageCents('file_bytes', GIB)).toBeCloseTo(3, 9)
    expect(overageCents('egress_bytes', GIB, 'cdn')).toBeCloseTo(12, 9)
    expect(overageCents('egress_bytes', GIB, 'direct')).toBeCloseTo(12, 9)
    expect(formatRate('egress_bytes')).toBe('$0.12 per GB')
  })

  it('prices database overage at its target in shadow, never below the old sub-cost $0.15', () => {
    expect(overageCents('db_bytes', 2 * GIB)).toBeCloseTo(50, 9)
    expect(formatRate('db_bytes')).toBe('$0.25 per GB-month')
  })
})
