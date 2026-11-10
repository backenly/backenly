/**
 * A key every user of an app sends: a browser key, public and not
 * service-role. Its limit is each client's (lib/security/shared-key-rate.ts),
 * which the console says beside it. Nothing here touches the server, so the
 * console can read it too.
 */
export function isSharedKey(key: { keyType?: string | null; serviceRole?: boolean | null }): boolean {
  return key.keyType === 'public' && !key.serviceRole
}
