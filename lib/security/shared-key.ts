/**
 * A key every user of an app sends: a browser key, public and not
 * service-role. Its limit is each client's (lib/security/shared-key-rate.ts),
 * which the console says beside it. Nothing here touches the server, so the
 * console can read it too.
 */
export function isSharedKey(key: { keyType?: string | null; serviceRole?: boolean | null }): boolean {
  return key.keyType === 'public' && !key.serviceRole
}

/**
 * Requests one address may send with a shared key per window when its owner
 * has set no rate of its own (lib/security/shared-key-rate.ts): the burst brake.
 */
export const SHARED_KEY_BURST_LIMIT = 300
/** The window, in seconds. */
export const SHARED_KEY_BURST_WINDOW_SECONDS = 10

/** The rate a key has when nobody set one: the schema's default (prisma/schema.prisma, ApiKey). */
export const DEFAULT_KEY_RATE = { limit: 1000, windowSeconds: 3600 } as const

/**
 * What one address may send with a shared key, per window.
 *
 * A rate the key's owner set is each address's limit: raised for traffic that
 * comes from one address by design (their own server rendering pages with the
 * browser key, an office behind one address, a load test), or lowered to hold
 * each visitor to less. The schema's default, which nobody chose, means the
 * burst brake. A key is created with that default, so every key gets the brake
 * until its owner says otherwise.
 */
export function sharedKeyWindow(key: { rateLimit?: number | null; rateLimitWindow?: number | null }): {
  limit: number
  windowSeconds: number
} {
  const limit = key.rateLimit ?? DEFAULT_KEY_RATE.limit
  const windowSeconds = key.rateLimitWindow ?? DEFAULT_KEY_RATE.windowSeconds
  if (limit === DEFAULT_KEY_RATE.limit && windowSeconds === DEFAULT_KEY_RATE.windowSeconds) {
    return { limit: SHARED_KEY_BURST_LIMIT, windowSeconds: SHARED_KEY_BURST_WINDOW_SECONDS }
  }
  return { limit: Math.max(1, limit), windowSeconds: Math.max(1, windowSeconds) }
}

/** "300 / 10 s", "5,000 / 1 h": a window as the console shows it. */
export function shortWindow(w: { limit: number; windowSeconds: number }): string {
  const s = w.windowSeconds
  const span = s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`
  return `${w.limit.toLocaleString('en-US')} / ${span}`
}
