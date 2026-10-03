/**
 * WHERE THE AUTH LIMITER'S COUNTERS ACTUALLY LIVE
 * ===============================================
 *
 * The limiter kept its counters in a per-process `Map`. That is a real control
 * on one process and none across several: an attacker reaching N instances gets
 * N budgets, so the effective limit on /api/auth/login and
 * /api/v1/{projectId}/auth/* is N times what it reads.
 *
 * `assertRateLimitStoreSupportsTopology` made that impossible to cross
 * unknowingly — a deployment declaring more than one instance with the memory
 * store refuses to boot. This is the other half: the shared store that lets a
 * deployment declare more than one instance and still enforce the limit it
 * prints.
 *
 * ── The two backends have the SAME window semantics, deliberately ───────────
 *
 * Both are fixed-window counters keyed on the same string, and both return the
 * same `RateLimitResult`. That is a requirement rather than a coincidence: if
 * Redis were a sliding window and memory a fixed one, moving a deployment onto
 * a shared store would silently change the effective limit, and the number in
 * AUTH_LIMITS would mean two different things depending on configuration.
 *
 * The Redis form is INCR plus PEXPIRE-on-first, in one Lua script so the two
 * cannot interleave. A counter that was INCRed without its expiry being set —
 * which is what happens when a process dies between two round trips — is a key
 * that never resets and locks the identity out for ever.
 *
 * ── Redis unavailable: FAIL CLOSED ──────────────────────────────────────────
 *
 * This is the deliberate decision the tranche called for, and it is the
 * uncomfortable one.
 *
 * Falling back to the in-memory store would be worse than it looks. A
 * deployment only reaches this code with `redis` declared, which means it
 * declared more than one instance, which means the fallback provides
 * (limit x instances) — the exact weakening the startup guard exists to
 * prevent, arriving silently at the moment an attacker is most likely to be
 * the reason Redis is under load. "Never silently revert from shared
 * protection to per-process" is the rule; this is where it would be broken.
 *
 * So a limiter that cannot reach its store denies. The cost is real and worth
 * stating plainly: a Redis outage takes sign-in down. It does not take the
 * data plane down, it is loud, it is in the logs, and it is recoverable in
 * minutes. An unlogged brute-force window is none of those things.
 *
 * The request timeout is deliberately short for the same reason. A limiter
 * that blocks for thirty seconds on a dead socket has taken sign-in down
 * anyway, just less legibly.
 */

import type { Redis } from 'ioredis'
import { declaredStoreKind, RateLimitStoreMisconfigured } from './rate-limit-store'

/**
 * WHY a denial has to say which kind of denial it is.
 *
 * "You have made too many attempts" and "we cannot currently tell how many
 * attempts you have made" are different facts about different systems, and the
 * first version of this collapsed them into one 429. That is a lie to the
 * caller and a trap for the operator: a legitimate user sees an accusation of
 * abuse they are not guilty of, a client backs off on a `Retry-After` that
 * describes a window nobody is counting, and a dashboard graphing 429s shows
 * "users hitting limits" during what is actually a store outage.
 *
 * Both outcomes still DENY. Only the reporting differs.
 */
export type RateLimitOutcome = 'allowed' | 'limit_exceeded' | 'store_unavailable'

export interface RateLimitResult {
  allowed: boolean
  /**
   * Which of the three happened. `allowed` is kept as the field every call site
   * already branches on, so adding this could not change any existing decision.
   */
  outcome: RateLimitOutcome
  remaining: number
  /** Seconds the caller should wait. Belongs in a `Retry-After` header. */
  retryAfter: number
  /** Unix ms at which this window ends. */
  resetAt: number
}

/**
 * What an operator needs to tell "users are hitting limits" apart from "the
 * limiter cannot count". Surfaced by /api/health.
 */
export interface RateLimitHealth {
  kind: 'memory' | 'redis'
  /** False means protected auth surfaces are denying because of the store. */
  ready: boolean
  /** Last store error, message only. Never a URL, never a credential. */
  lastError: string | null
  /** Unix ms of that error, so a stale one is recognisable as stale. */
  lastErrorAt: number | null
}

export interface RateLimitBackend {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>
  reset(key: string): Promise<void>
  /** Which store this is, for diagnostics and the startup report. */
  readonly kind: 'memory' | 'redis'
  health(): RateLimitHealth
}

/**
 * Denied because the store could not be consulted.
 *
 * `retryAfter` is deliberately SHORT and unrelated to the window. There is no
 * window — nothing was counted. The number is "come back soon, this is our
 * problem", not "your budget resets in fifteen minutes", because a client told
 * to wait out a window it never filled would stay away far longer than the
 * outage lasts.
 */
function storeUnavailable(): RateLimitResult {
  return {
    allowed: false,
    outcome: 'store_unavailable',
    remaining: 0,
    retryAfter: STORE_UNAVAILABLE_RETRY_SECONDS,
    resetAt: Date.now() + STORE_UNAVAILABLE_RETRY_SECONDS * 1_000,
  }
}

const STORE_UNAVAILABLE_RETRY_SECONDS = 5

// ── Memory ───────────────────────────────────────────────────────────────────

interface Bucket {
  count: number
  resetAt: number
}

export class MemoryRateLimitBackend implements RateLimitBackend {
  readonly kind = 'memory' as const
  private buckets = new Map<string, Bucket>()
  /** Soft cap; the sweep evicts oldest beyond it. */
  private static readonly MAX_KEYS = 50_000
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(sweep = true) {
    if (sweep && typeof setInterval !== 'undefined') {
      this.timer = setInterval(() => this.sweep(), 60_000)
      this.timer.unref?.()
    }
  }

  private sweep(): void {
    const now = Date.now()
    for (const [k, b] of Array.from(this.buckets.entries())) {
      if (b.resetAt < now) this.buckets.delete(k)
    }
    if (this.buckets.size > MemoryRateLimitBackend.MAX_KEYS) {
      const overflow = this.buckets.size - MemoryRateLimitBackend.MAX_KEYS
      for (const k of Array.from(this.buckets.keys()).slice(0, overflow)) this.buckets.delete(k)
    }
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now()
    const b = this.buckets.get(key)

    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs })
      return {
        allowed: true, outcome: 'allowed',
        remaining: limit - 1, retryAfter: 0, resetAt: now + windowMs,
      }
    }
    if (b.count >= limit) {
      return {
        allowed: false,
        outcome: 'limit_exceeded',
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
        resetAt: b.resetAt,
      }
    }
    b.count++
    return {
      allowed: true, outcome: 'allowed',
      remaining: limit - b.count, retryAfter: 0, resetAt: b.resetAt,
    }
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key)
  }

  health(): RateLimitHealth {
    // The heap is always reachable. There is no store to be down.
    return { kind: 'memory', ready: true, lastError: null, lastErrorAt: null }
  }

  /** Test seam: drop every counter and stop the sweep. */
  destroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.buckets.clear()
  }
}

// ── Redis ────────────────────────────────────────────────────────────────────

/**
 * INCR and PEXPIRE as one indivisible step, returning the count and the
 * remaining TTL.
 *
 * PTTL is read inside the script rather than as a second round trip, so the
 * `resetAt` reported to the caller belongs to the same window the count came
 * from. Two calls could straddle an expiry and report a count from the old
 * window with a TTL from the new one.
 *
 * The `< 0` guard covers a key that exists with no expiry — which should be
 * impossible given the branch above, and would be a permanent lockout if it
 * ever happened, so it repairs rather than trusts.
 */
const CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`

export class RedisRateLimitBackend implements RateLimitBackend {
  readonly kind = 'redis' as const
  private lastError: string | null = null
  private lastErrorAt: number | null = null

  constructor(
    private readonly redis: Redis,
    /** Budget for one limiter round trip. See the fail-closed note above. */
    private readonly timeoutMs = 1_000,
  ) {}

  health(): RateLimitHealth {
    return {
      kind: 'redis',
      ready: this.redis.status === 'ready',
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    }
  }

  /**
   * The limiter is not usable until the connection is READY, and says so rather
   * than assuming.
   *
   * `enableOfflineQueue` will hold a command through a reconnect, which is what
   * makes a blip survivable. But queued is not counted, and a command still
   * sitting in that queue at the deadline has to be reported as an outage
   * rather than waited on indefinitely. So readiness is checked explicitly and
   * waited for within the same bounded budget as the round trip.
   *
   * This covers startup too: the first request after boot does not get to
   * assume a socket that may still be connecting.
   */
  private async awaitReady(budgetMs: number): Promise<boolean> {
    if (this.redis.status === 'ready') return true
    // A client in state 'end' was deliberately closed and will not reconnect on
    // its own, so waiting would be waiting for something nobody is doing.
    if (this.redis.status === 'end') return false

    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        this.redis.off('ready', onReady)
        clearTimeout(timer)
        resolve(ok)
      }
      const onReady = () => finish(true)
      const timer = setTimeout(() => finish(false), budgetMs)
      this.redis.once('ready', onReady)
    })
  }

  /** Record a store failure for the health surface, without leaking anything. */
  private noteFailure(err: unknown): void {
    // Message only. A connection string carries a password and this value is
    // served by /api/health.
    const message = err instanceof Error ? err.message : String(err)
    this.lastError = message.slice(0, 300)
    this.lastErrorAt = Date.now()
    console.error(
      '[RateLimit] shared store unavailable - DENYING protected auth attempts ' +
        'rather than falling back to per-process counters:',
      this.lastError,
    )
  }

  private async withTimeout<T>(op: Promise<T>, budgetMs = this.timeoutMs): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        op,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`rate limiter store did not answer in ${budgetMs}ms`)),
            budgetMs,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const started = Date.now()
    if (!(await this.awaitReady(this.timeoutMs))) {
      this.noteFailure(
        new Error(`store was not ready within ${this.timeoutMs}ms (status: ${this.redis.status})`),
      )
      return storeUnavailable()
    }

    try {
      // Whatever readiness consumed comes off the round trip's budget, so a
      // slow reconnect plus a slow command cannot together exceed the deadline.
      const remainingBudget = Math.max(50, this.timeoutMs - (Date.now() - started))
      const [count, ttl] = (await this.withTimeout(
        this.redis.eval(CONSUME_SCRIPT, 1, key, String(windowMs)) as Promise<[number, number]>,
        remainingBudget,
      )) as [number, number]

      const resetAt = Date.now() + Math.max(0, ttl)

      if (count > limit) {
        return {
          allowed: false,
          outcome: 'limit_exceeded',
          remaining: 0,
          retryAfter: Math.max(1, Math.ceil(ttl / 1000)),
          resetAt,
        }
      }
      return {
        allowed: true, outcome: 'allowed',
        remaining: Math.max(0, limit - count), retryAfter: 0, resetAt,
      }
    } catch (err: any) {
      // FAIL CLOSED, and reported as an outage rather than as a limit. Not a
      // fallback to memory, for the reason in the header.
      //
      // No state is latched: the next call tries again from scratch, so when the
      // connection comes back the limiter recovers on its own without a
      // restart. `lastError` is history for the health surface, not a switch.
      this.noteFailure(err)
      return storeUnavailable()
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.withTimeout(this.redis.del(key))
    } catch (err: any) {
      // A failed reset leaves a counter that expires on its own. It makes the
      // limiter stricter, never weaker, so it is not worth failing a request
      // that has already succeeded.
      console.warn('[RateLimit] could not clear counter:', err?.message ?? err)
    }
  }
}

// ── Selection ────────────────────────────────────────────────────────────────

let backend: RateLimitBackend | null = null
let redisClient: Redis | null = null

/**
 * The ONE place a limiter Redis client is configured.
 *
 * Exported so the tests build their clients exactly the way production does.
 * A suite that constructs its own client with different options is not testing
 * the thing that ships, and this particular option set is where that bit.
 *
 * ── Why the offline queue is ON ─────────────────────────────────────────────
 *
 * The first version set `enableOfflineQueue: false`, reasoning that a limiter
 * must never block behind a reconnect. It does not do that. ioredis rejects
 * EVERY command issued before the connection is ready when the queue is off —
 * including its own HELLO handshake — so the first requests after startup, and
 * after any reconnect, failed instantly. Combined with failing closed, that is
 * an auth outage on every deploy, reported as a rate-limit denial.
 *
 * The queue is the correct behaviour: a command issued during a blip waits for
 * the socket and then runs. What must not happen is waiting FOREVER, and that
 * is `withTimeout`'s job, not the queue's. Bounded queueing plus a short
 * deadline gives the right answer in both cases — a reconnect is survived, a
 * dead store is denied in under a second.
 */
export function createRateLimitRedis(url: string): Redis {
  const { Redis: RedisCtor } = require('ioredis') as typeof import('ioredis')
  const client = new RedisCtor(url, {
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  })
  // Without a handler, a connection error is an unhandled 'error' event and
  // takes the process down — which would turn a Redis blip into a crash loop.
  client.on('error', err =>
    console.error('[RateLimit] redis connection error:', err?.message ?? err),
  )
  return client
}

/**
 * Build the backend the environment declares.
 *
 * Kept lazy so importing the limiter never opens a socket — a unit test, a
 * script or a build step that touches an auth module must not start
 * connecting to Redis as a side effect.
 */
export function getRateLimitBackend(): RateLimitBackend {
  if (backend) return backend

  if (declaredStoreKind() === 'redis') {
    const url = process.env.REDIS_URL?.trim()
    if (!url) {
      // Startup already refuses this. Reaching it here means the check was
      // bypassed, and guessing is not an option for a security control.
      throw new RateLimitStoreMisconfigured(
        'BACKENLY_RATE_LIMIT_STORE=redis requires REDIS_URL to be set.',
      )
    }
    redisClient = createRateLimitRedis(url)
    backend = new RedisRateLimitBackend(redisClient)
    return backend
  }

  backend = new MemoryRateLimitBackend()
  return backend
}

/** Test seam: replace the backend and forget any client. */
export function __setRateLimitBackend(next: RateLimitBackend | null): void {
  backend = next
}

/** Close the shared client, for a clean shutdown or a test teardown. */
export async function closeRateLimitBackend(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => redisClient?.disconnect())
    redisClient = null
  }
  if (backend && backend instanceof MemoryRateLimitBackend) backend.destroy()
  backend = null
}

/**
 * The limiter's current health, for /api/health.
 *
 * Deliberately does NOT construct a backend as a side effect: asking a
 * single-instance self-host deployment whether its limiter is healthy must not
 * be what opens its first Redis connection. An unconfigured limiter reports the
 * memory store, because that is what it will be when something first uses it.
 */
export function rateLimitHealth(): RateLimitHealth {
  if (backend) return backend.health()
  return {
    kind: declaredStoreKind() === 'redis' ? 'redis' : 'memory',
    // Nothing has used the limiter yet, so there is nothing to be unready.
    // Startup has already proven the store answers; see
    // assertSharedStoreIsOperational.
    ready: true,
    lastError: null,
    lastErrorAt: null,
  }
}
