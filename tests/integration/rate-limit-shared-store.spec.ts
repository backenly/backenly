/**
 * THE AUTH LIMITER, PROVEN TO BE SHARED
 * =====================================
 *
 * The claim this suite has to establish is a negative one about a SECOND
 * process: that an attacker who reaches instance B does not get a fresh budget
 * after exhausting instance A. Nothing about a single limiter object can show
 * that, and a mocked Redis cannot either — the property under test is Redis's,
 * specifically that INCR and PEXPIRE applied by two independent clients
 * accumulate into one counter with one expiry.
 *
 * So this runs against a real Redis, and the two limiters are constructed
 * separately with separate connections, which is what an instance is from the
 * counter's point of view.
 *
 * ── Every shared-budget claim is paired with an isolation claim ─────────────
 *
 * "Two limiters share a budget" passes trivially if the limiter denies
 * everything, and "one project cannot exhaust another" passes trivially if it
 * allows everything. Neither number means anything alone, so each test states
 * both: the shared key runs out, AND a different key is still allowed at the
 * same moment.
 *
 * ── Without REDIS_URL this suite FAILS, it does not skip ────────────────────
 *
 * database-free-suites.txt puts it plainly: "a suite that passes by skipping
 * everything spends the suite's credibility vouching for nothing." A skipped
 * shared-store test is worse than none, because the tick beside it says the
 * multi-instance claim was checked.
 *
 * So a missing REDIS_URL is an error here, exactly as a missing database is an
 * error in the Postgres-backed suites. This suite is listed in CI as needing a
 * real Redis, and a run without one has not tested what it was listed to test.
 */

import {
  MemoryRateLimitBackend,
  RedisRateLimitBackend,
  createRateLimitRedis,
  type RateLimitBackend,
} from '@/lib/security/rate-limit-backend'
import { throttleDecision } from '@/lib/security/rate-limit-response'
import net from 'net'
import { assertSharedStoreIsOperational, RateLimitStoreMisconfigured } from '@/lib/security/rate-limit-store'
import type { Redis } from 'ioredis'

const REDIS_URL = process.env.REDIS_URL?.trim()

/** A fresh key per test, so one test's counter cannot become another's. */
function key(name: string): string {
  return `test:ratelimit:${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

describe('the memory backend, which is what self-host runs', () => {
  let backend: MemoryRateLimitBackend

  beforeEach(() => { backend = new MemoryRateLimitBackend(false) })
  afterEach(() => backend.destroy())

  it('allows up to the limit and denies past it, reporting when to return', async () => {
    const k = key('memory-basic')

    for (let i = 1; i <= 3; i++) {
      const r = await backend.consume(k, 3, 60_000)
      expect(r.allowed).toBe(true)
      expect(r.remaining).toBe(3 - i)
    }

    const denied = await backend.consume(k, 3, 60_000)
    expect(denied.allowed).toBe(false)
    expect(denied.outcome).toBe('limit_exceeded')
    // A denial that does not say when to come back is what made every route
    // retry blindly into the same wall.
    expect(denied.retryAfter).toBeGreaterThan(0)
    expect(denied.resetAt).toBeGreaterThan(Date.now())
  })

  it('does NOT share a budget between two instances, which is the whole problem', async () => {
    const k = key('memory-not-shared')
    const a = new MemoryRateLimitBackend(false)
    const b = new MemoryRateLimitBackend(false)

    try {
      for (let i = 0; i < 3; i++) expect((await a.consume(k, 3, 60_000)).allowed).toBe(true)
      expect((await a.consume(k, 3, 60_000)).allowed).toBe(false)

      // The second process hands out a whole fresh budget for the same key.
      // This is not a bug in the memory backend; it is the definition of
      // per-process counters, and it is why the startup guard refuses to boot
      // a multi-instance deployment on this store.
      expect((await b.consume(k, 3, 60_000)).allowed).toBe(true)
    } finally {
      a.destroy()
      b.destroy()
    }
  })

  it('is always ready, because there is no store to be down', async () => {
    const health = backend.health()
    expect(health.kind).toBe('memory')
    expect(health.ready).toBe(true)
    expect(health.lastError).toBeNull()
  })

  it('starts a new window once the old one expires', async () => {
    const k = key('memory-window')
    expect((await backend.consume(k, 1, 120)).allowed).toBe(true)
    expect((await backend.consume(k, 1, 120)).allowed).toBe(false)

    await new Promise(r => setTimeout(r, 200))
    expect((await backend.consume(k, 1, 120)).allowed).toBe(true)
  })
})

describe('the shared store, across independent instances', () => {
  let clientA: Redis
  let clientB: Redis
  let a: RateLimitBackend
  let b: RateLimitBackend
  const touched: string[] = []

  beforeAll(async () => {
    if (!REDIS_URL) {
      throw new Error(
        'REDIS_URL is not set. This suite proves the auth limiter shares one budget ' +
          'across instances, which only a real Redis can establish — a mock would be ' +
          'asserting the mock. Start one and set REDIS_URL, or accept that the ' +
          'multi-instance claim is unproven.',
      )
    }

    // Two clients, two connections. This is what "two app instances" means to
    // the counter, and constructing one client and sharing it would prove
    // nothing about the case that matters.
    //
    // Built through the production factory, not with hand-picked options. The
    // first version of this suite passed its own option set and so exercised a
    // client that did not exist anywhere in the product.
    clientA = createRateLimitRedis(REDIS_URL!)
    clientB = createRateLimitRedis(REDIS_URL!)
    a = new RedisRateLimitBackend(clientA)
    b = new RedisRateLimitBackend(clientB)
  }, 30_000)

  afterAll(async () => {
    if (touched.length) await clientA.del(...touched).catch(() => {})
    await clientA?.quit().catch(() => clientA?.disconnect())
    await clientB?.quit().catch(() => clientB?.disconnect())
  }, 30_000)

  function shared(name: string): string {
    const k = key(name)
    touched.push(k)
    return k
  }

  it('spends ONE budget across two instances, and leaves a different key untouched', async () => {
    const k = shared('shared-budget')
    const other = shared('shared-budget-other')

    // Three of a limit of four, through instance A.
    for (let i = 0; i < 3; i++) expect((await a.consume(k, 4, 60_000)).allowed).toBe(true)

    // The fourth through instance B. If the counter were per-process this
    // would be B's FIRST request and would report three remaining.
    const fourth = await b.consume(k, 4, 60_000)
    expect(fourth.allowed).toBe(true)
    expect(fourth.remaining).toBe(0)

    // And the fifth is denied no matter which instance it reaches. This is the
    // claim: an attacker moving to another instance gains nothing.
    expect((await b.consume(k, 4, 60_000)).allowed).toBe(false)
    expect((await a.consume(k, 4, 60_000)).allowed).toBe(false)

    // CONTROL: the limiter is not simply denying everything. A different key
    // is still allowed at this exact moment, so the denials above are about
    // that budget and not about the store being broken.
    expect((await b.consume(other, 4, 60_000)).allowed).toBe(true)
  }, 30_000)

  it('counts every attempt when both instances race, losing none and inventing none', async () => {
    const k = shared('shared-race')

    // Twenty concurrent attempts, alternating instances, against a limit of
    // eight. INCR is atomic, so exactly eight must be allowed: a lost update
    // would admit more than eight, and double counting would admit fewer.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b).consume(k, 8, 60_000)),
    )

    expect(results.filter(r => r.allowed)).toHaveLength(8)
    expect(results.filter(r => !r.allowed)).toHaveLength(12)
  }, 30_000)

  it('keys projects apart, so one tenant under attack cannot lock out another', async () => {
    const victim = shared('project-victim')
    const bystander = shared('project-bystander')

    for (let i = 0; i < 2; i++) expect((await a.consume(victim, 2, 60_000)).allowed).toBe(true)
    expect((await b.consume(victim, 2, 60_000)).allowed).toBe(false)

    // The bystander's budget is untouched, from the other instance.
    const ok = await b.consume(bystander, 2, 60_000)
    expect(ok.allowed).toBe(true)
    expect(ok.remaining).toBe(1)
  }, 30_000)

  it('expires the window rather than locking a key out for ever', async () => {
    const k = shared('shared-window')

    expect((await a.consume(k, 1, 700)).allowed).toBe(true)
    expect((await b.consume(k, 1, 700)).allowed).toBe(false)

    // The TTL is set with the first INCR and must actually apply. A counter
    // INCRed without its expiry is a permanent lockout, which is why the
    // script does both in one step.
    await new Promise(r => setTimeout(r, 900))
    expect((await b.consume(k, 1, 700)).allowed).toBe(true)
  }, 30_000)

  it('reports a reset time that belongs to the window the count came from', async () => {
    const k = shared('shared-reset')
    const first = await a.consume(k, 5, 30_000)

    expect(first.resetAt).toBeGreaterThan(Date.now())
    expect(first.resetAt).toBeLessThanOrEqual(Date.now() + 30_000 + 1_000)

    // The second instance sees the SAME window, not a new 30s one of its own.
    const second = await b.consume(k, 5, 30_000)
    expect(Math.abs(second.resetAt - first.resetAt)).toBeLessThan(1_000)
  }, 30_000)

  it('FAILS CLOSED when the store cannot be reached, rather than falling back', async () => {
    // A port nothing listens on. The deliberate decision under test is that an
    // unreachable shared store denies: falling back to per-process counters
    // would hand back (limit x instances) precisely when the store is most
    // likely to be struggling because an attack is underway.
    const dead = createRateLimitRedis('redis://127.0.0.1:1')
    const broken = new RedisRateLimitBackend(dead, 500)

    try {
      const result = await broken.consume(key('dead-store'), 100, 60_000)
      expect(result.allowed).toBe(false)

      // An OUTAGE, not a limit. This is the distinction the whole response
      // layer hangs off: the caller has made one attempt, not a hundred.
      expect(result.outcome).toBe('store_unavailable')
      expect(result.retryAfter).toBeGreaterThan(0)

      // CONTROL: a working store answers ALLOWED for the same shape of call,
      // so the denial above is caused by the outage and not by consume()
      // denying everything.
      const control = await a.consume(shared('dead-store-control'), 100, 60_000)
      expect(control.allowed).toBe(true)
      expect(control.outcome).toBe('allowed')
    } finally {
      dead.disconnect()
    }
  }, 30_000)

  it('does NOT silently fall back to per-process counters during an outage', async () => {
    // The specific thing that must not happen. A fallback would look like
    // success: requests keep flowing, nothing is logged as an outage, and each
    // process quietly hands out its own full budget.
    const dead = createRateLimitRedis('redis://127.0.0.1:1')
    const broken = new RedisRateLimitBackend(dead, 400)
    const k = key('no-fallback')

    try {
      // A limit of 1. If anything fell back to a local counter, the FIRST call
      // would be allowed, because a fresh in-memory bucket always admits one.
      for (let i = 0; i < 3; i++) {
        const r = await broken.consume(k, 1, 60_000)
        expect(r.allowed).toBe(false)
        expect(r.outcome).toBe('store_unavailable')
      }

      // And the store it reports is still the shared one. It did not switch.
      const health = broken.health()
      expect(health.kind).toBe('redis')
      expect(health.ready).toBe(false)
      expect(health.lastError).toBeTruthy()

      // The recorded error must not carry a connection string: this value is
      // served by /api/health, and a real REDIS_URL carries a password.
      expect(health.lastError).not.toMatch(/redis:\/\//)
      expect(health.lastError).not.toMatch(/password/i)
    } finally {
      dead.disconnect()
    }
  }, 30_000)

  it('recovers on its own when the store comes back, with no restart', async () => {
    // A real TCP proxy in front of the real Redis, so the outage is a real
    // socket going away rather than a flag flipped on the backend. Recovery is
    // the half of fail-closed that is easy to claim and easy to get wrong: a
    // backend that latched its failed state would deny for ever, and only a
    // deploy would clear it.
    //
    // ── net.Server.close() is a trap, twice ────────────────────────────────
    //
    // It stops listening at once but only calls back when every EXISTING
    // connection has ended. Awaiting it while a connection is still open waits
    // for something nobody is doing. That cost this test two 60s timeouts: once
    // for the proxy, whose sockets are cut after the close was awaited, and
    // again for the revived server, which the ioredis client was still
    // connected to while an inner `finally` awaited its close.
    //
    // So: sockets are always tracked, the client is always disconnected first,
    // and every close is awaited only after the things holding it open are gone.
    const target = new URL(REDIS_URL!)
    const sockets: net.Socket[] = []

    const forward = () =>
      net.createServer(client => {
        sockets.push(client)
        const upstream = net.connect(Number(target.port || 6379), target.hostname)
        sockets.push(upstream)
        client.pipe(upstream)
        upstream.pipe(client)
        client.on('error', () => {})
        upstream.on('error', () => {})
      })

    const cutSockets = () => {
      for (const sock of sockets.splice(0)) sock.destroy()
    }
    const shutdown = async (server: net.Server) => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()))
      cutSockets()
      await closed
    }

    const proxy = forward()
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const proxyPort = (proxy.address() as net.AddressInfo).port

    const client = createRateLimitRedis(`redis://127.0.0.1:${proxyPort}`)
    const backend = new RedisRateLimitBackend(client, 1_000)
    const k = shared('recovery')
    let revived: net.Server | null = null

    try {
      // Through the proxy, everything works. Stated first so the outage below
      // is a change of state rather than the only thing ever observed.
      expect((await backend.consume(k, 100, 60_000)).outcome).toBe('allowed')
      expect(backend.health().ready).toBe(true)

      await shutdown(proxy)

      const during = await backend.consume(k, 100, 60_000)
      expect(during.allowed).toBe(false)
      expect(during.outcome).toBe('store_unavailable')
      expect(backend.health().ready).toBe(false)

      // Recovery: the same port answers again. ioredis reconnects, and because
      // no failed state was latched the next call succeeds.
      revived = forward()
      await new Promise<void>(resolve => revived!.listen(proxyPort, '127.0.0.1', resolve))

      // Poll the real condition rather than sleeping a round number, and fail
      // loudly with what was actually observed if it never recovers.
      const deadline = Date.now() + 20_000
      let last = during
      while (Date.now() < deadline) {
        last = await backend.consume(k, 100, 60_000)
        if (last.outcome === 'allowed') break
        await new Promise(r => setTimeout(r, 200))
      }
      // jest's expect takes no message argument (that is Playwright's), so the
      // detail goes in a throw. The point stands either way: a timeout here
      // must name what was actually observed rather than just failing.
      if (last.outcome !== 'allowed') {
        throw new Error(
          `the limiter never recovered after the store returned; last outcome was ` +
            `${last.outcome}, health ${JSON.stringify(backend.health())}`,
        )
      }
      expect(backend.health().ready).toBe(true)

      // And it recovered onto the SAME counter, not a fresh local bucket: the
      // attempts made before the outage are still counted against the budget.
      const after = await backend.consume(k, 100, 60_000)
      expect(after.remaining).toBeLessThan(98)
    } finally {
      // The client first. It is what holds a connection to `revived` open, and
      // closing the server while it is attached is the second deadlock above.
      client.disconnect()
      if (revived) await shutdown(revived)
      cutSockets()
    }
  }, 60_000)

  it('answers 503 for a store outage and 429 for a real limit', async () => {
    // The distinction has to survive all the way to the wire. Telling a caller
    // "too many attempts" while the limiter is down accuses them of something
    // they did not do, and buries an outage inside a metric operators read as
    // ordinary abuse.
    const k = shared('status-codes')

    const exhausted = await (async () => {
      let r = await a.consume(k, 1, 60_000)
      r = await a.consume(k, 1, 60_000)
      return r
    })()
    expect(exhausted.outcome).toBe('limit_exceeded')

    // Asserted on the pure decision, not on a NextResponse. jest.setup.js
    // replaces global.Response with a stub whose headers do not round-trip, so
    // a header assertion through the framework here would be testing the stub.
    const limited = throttleDecision(exhausted)
    expect(limited.status).toBe(429)
    expect(limited.headers['Retry-After']).toBeTruthy()
    expect(limited.message).toMatch(/too many/i)

    const dead = createRateLimitRedis('redis://127.0.0.1:1')
    try {
      const down = await new RedisRateLimitBackend(dead, 400).consume(key('sc'), 100, 60_000)
      expect(down.outcome).toBe('store_unavailable')

      const unavailable = throttleDecision(down)
      expect(unavailable.status).toBe(503)
      expect(unavailable.headers['Retry-After']).toBeTruthy()
      expect(unavailable.headers['Cache-Control']).toBe('no-store')

      // It does not claim the caller made too many attempts.
      expect(unavailable.code).toBe('RATE_LIMITER_UNAVAILABLE')
      expect(unavailable.message).not.toMatch(/too many/i)
      // Nor does it name the backing service to an unauthenticated caller.
      expect(JSON.stringify(unavailable)).not.toMatch(/redis/i)

      // The short Retry-After belongs to the outage, not to a window nobody
      // counted: a client told to wait out 15 minutes would stay away far
      // longer than the outage lasts.
      expect(Number(unavailable.headers['Retry-After'])).toBeLessThan(60)
    } finally {
      dead.disconnect()
    }
  }, 30_000)
})

describe('startup refuses a topology it cannot enforce', () => {
  it('accepts memory for a single instance', async () => {
    await expect(
      assertSharedStoreIsOperational({ BACKENLY_RATE_LIMIT_STORE: 'memory' } as NodeJS.ProcessEnv),
    ).resolves.toMatch(/in-memory/)
  })

  it('refuses redis declared without a URL', async () => {
    await expect(
      assertSharedStoreIsOperational({ BACKENLY_RATE_LIMIT_STORE: 'redis' } as NodeJS.ProcessEnv),
    ).rejects.toBeInstanceOf(RateLimitStoreMisconfigured)
  })

  it('refuses a REDIS_URL that is set but does not answer', async () => {
    // The gap the config check alone leaves: a typo, a firewall or a Redis
    // that never came up all pass "is REDIS_URL set?" and then fail closed on
    // the first sign-in, reporting a misconfiguration as an auth outage.
    await expect(
      assertSharedStoreIsOperational({
        BACKENLY_RATE_LIMIT_STORE: 'redis',
        REDIS_URL: 'redis://127.0.0.1:1',
      } as NodeJS.ProcessEnv),
    ).rejects.toBeInstanceOf(RateLimitStoreMisconfigured)
  }, 30_000)

  it('accepts a store that actually answers and can be written to', async () => {
    await expect(
      assertSharedStoreIsOperational({
        BACKENLY_RATE_LIMIT_STORE: 'redis',
        REDIS_URL,
        BACKENLY_APP_INSTANCES: '3',
      } as NodeJS.ProcessEnv),
    ).resolves.toMatch(/shared Redis counters, 3 instance/)
  }, 30_000)
})
