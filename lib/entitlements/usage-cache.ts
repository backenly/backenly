/**
 * A short-lived per-billing-account cache for usage summaries (keyed by the
 * account, lib/usage/account.ts: an organization on Cloud).
 *
 * It lives here rather than in lib/billing because both halves of the split
 * touch it: the public policy layer invalidates it whenever it records usage,
 * and Backenly's commercial usage summary reads and writes it. Leaving it in
 * lib/billing would have meant the public trackers could not invalidate a cache
 * their own writes had just made stale, and a user would have kept seeing a
 * 30-second-old figure after every AI turn.
 *
 * Deliberately untyped in its payload: the shape belongs to whoever caches it,
 * and this module should not need to know what a usage summary contains.
 */
const cache = new Map<string, { data: unknown; expiresAt: number }>()

function key(billingAccountId: string): string {
  return `usage_${billingAccountId}`
}

export function readUsageCache<T>(billingAccountId: string): T | null {
  const hit = cache.get(key(billingAccountId))
  if (!hit || hit.expiresAt <= Date.now()) return null
  return hit.data as T
}

export function writeUsageCache<T>(billingAccountId: string, data: T, ttlMs = 30_000): void {
  cache.set(key(billingAccountId), { data, expiresAt: Date.now() + ttlMs })
}

/** Call after any write that changes what a usage summary would report. */
export function invalidateUsageCache(billingAccountId: string): void {
  cache.delete(key(billingAccountId))
}
