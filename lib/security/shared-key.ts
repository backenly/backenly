/**
 * A key every user of an app sends: a browser key, public and not
 * service-role. Its limit is each client's (lib/security/shared-key-rate.ts),
 * which the console says beside it. Nothing here touches the server, so the
 * console can read it too.
 */
export function isSharedKey(key: { keyType?: string | null; serviceRole?: boolean | null }): boolean {
  return key.keyType === 'public' && !key.serviceRole
}

/** Requests one address may send with a shared key per window (lib/security/shared-key-rate.ts). */
export const SHARED_KEY_BURST_LIMIT = 300
/** The window, in seconds. */
export const SHARED_KEY_BURST_WINDOW_SECONDS = 10
