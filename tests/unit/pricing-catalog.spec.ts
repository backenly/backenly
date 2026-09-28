/**
 * The pricing page states only what the product does, and only once it can.
 *
 *   - Usage pricing appears only when published (NEXT_PUBLIC_USAGE_PRICING),
 *     which the release turns on with production in shadow mode or later.
 *   - The egress rate appears only once files are served by the CDN whose cost
 *     was verified (NEXT_PUBLIC_EGRESS_TERMS=cdn); until then egress is metered
 *     and capped but its price is not stated.
 *   - The rates shown are the rates billed: one catalog feeds both.
 */
import {
  egressPricePublished,
  overageCents,
  proUsagePriceRows,
  usagePricingPublished,
  GIB,
} from '@/lib/pricing/catalog'

describe('publishing', () => {
  it('shows usage pricing only when published', () => {
    expect(usagePricingPublished(undefined)).toBe(false)
    expect(usagePricingPublished('shadow')).toBe(false)
    expect(usagePricingPublished('published')).toBe(true)
  })

  it('states the egress rate only on the verified CDN terms', () => {
    expect(egressPricePublished(undefined)).toBe(false)
    expect(egressPricePublished('direct')).toBe(false)
    expect(egressPricePublished('cdn')).toBe(true)
    expect(proUsagePriceRows({ includeEgress: false }).map((r) => r.axis)).not.toContain('egress_bytes')
  })
})

describe('the Pro usage table', () => {
  it('lists what Pro includes and the rate past it', () => {
    expect(proUsagePriceRows({ includeEgress: true })).toEqual([
      { axis: 'mau', label: 'Monthly active users', included: '200,000', rate: '$0.003 per MAU' },
      { axis: 'db_bytes', label: 'Database', included: '10 GB', rate: '$0.15 per GB-month' },
      { axis: 'file_bytes', label: 'File storage', included: '100 GB', rate: '$0.03 per GB-month' },
      { axis: 'fn_runs', label: 'Function runs', included: '2M', rate: '$2.00 per 1M runs' },
      { axis: 'egress_bytes', label: 'Egress', included: '250 GB', rate: '$0.09 per GB' },
    ])
  })

  it('bills exactly the rate it shows', () => {
    expect(overageCents('mau', 1_000)).toBeCloseTo(300, 9)
    expect(overageCents('fn_runs', 1_000_000)).toBeCloseTo(200, 9)
    expect(overageCents('db_bytes', 2 * GIB)).toBeCloseTo(30, 9)
    expect(overageCents('file_bytes', GIB)).toBeCloseTo(3, 9)
    expect(overageCents('egress_bytes', GIB, 'cdn')).toBeCloseTo(9, 9)
    expect(overageCents('egress_bytes', GIB, 'direct')).toBeCloseTo(12, 9)
  })
})
