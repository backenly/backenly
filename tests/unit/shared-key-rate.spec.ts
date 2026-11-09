/**
 * A key every user of an app sends is counted per client (#618).
 *
 * lib/security/shared-key-rate.ts on its own, over the platform's rate-limit
 * store: which keys are shared, each client's window, the key's own count kept
 * with no cap for requests a client's window lets through, presence writes
 * counted per user, and a store that cannot be read letting requests through.
 * What the routes of both runtimes answer is in
 * tests/integration/shared-key-rate-limits.spec.ts.
 */

import { format } from 'util'
import type { RateDecision, RateKey } from '@/lib/auth-projection/rate'
import {
  MemoryRateLimitBackend,
  __setRateLimitBackend,
  type RateLimitBackend,
} from '@/lib/security/rate-limit-backend'
import {
  PRESENCE_WRITES_PER_MINUTE,
  UNCAPPED,
  countClientRequest,
  countKeyedRequest,
  countPresenceWrite,
  isSharedKey,
  presenceRefusal,
} from '@/lib/security/shared-key-rate'

const key = (over: Partial<RateKey> = {}): RateKey => ({
  id: 'key-1',
  keyHash: 'a'.repeat(64),
  rateLimit: 3,
  rateLimitWindow: 3600,
  shared: true,
  ...over,
})

/** The key's own window, as a door keeps it: counted while under the limit it is given. */
function ownWindow() {
  const calls: number[] = []
  let count = 0
  const countKey = async (limit: number): Promise<RateDecision> => {
    calls.push(limit)
    const allowed = count < limit
    if (allowed) count += 1
    return { allowed, remaining: Math.max(0, limit - count), resetAt: new Date() }
  }
  return { countKey, calls, count: () => count }
}

let memory: MemoryRateLimitBackend
beforeEach(() => {
  memory = new MemoryRateLimitBackend(false)
  __setRateLimitBackend(memory)
})
afterEach(() => {
  memory.destroy()
  __setRateLimitBackend(null)
})

describe('a shared key', () => {
  it('is a public key that is not service-role', () => {
    expect(isSharedKey({ keyType: 'public', serviceRole: false })).toBe(true)
    expect(isSharedKey({ keyType: 'public', serviceRole: true })).toBe(false)
    expect(isSharedKey({ keyType: 'dashboard', serviceRole: false })).toBe(false)
    expect(isSharedKey({ keyType: null, serviceRole: null })).toBe(false)
  })

  it("gives each client the key's limit, so one client at its limit refuses no one else", async () => {
    const own = ownWindow()
    const a = []
    for (let i = 0; i < 4; i++) a.push(await countKeyedRequest(key(), '203.0.113.1', own.countKey))
    expect(a.map((d) => d.allowed)).toEqual([true, true, true, false])
    expect(a.map((d) => d.remaining)).toEqual([2, 1, 0, 0])
    expect(a[3].retryAfter).toBeGreaterThan(3500)

    expect(await countKeyedRequest(key(), '203.0.113.2', own.countKey)).toMatchObject({ allowed: true, remaining: 2 })
  })

  it("keeps the key's own count with no cap, for requests a client's window let through only", async () => {
    const own = ownWindow()
    for (const client of ['203.0.113.1', '203.0.113.1', '203.0.113.1', '203.0.113.1', '203.0.113.2']) {
      await countKeyedRequest(key(), client, own.countKey)
    }
    // Four let through (three and one), counted past the key's own limit of 3; the refused one not at all.
    expect(own.calls).toEqual([UNCAPPED, UNCAPPED, UNCAPPED, UNCAPPED])
    expect(own.count()).toBe(4)
  })

  it('counts a request with no known address in one window of its own', async () => {
    for (let i = 0; i < 3; i++) await countClientRequest(key(), null)
    expect((await countClientRequest(key(), null)).allowed).toBe(false)
    expect((await countClientRequest(key(), '203.0.113.1')).allowed).toBe(true)
  })

  it('starts new windows when the key is rotated or its window length changes, as its own count does', async () => {
    for (let i = 0; i < 3; i++) await countClientRequest(key(), '203.0.113.1')
    expect((await countClientRequest(key(), '203.0.113.1')).allowed).toBe(false)
    expect((await countClientRequest(key({ keyHash: 'b'.repeat(64) }), '203.0.113.1')).allowed).toBe(true)
    expect((await countClientRequest(key({ rateLimitWindow: 60 }), '203.0.113.1')).allowed).toBe(true)
  })
})

describe('a key one caller holds', () => {
  it("is decided by the key's own window alone, as before", async () => {
    const own = ownWindow()
    const decisions = []
    for (const client of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4']) {
      decisions.push(await countKeyedRequest(key({ shared: false }), client, own.countKey))
    }
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false])
    expect(own.calls).toEqual([3, 3, 3, 3])
  })
})

describe('presence writes', () => {
  it(`are counted per user and key, ${PRESENCE_WRITES_PER_MINUTE} a minute`, async () => {
    for (let i = 0; i < PRESENCE_WRITES_PER_MINUTE; i++) {
      expect((await countPresenceWrite('key-1', 'alice')).allowed).toBe(true)
    }
    const refused = await countPresenceWrite('key-1', 'alice')
    expect(refused.allowed).toBe(false)
    expect((await countPresenceWrite('key-1', 'bob')).allowed).toBe(true)
    expect((await countPresenceWrite('key-2', 'alice')).allowed).toBe(true)

    expect(presenceRefusal(refused)).toEqual({
      status: 429,
      headers: { 'Retry-After': String(refused.retryAfter) },
      body: {
        error: `Presence for this user was written more than ${PRESENCE_WRITES_PER_MINUTE} times in a minute. Try again in ${refused.retryAfter} second(s).`,
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: refused.retryAfter,
      },
    })
  })

  it("spend nothing of the key's request limit", async () => {
    for (let i = 0; i < 10; i++) await countPresenceWrite('key-1', 'alice')
    expect(await countClientRequest(key(), '203.0.113.1')).toMatchObject({ allowed: true, remaining: 2 })
  })
})

describe('a store that cannot be read', () => {
  it('lets the request through, and says so once a minute, never per request', async () => {
    const unavailable: RateLimitBackend = {
      kind: 'redis',
      consume: async () => ({ allowed: false, outcome: 'store_unavailable', remaining: 0, retryAfter: 5, resetAt: Date.now() + 5000 }),
      reset: async () => {},
      refund: async () => {},
      health: () => ({ kind: 'redis', ready: false, lastError: 'down', lastErrorAt: Date.now() }),
    }
    __setRateLimitBackend(unavailable)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const own = ownWindow()
      const decisions = []
      for (let i = 0; i < 5; i++) decisions.push(await countKeyedRequest(key(), '203.0.113.1', own.countKey))
      expect(decisions.every((d) => d.allowed)).toBe(true)
      expect((await countPresenceWrite('key-1', 'alice')).allowed).toBe(true)
      expect(own.calls).toHaveLength(5)
      expect(warn.mock.calls.map((call) => format(...call))).toEqual([
        '[SharedKeyRate] The rate-limit store could not be reached: shared keys and presence writes go uncounted until it can be.',
      ])
    } finally {
      warn.mockRestore()
    }
  })

  it('lets the request through when the store cannot even be built', async () => {
    __setRateLimitBackend({
      kind: 'redis',
      consume: async () => {
        throw new Error('BACKENLY_RATE_LIMIT_STORE=redis requires REDIS_URL to be set.')
      },
      reset: async () => {},
      refund: async () => {},
      health: () => ({ kind: 'redis', ready: false, lastError: null, lastErrorAt: null }),
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await countClientRequest(key(), '203.0.113.1')).allowed).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})
