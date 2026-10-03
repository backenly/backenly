/**
 * SCALING MUST NOT SILENTLY REOPEN BRUTE-FORCE CAPACITY
 * ====================================================
 * The auth limiter keeps counters in an in-memory Map. That is a real control
 * on one process and none across several: an attacker reaching N instances gets
 * N budgets, so the effective limit becomes (limit x N).
 *
 * Today self-host runs one process and the Cloud task runs desired_count = 1.
 * Neither fact is visible to the limiter, and raising a replica count is a
 * capacity decision nobody would security-review — so the brute-force capacity
 * this audit closed would reopen without a single line of code changing.
 *
 * These pin the guard that makes that impossible by accident. It is not a
 * shared-store implementation; it is the cheap thing that stops the gap being
 * crossed unknowingly until one exists.
 */

import {
  assertRateLimitStoreSupportsTopology,
  declaredInstanceCount,
  declaredStoreKind,
  RateLimitStoreMisconfigured,
} from '@/lib/security/rate-limit-store'

const env = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  overrides as unknown as NodeJS.ProcessEnv

describe('what the deployment declares', () => {
  it('defaults to a single instance when nothing is set', () => {
    // The overwhelmingly common case: self-host, local dev, CI.
    expect(declaredInstanceCount(env({}))).toBe(1)
  })

  it('reads an explicit count', () => {
    expect(declaredInstanceCount(env({ BACKENLY_APP_INSTANCES: '3' }))).toBe(3)
  })

  it('refuses a value it cannot parse rather than assuming one', () => {
    // Assuming the safe answer here is exactly how the check gets bypassed: a
    // typo would silently disable it.
    for (const bad of ['three', '0', '-2', '1.5', '']) {
      if (bad === '') {
        expect(declaredInstanceCount(env({ BACKENLY_APP_INSTANCES: bad }))).toBe(1)
        continue
      }
      expect(() => declaredInstanceCount(env({ BACKENLY_APP_INSTANCES: bad })))
        .toThrow(RateLimitStoreMisconfigured)
    }
  })

  it('defaults to the memory store, and accepts redis', () => {
    expect(declaredStoreKind(env({}))).toBe('memory')
    expect(declaredStoreKind(env({ BACKENLY_RATE_LIMIT_STORE: 'redis' }))).toBe('redis')
    expect(declaredStoreKind(env({ BACKENLY_RATE_LIMIT_STORE: 'REDIS' }))).toBe('redis')
  })

  it('refuses an unknown store name', () => {
    expect(() => declaredStoreKind(env({ BACKENLY_RATE_LIMIT_STORE: 'memcached' })))
      .toThrow(RateLimitStoreMisconfigured)
  })
})

describe('the topology assertion', () => {
  it('permits one instance on the memory store, which is today', () => {
    // The positive case. A guard that refused the normal configuration would
    // be removed within a day, and then it would protect nothing.
    expect(() => assertRateLimitStoreSupportsTopology(env({}))).not.toThrow()
    expect(() => assertRateLimitStoreSupportsTopology(
      env({ BACKENLY_APP_INSTANCES: '1' }),
    )).not.toThrow()
  })

  it('REFUSES several instances on the memory store', () => {
    // The whole point: scaling from 1 to 3 must fail loudly rather than
    // tripling every auth budget in silence.
    expect(() => assertRateLimitStoreSupportsTopology(
      env({ BACKENLY_APP_INSTANCES: '3' }),
    )).toThrow(RateLimitStoreMisconfigured)
  })

  it('says what is wrong and what to do about it', () => {
    // A guard whose message does not name the fix gets worked around by
    // deleting the guard.
    let message = ''
    try {
      assertRateLimitStoreSupportsTopology(env({ BACKENLY_APP_INSTANCES: '3' }))
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('BACKENLY_APP_INSTANCES=3')
    expect(message).toContain('BACKENLY_RATE_LIMIT_STORE=redis')
    // It should name the surfaces at risk, not just complain abstractly.
    expect(message).toContain('/api/v1/{projectId}/auth/')
  })

  it('permits several instances once a shared store is configured', () => {
    expect(() => assertRateLimitStoreSupportsTopology(env({
      BACKENLY_APP_INSTANCES: '3',
      BACKENLY_RATE_LIMIT_STORE: 'redis',
      REDIS_URL: 'redis://localhost:6379',
    }))).not.toThrow()
  })

  it('refuses redis declared without a URL', () => {
    // Otherwise it fails on the first request instead of at startup, which is
    // the worst case: it looks configured and is not.
    expect(() => assertRateLimitStoreSupportsTopology(env({
      BACKENLY_APP_INSTANCES: '3',
      BACKENLY_RATE_LIMIT_STORE: 'redis',
    }))).toThrow(/REDIS_URL/)
  })
})
