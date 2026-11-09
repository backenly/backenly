/**
 * AN ADMIN-ROLE KEY BELONGS ON A SERVER
 * ====================================
 *
 * Until GHSA-348x every project's Default Key was minted with the admin role
 * and the `proj_live_` prefix, which Backenly documents as "bound by row-level
 * security; safe in a browser bundle". The admin role skips every permission
 * gate (lib/api/v1/middleware.ts requirePermission): storage treats it as an
 * operator that lists, downloads and deletes every file, private and
 * owner-only included, and it reaches ai/generate. The browser guard refused
 * only service-role keys, so such a key answered any browser.
 *
 * New projects' Default Key is publishable now (lib/projects/default-api-key.ts)
 * and no new key may carry the admin role without being a service key
 * (app/api/api-keys/route.ts). This decides what the keys already issued that
 * way get from a browser:
 *
 *   until ADMIN_KEYS_SERVER_ONLY_FROM   served, and the use is recorded
 *                                       (ADMIN_KEY_BROWSER_USE, at most once a
 *                                       quarter hour per key per process), so the
 *                                       owners who have one in a frontend can be
 *                                       told before it stops working there;
 *   from that date                      refused with ADMIN_KEY_IN_BROWSER (403),
 *                                       as a service-role key is.
 *
 * Unset, the date never comes: nothing is refused, everything is recorded.
 * scripts/report-admin-keys-in-browsers.ts lists who to tell.
 *
 * The rule runs wherever the service-role rule runs: the runtime's door
 * (lib/security/key-placement.ts) and each route's own authentication.
 */

import { prisma } from '@/lib/db/prisma'
import type { BrowserOriginVerdict } from './service-role-exposure'

export const ADMIN_KEY_IN_BROWSER = 'ADMIN_KEY_IN_BROWSER'
export const ADMIN_KEY_BROWSER_USE = 'ADMIN_KEY_BROWSER_USE'

/** Recording at most this often per key and process: the evidence is that it happens, not a log of each request. */
const RECORD_EVERY_MS = 15 * 60_000
const lastRecorded = new Map<string, number>()

/**
 * An admin-role key that row-level security binds: what every project's Default
 * Key was. Not a service key (those are already server-only), not a platform
 * dashboard key, not an agent's MCP key.
 */
export function isRlsBoundAdminKey(key: {
  role?: string | null
  serviceRole?: boolean | null
  keyType?: string | null
  scope?: string | null
}): boolean {
  return key.role === 'admin' && !key.serviceRole && key.keyType !== 'dashboard' && key.scope !== 'mcp'
}

/** When such keys stop answering browsers, or null for "not yet decided". */
export function adminKeysServerOnlyFrom(): Date | null {
  const raw = process.env.ADMIN_KEYS_SERVER_ONLY_FROM?.trim()
  if (!raw) return null
  const at = new Date(raw)
  return Number.isNaN(at.getTime()) ? null : at
}

export function adminKeyRefusalMessage(keyName: string | null): string {
  const which = keyName ? `The key "${keyName}"` : 'This key'
  return (
    `${which} has the admin role: it lists, downloads and deletes every stored file and skips every ` +
    `permission check, so it is for servers and never answers a browser. Use a publishable key in ` +
    `browser code (Settings → API keys → New key → Client), and keep this one on your server.`
  )
}

/**
 * What a request with an admin-role, row-level-security-bound key gets from a
 * browser: a refusal message from the cutoff on, null (served) before it, with
 * the use recorded.
 */
export function adminKeyInBrowser(
  key: { id: string; name: string | null; keyPrefix: string | null; projectId: string | null },
  verdict: BrowserOriginVerdict,
  request: { method: string; path: string },
  now: Date = new Date(),
): { message: string } | null {
  if (!verdict.isBrowser) return null
  const from = adminKeysServerOnlyFrom()
  if (from && now >= from) return { message: adminKeyRefusalMessage(key.name) }
  if (key.projectId) recordAdminKeyBrowserUse({ ...key, projectId: key.projectId }, verdict, request, now).catch(() => {})
  return null
}

async function recordAdminKeyBrowserUse(
  key: { id: string; name: string | null; keyPrefix: string | null; projectId: string },
  verdict: BrowserOriginVerdict,
  request: { method: string; path: string },
  now: Date,
): Promise<void> {
  const last = lastRecorded.get(key.id)
  if (last !== undefined && now.getTime() - last < RECORD_EVERY_MS) return
  lastRecorded.set(key.id, now.getTime())
  if (lastRecorded.size > 10_000) lastRecorded.clear()
  await prisma.auditLog.create({
    data: {
      projectId: key.projectId,
      action: ADMIN_KEY_BROWSER_USE,
      type: 'security',
      details: JSON.stringify({
        apiKeyId: key.id,
        keyName: key.name,
        keyPrefix: key.keyPrefix,
        origin: verdict.origin,
        signal: verdict.signal,
        method: request.method,
        // Path only: a query string routinely carries filter values that are user data.
        path: request.path.split('?')[0],
      }),
      timestamp: now,
    },
  })
}

/** For tests: forget what was recorded when. */
export function clearAdminKeyBrowserRecords(): void {
  lastRecorded.clear()
}
