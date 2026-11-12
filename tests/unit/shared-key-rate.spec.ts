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
  PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE,
  PRESENCE_WRITES_PER_MINUTE,
  SHARED_KEY_BURST_LIMIT,
  SHARED_KEY_BURST_WINDOW_SECONDS,
  UNCAPPED,
  sharedKeyWindow,
  clientWindowOf,
  describeClientWindow,
  countClientRequest,
  countKeyedRequest,
  countPresenceAddress,
  countPresenceWrite,
  isSharedKey,
  platformLimiterStore,
  presenceAddressBucket,
  presenceRefusal,
} from '@/lib/security/shared-key-rate'

/** A shared key at the schema's default rate, which nobody chose: the burst brake decides. */
const key = (over: Partial<RateKey> = {}): RateKey => ({
  id: 'key-1',
  keyHash: 'a'.repeat(64),
  rateLimit: 1000,
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

  it(`gives each client ${SHARED_KEY_BURST_LIMIT} requests per ${SHARED_KEY_BURST_WINDOW_SECONDS} seconds when its owner set no rate, and one at its limit refuses no one else`, async () => {
    const own = ownWindow()
    const a = []
    for (let i = 0; i < SHARED_KEY_BURST_LIMIT + 1; i++) a.push(await countKeyedRequest(key(), '203.0.113.1', own.countKey))
    // The schema's 1,000 an hour, which nobody chose, means the burst brake for each address.
    expect(a.filter((d) => d.allowed)).toHaveLength(SHARED_KEY_BURST_LIMIT)
    expect(a[SHARED_KEY_BURST_LIMIT]).toMatchObject({ allowed: false, remaining: 0 })
    expect(a[SHARED_KEY_BURST_LIMIT].retryAfter).toBeLessThanOrEqual(SHARED_KEY_BURST_WINDOW_SECONDS)

    expect(await countKeyedRequest(key(), '203.0.113.2', own.countKey)).toMatchObject({ allowed: true, remaining: SHARED_KEY_BURST_LIMIT - 1 })
  })

  it('holds each client to the rate its owner set, lowered or raised', async () => {
    const own = ownWindow()
    const lowered = key({ id: 'key-low', rateLimit: 5, rateLimitWindow: 3600 })
    const a = []
    for (let i = 0; i < 6; i++) a.push(await countKeyedRequest(lowered, '203.0.113.1', own.countKey))
    expect(a.map((d) => d.allowed)).toEqual([true, true, true, true, true, false])
    expect((await countKeyedRequest(lowered, '203.0.113.2', own.countKey)).allowed).toBe(true)

    // Raised for traffic that comes from one address by design: past the brake, and still per address.
    const raised = key({ id: 'key-high', rateLimit: 100_000, rateLimitWindow: 3600 })
    const b = []
    for (let i = 0; i < SHARED_KEY_BURST_LIMIT + 40; i++) b.push(await countKeyedRequest(raised, '203.0.113.3', own.countKey))
    expect(b.every((d) => d.allowed)).toBe(true)
    expect(b.at(-1)!.remaining).toBe(100_000 - SHARED_KEY_BURST_LIMIT - 40)
  })

  it('starts new windows when its owner sets a new rate', async () => {
    for (let i = 0; i < SHARED_KEY_BURST_LIMIT; i++) await countClientRequest(key(), '203.0.113.1')
    expect((await countClientRequest(key(), '203.0.113.1')).allowed).toBe(false)
    expect((await countClientRequest(key({ rateLimit: 600, rateLimitWindow: 10 }), '203.0.113.1')).allowed).toBe(true)
  })

  it('reads the schema default as "no rate set", and any other rate as the owner\'s', () => {
    expect(sharedKeyWindow({ rateLimit: 1000, rateLimitWindow: 3600 })).toEqual({ limit: SHARED_KEY_BURST_LIMIT, windowSeconds: SHARED_KEY_BURST_WINDOW_SECONDS })
    expect(sharedKeyWindow({})).toEqual({ limit: SHARED_KEY_BURST_LIMIT, windowSeconds: SHARED_KEY_BURST_WINDOW_SECONDS })
    expect(sharedKeyWindow({ rateLimit: 1000, rateLimitWindow: 60 })).toEqual({ limit: 1000, windowSeconds: 60 })
    expect(sharedKeyWindow({ rateLimit: 0, rateLimitWindow: 0 })).toEqual({ limit: 1, windowSeconds: 1 })
  })

  it("keeps the key's own count with no cap, for requests a client's window let through only", async () => {
    const own = ownWindow()
    for (let i = 0; i < SHARED_KEY_BURST_LIMIT + 1; i++) await countKeyedRequest(key(), '203.0.113.1', own.countKey)
    await countKeyedRequest(key(), '203.0.113.2', own.countKey)
    // Every request let through is counted past the key's own limit of 3; the refused one not at all.
    expect(own.calls.every((limit) => limit === UNCAPPED)).toBe(true)
    expect(own.count()).toBe(SHARED_KEY_BURST_LIMIT + 1)
  })

  it('counts a request with no known address in one window of its own', async () => {
    for (let i = 0; i < SHARED_KEY_BURST_LIMIT; i++) await countClientRequest(key(), null)
    expect((await countClientRequest(key(), null)).allowed).toBe(false)
    expect((await countClientRequest(key(), '203.0.113.1')).allowed).toBe(true)
  })

  it('starts new windows when the key is rotated, as its own count does', async () => {
    for (let i = 0; i < SHARED_KEY_BURST_LIMIT; i++) await countClientRequest(key(), '203.0.113.1')
    expect((await countClientRequest(key(), '203.0.113.1')).allowed).toBe(false)
    expect((await countClientRequest(key({ keyHash: 'b'.repeat(64) }), '203.0.113.1')).allowed).toBe(true)
  })

  it('tells a client the window that decides', () => {
    expect(describeClientWindow(clientWindowOf(key()))).toBe('300 requests per 10 second(s) from each address with this key')
    expect(describeClientWindow(clientWindowOf(key({ rateLimit: 5000 })))).toBe('5000 requests per 60 minute(s) from each address with this key')
    expect(describeClientWindow(clientWindowOf(key({ shared: false, rateLimit: 3 })))).toBe('3 requests per 60 minute(s)')
  })
})

describe('a key one caller holds', () => {
  it("is decided by the key's own window alone, as before", async () => {
    const own = ownWindow()
    const decisions = []
    for (const client of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4']) {
      decisions.push(await countKeyedRequest(key({ shared: false, rateLimit: 3 }), client, own.countKey))
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

    expect(presenceRefusal(refused, 'user')).toEqual({
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
    for (let i = 0; i < 10; i++) await countPresenceAddress('project-1', '203.0.113.1')
    expect(await countClientRequest(key(), '203.0.113.1')).toMatchObject({ allowed: true, remaining: SHARED_KEY_BURST_LIMIT - 1 })
  })

  it(`are counted per address and project before the key is looked up, ${PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE} a minute`, async () => {
    for (let i = 0; i < PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE; i++) {
      expect((await countPresenceAddress('project-1', '203.0.113.1')).allowed).toBe(true)
    }
    const refused = await countPresenceAddress('project-1', '203.0.113.1')
    expect(refused.allowed).toBe(false)
    expect((await countPresenceAddress('project-1', '203.0.113.2')).allowed).toBe(true)
    expect((await countPresenceAddress('project-2', '203.0.113.1')).allowed).toBe(true)
    expect(presenceRefusal(refused, 'address').body.error).toBe(
      `Presence was written more than ${PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE} times in a minute from this address. Try again in ${refused.retryAfter} second(s).`,
    )
  })

  it('share one window with express-rate-limit, through the store the runtime gives it', async () => {
    const store = platformLimiterStore(3, 60_000)
    const bucket = presenceAddressBucket('project-1', '203.0.113.9')
    const hits = []
    for (let i = 0; i < 4; i++) hits.push((await store.increment(bucket)).totalHits)
    // express-rate-limit refuses once the hits pass its limit of 3.
    expect(hits).toEqual([1, 2, 3, 4])
    expect((await store.increment(bucket)).resetTime).toBeInstanceOf(Date)
    // The window is the platform store's: counted there directly, it is full.
    expect(await memory.consume(bucket, 3, 60_000)).toMatchObject({ allowed: false })
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
      expect((await countPresenceAddress('project-1', '203.0.113.1')).allowed).toBe(true)
      expect(await platformLimiterStore(3, 60_000).increment('presence-address:project-1:203.0.113.1')).toMatchObject({ totalHits: 1 })
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
      const store = platformLimiterStore(3, 60_000)
      await expect(store.decrement('k')).resolves.toBeUndefined()
      await expect(store.resetKey('k')).resolves.toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })
})
