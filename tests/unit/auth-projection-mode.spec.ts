/**
 * The authorization projection's switch and its bound (lib/auth-projection/mode.ts):
 * off unless named, and never trusted for longer than the founders' 15 seconds.
 */

import { AUTH_PROJECTION_DELIVERY_SECONDS, authMaxStalenessMs, authProjectionMode } from '@/lib/auth-projection/mode'
import { deliveryRegions } from '@/lib/auth-projection/deliver'

describe('authProjectionMode', () => {
  it('is off unless shadow or enforce is named', () => {
    expect(authProjectionMode(undefined)).toBe('off')
    expect(authProjectionMode('')).toBe('off')
    expect(authProjectionMode('on')).toBe('off')
    expect(authProjectionMode('true')).toBe('off')
    expect(authProjectionMode(' Shadow ')).toBe('shadow')
    expect(authProjectionMode('ENFORCE')).toBe('enforce')
  })
})

describe('authMaxStalenessMs', () => {
  it('is 15 seconds, the most the founders allow, unless set lower', () => {
    expect(authMaxStalenessMs(undefined)).toBe(15_000)
    expect(authMaxStalenessMs('10000')).toBe(10_000)
    expect(authMaxStalenessMs('60000')).toBe(15_000)
    for (const unreadable of ['', 'abc', '0', '-5', '1.5', '10s']) expect(authMaxStalenessMs(unreadable)).toBe(15_000)
  })

  it('leaves room for two missed deliveries before a copy goes stale', () => {
    expect(3 * AUTH_PROJECTION_DELIVERY_SECONDS * 1000).toBeLessThanOrEqual(authMaxStalenessMs(undefined))
  })
})

describe('deliveryRegions', () => {
  it('is every other region this process has a database connection for', () => {
    expect(deliveryRegions({})).toEqual([])
    expect(deliveryRegions({ DATABASE_URL: 'postgresql://home/db', DATABASE_URL_US_EAST_1: 'postgresql://virginia/db', DATABASE_URL_EU_CENTRAL_1: ' ' })).toEqual([
      'us-east-1',
    ])
  })
})
