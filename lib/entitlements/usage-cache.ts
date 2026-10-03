/**
 * A short-lived per-user cache for usage summaries.
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

function key(userId: string): string {
  return `usage_${userId}`
}

export function readUsageCache<T>(userId: string): T | null {
  const hit = cache.get(key(userId))
  if (!hit || hit.expiresAt <= Date.now()) return null
  return hit.data as T
}

export function writeUsageCache<T>(userId: string, data: T, ttlMs = 30_000): void {
  cache.set(key(userId), { data, expiresAt: Date.now() + ttlMs })
}

/** Call after any write that changes what a usage summary would report. */
export function invalidateUsageCache(userId: string): void {
  cache.delete(key(userId))
}
