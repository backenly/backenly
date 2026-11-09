/**
 * A KEY EVERY USER OF AN APP SENDS IS COUNTED PER CLIENT
 * =====================================================
 * A key's limit is `rateLimit` requests per `rateLimitWindow` seconds, 1,000
 * an hour unless its owner changes it, and every keyed request used to count
 * against the key itself (api_keys.requestCount at home, the region's
 * public.auth_rate_windows: lib/auth-projection/rate.ts). That is the right
 * budget for a key one caller holds, such as a service-role key on the app's
 * server. A browser key, public and not service-role, is in every end user's
 * bundle, so its one count was everyone's: a few open tabs heartbeating
 * presence spent the hour, and then every request from every user of the app
 * got 429 until the window reset. Anyone who opened the app could spend it on
 * purpose.
 *
 * So a shared key's limit is each client's: every address gets the key's own
 * `rateLimit` per window, and one client at its limit refuses no one else. A
 * request its client's window lets through is still counted against the key,
 * with no cap, for the console's count and the key's last use; that count
 * decides nothing. The address is the one lib/security/client-ip.ts resolves,
 * so a made-up X-Forwarded-For is not a new client.
 *
 * The client windows are kept in the platform's rate-limit store
 * (lib/security/rate-limit-backend.ts): in the process, or in Redis where a
 * deployment runs several. Unlike sign-in's limiter, which denies when that
 * store cannot be reached, a request is let through: this is fair use, not a
 * check of a credential, and the data plane must not go down with Redis.
 *
 * Presence writes spend nothing of a key's limit. They are counted per
 * address before the key is looked up, so a flood of them stops whether or not
 * it is signed in (countPresenceAddress), and per user once the route knows
 * the caller may write as that user (countPresenceWrite).
 */

import type { ClientRateLimitInfo, Store } from 'express-rate-limit'
import type { RateDecision, RateKey } from '@/lib/auth-projection/rate'
import { getRateLimitBackend, type RateLimitResult } from '@/lib/security/rate-limit-backend'

export { isSharedKey } from '@/lib/security/shared-key'

/** The key's own count for a shared key, which refuses nothing: PostgreSQL's largest integer. */
export const UNCAPPED = 2_147_483_647

/** How much of the key's hash marks a rotation, as the region's window keeps it. */
const KEY_MARK_LENGTH = 12

/**
 * Count one request against a key and decide. A shared key's client window
 * decides, and a request it lets through is counted against the key's own
 * window with no cap. Any other key's own window decides, as it always has.
 * `countKey(limit)` counts against the key's own window wherever this process
 * keeps it (home's api_keys row, or the region's window).
 */
export async function countKeyedRequest(
  key: RateKey,
  client: string | null,
  countKey: (limit: number) => Promise<RateDecision>,
): Promise<RateDecision> {
  if (!key.shared) return countKey(key.rateLimit)
  const decision = await countClientRequest(key, client)
  if (decision.allowed) await countKey(UNCAPPED)
  return decision
}

/**
 * Count one request of a shared key against its client's window: the key's
 * own limit and window length, for this address alone. A rotated key, or a
 * new window length, starts new windows, as the key's own count does.
 */
export async function countClientRequest(key: RateKey, client: string | null): Promise<RateDecision> {
  const limit = key.rateLimit ?? 1000
  const windowSeconds = key.rateLimitWindow ?? 3600
  const mark = key.keyHash.slice(0, KEY_MARK_LENGTH)
  return consume(`key-client:${key.id}:${mark}:${windowSeconds}:${client ?? 'unknown'}`, limit, windowSeconds * 1000)
}

/**
 * Presence writes one user may make with one key in a minute. The SDK beats
 * every 25 seconds from each open tab; this leaves room for a dozen tabs and
 * the updates between beats, and stops a client writing in a loop.
 */
export const PRESENCE_WRITES_PER_MINUTE = 60

/**
 * Count a presence join, heartbeat, update or leave. A heartbeat every 25
 * seconds from every open tab would spend a key's limit, a shared key's or
 * not, so presence writes are counted only here: per user, after the presence
 * route has checked that the caller may write as that user.
 */
export async function countPresenceWrite(keyId: string, userId: string): Promise<RateDecision> {
  return consume(`presence:${keyId}:${userId}`, PRESENCE_WRITES_PER_MINUTE, 60_000)
}

/**
 * Presence writes from one address to one project in a minute, signed in or
 * not: a busy office behind one address, a couple of hundred tabs beating
 * every 25 seconds, stays well under it.
 */
export const PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE = 600

/** The window a presence write from `address` to `projectId` is counted in, by both runtimes. */
export function presenceAddressBucket(projectId: string, address: string | null): string {
  return `presence-address:${projectId}:${address ?? 'unknown'}`
}

/**
 * Count a presence write against its address's window, before the key is
 * looked up. The runtime counts the same window through express-rate-limit
 * (server/routes/presence.ts, with platformLimiterStore).
 */
export async function countPresenceAddress(projectId: string, address: string | null): Promise<RateDecision> {
  return consume(presenceAddressBucket(projectId, address), PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE, 60_000)
}

/** The 429 a presence route answers when the user's window, or the address's, is full. */
export function presenceRefusal(
  decision: RateDecision,
  window: 'user' | 'address',
): {
  status: 429
  headers: Record<string, string>
  body: { error: string; code: 'RATE_LIMIT_EXCEEDED'; retryAfter: number }
} {
  const retryAfter = decision.retryAfter ?? 60
  const what =
    window === 'user'
      ? `Presence for this user was written more than ${PRESENCE_WRITES_PER_MINUTE} times in a minute.`
      : `Presence was written more than ${PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE} times in a minute from this address.`
  return {
    status: 429,
    headers: { 'Retry-After': String(retryAfter) },
    body: { error: `${what} Try again in ${retryAfter} second(s).`, code: 'RATE_LIMIT_EXCEEDED', retryAfter },
  }
}

/**
 * An express-rate-limit store over the platform's rate-limit store, so a
 * window the runtime counts with express-rate-limit is the one the Next routes
 * count, in Redis where a deployment runs several instances. A request goes
 * through, as everywhere in this module, when the store cannot be read.
 */
export function platformLimiterStore(limit: number, windowMs: number): Store {
  return {
    async increment(key: string): Promise<ClientRateLimitInfo> {
      const decision = await consume(key, limit, windowMs)
      return { totalHits: decision.allowed ? Math.max(1, limit - decision.remaining) : limit + 1, resetTime: decision.resetAt }
    },
    async decrement(key: string): Promise<void> {
      try {
        await getRateLimitBackend().refund(key)
      } catch {
        // Nothing was counted where the store cannot be reached.
      }
    },
    async resetKey(key: string): Promise<void> {
      try {
        await getRateLimitBackend().reset(key)
      } catch {
        // Nothing was counted where the store cannot be reached.
      }
    },
  }
}

let unavailableNotedAt = 0

/** Take one unit of a window, letting the request through when the store cannot be read. */
async function consume(bucket: string, limit: number, windowMs: number): Promise<RateDecision> {
  let result: RateLimitResult | null = null
  try {
    result = await getRateLimitBackend().consume(bucket, limit, windowMs)
  } catch {
    // A store that cannot even be built; startup refuses that configuration.
  }
  if (!result || result.outcome === 'store_unavailable') {
    if (Date.now() - unavailableNotedAt > 60_000) {
      unavailableNotedAt = Date.now()
      console.warn(
        '[SharedKeyRate] The rate-limit store could not be reached: shared keys and presence writes go uncounted until it can be.',
      )
    }
    return { allowed: true, remaining: limit, resetAt: new Date(Date.now() + windowMs) }
  }
  if (result.allowed) return { allowed: true, remaining: result.remaining, resetAt: new Date(result.resetAt) }
  return { allowed: false, remaining: 0, resetAt: new Date(result.resetAt), retryAfter: result.retryAfter }
}
