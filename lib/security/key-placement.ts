/**
 * WHERE A KEY MAY BE USED — enforced at the runtime's two doors
 * ============================================================
 *
 * Backenly issues keys to two different callers, and each is safe only in its
 * own place:
 *
 *   - An MCP key (`mcp_live_…`, `ApiKey.scope = 'mcp'`, and the OAuth
 *     connections that share its row) drives Backenly's own tools for a coding
 *     agent: migrations, row writes as the project owner, RLS policy, new keys.
 *     It belongs in the agent's MCP config and nowhere else.
 *   - A project key (`proj_live_…` publishable, `svc_live_…` service role) is
 *     what an APP sends to the runtime API, /api/v1 and /api/v2.
 *
 * The MCP surface has always refused a project key (WRONG_SCOPE in
 * lib/mcp/auth.ts). The runtime never refused an MCP key: getProjectIdFromAuth
 * served any row its hash matched, as service role. So an agent building a
 * frontend reached for the one key it already held, its own, watched it work
 * from curl and from Node, and shipped it in the bundle. The browser guard then
 * refused it as SERVICE_ROLE_IN_BROWSER, which contained the leak but pointed at
 * the wrong fix ("keep it on a server") for a key that should never have been
 * in the app at all. Reported from a real build on 2026-10-09.
 *
 * Two rules, one gate:
 *
 *   1. an MCP credential is never served by the runtime API, from anywhere;
 *   2. a service-role key is never served to a browser
 *      (lib/security/service-role-exposure.ts decides what a browser is).
 *
 * The gate runs at the two doors every runtime request passes through, the same
 * two lib/branches/key-scope.ts uses: server/app.ts in front of the Next proxy
 * and every router, and recordedV1 around every Next /api/v1 and /api/v2 route.
 * Both run before any route authenticates, so a refused request spends none of
 * the key's rate limit. The key's own authentication repeats both rules
 * (getProjectIdFromAuth, v1AuthMiddleware, v1ApiMiddleware), so a lookup failure
 * here only moves the refusal one step later; it never admits the key.
 */

import { createHash } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { presentedApiKey } from '@/lib/branches/key-scope'
import {
  SERVICE_ROLE_IN_BROWSER,
  detectBrowserOrigin,
  recordServiceRoleBrowserBlock,
  serviceRoleRefusalMessage,
} from '@/lib/security/service-role-exposure'

export const MCP_KEY_IN_APP = 'MCP_KEY_IN_APP'

/**
 * Codes that refuse a VALID key because of where it was used.
 *
 * They answer 403, never 401: a 401 tells the caller the credential is wrong and
 * sends them to re-issue it, while the fix here is a different key or a
 * different place for this one.
 */
export function isKeyPlacementRefusal(code: string | null | undefined): boolean {
  return code === MCP_KEY_IN_APP || code === SERVICE_ROLE_IN_BROWSER
}

/** Is this key row an agent's MCP credential: a minted MCP key or an OAuth connection? */
export function isMcpCredential(row: { scope?: string | null; keyType?: string | null }): boolean {
  return row.scope === 'mcp' || row.keyType === 'mcp' || row.keyType === 'mcp_oauth'
}

/** Why the runtime refused an MCP key. Read by the developer or agent at the moment it can act. */
export function mcpKeyRefusalMessage(keyName: string | null): string {
  const which = keyName ? `The key "${keyName}"` : 'This key'
  return (
    `${which} is an MCP key. It lets a coding agent run Backenly's tools, and the runtime API ` +
    `never accepts it, from a browser or from a server: it can change the backend and read past ` +
    `row-level security, so it must not be in an app at all.`
  )
}

/** Which key the app needs instead, and how to get one from either side. */
export const MCP_KEY_HINT =
  'Use a project key in the app. For browser or mobile code, create a client key: ' +
  'connect { action: "create_api_key", description: "web app" } from your agent, or ' +
  'Settings → API keys → New key → Client in the dashboard. It is bound by row-level ' +
  "security, and writes also need the signed-in user's X-User-Token. Pass serviceRole: true " +
  'only for a key that stays on a server. If this MCP key was committed or shipped, revoke it ' +
  'in Connect → Agents and generate a new one.'

export interface KeyPlacementRefusal {
  status: 403
  body: Record<string, string>
}

/**
 * A refusal in the error vocabulary of the surface that was called.
 *
 * /api/v1 answers `{ error, code, hint }`, as the data plane and the branch
 * refusal do. /api/v2 promises PostgREST's grammar, whose clients read
 * `message`, so it answers `{ code, message, hint }` as server/routes/v2.ts does.
 */
function refusal(pathname: string, code: string, message: string, hint?: string): KeyPlacementRefusal {
  const v2 = /^\/api\/v2(\/|$)/.test(pathname.split(/[?#]/)[0])
  const withHint = hint ? { hint } : {}
  return {
    status: 403,
    body: v2 ? { code, message, ...withHint } : { error: message, code, ...withHint },
  }
}

export function mcpKeyInAppRefusal(keyName: string | null, pathname: string): KeyPlacementRefusal {
  return refusal(pathname, MCP_KEY_IN_APP, mcpKeyRefusalMessage(keyName), MCP_KEY_HINT)
}

export function serviceRoleInBrowserRefusal(keyName: string | null, pathname: string): KeyPlacementRefusal {
  return refusal(pathname, SERVICE_ROLE_IN_BROWSER, serviceRoleRefusalMessage(keyName))
}

interface PlacementFacts {
  id: string
  name: string | null
  keyPrefix: string | null
  projectId: string | null
  mcp: boolean
  serviceRole: boolean
}

const CACHE_TTL_MS = 30_000
const CACHE_CEILING = 10_000
const cache = new Map<string, { facts: PlacementFacts | null; at: number }>()

/**
 * What the gate needs to know about a presented key, or null for a value that is
 * not a key at all.
 *
 * Cached briefly by hash, as branchBoundToKey is. A key's scope and service role
 * are fixed when it is issued, so a stale entry can only describe a key that has
 * since been revoked, and the gate only ever refuses: no entry, stale or fresh,
 * admits a request the route's own authentication would not.
 */
async function placementFacts(rawKey: string): Promise<PlacementFacts | null> {
  const keyHash = createHash('sha256').update(rawKey).digest('hex')
  const now = Date.now()
  const hit = cache.get(keyHash)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.facts

  const row = await prisma.apiKey.findFirst({
    where: { keyHash },
    select: { id: true, name: true, keyPrefix: true, projectId: true, scope: true, keyType: true, serviceRole: true },
  })
  const facts: PlacementFacts | null = row
    ? {
        id: row.id,
        name: row.name ?? null,
        keyPrefix: row.keyPrefix ?? null,
        projectId: row.projectId ?? null,
        mcp: isMcpCredential(row),
        serviceRole: !!row.serviceRole,
      }
    : null

  if (cache.size >= CACHE_CEILING) cache.clear()
  cache.set(keyHash, { facts, at: now })
  return facts
}

/** Exported for tests. */
export function clearKeyPlacementCache(): void {
  cache.clear()
}

interface HeaderSource {
  get(name: string): string | null | undefined
}

/** The headers detectBrowserOrigin reads, from either runtime's header accessor. */
const BROWSER_SIGNALS = ['origin', 'referer', 'user-agent', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-mode']

function browserSignals(headers: HeaderSource): Record<string, string | undefined> {
  const bag: Record<string, string | undefined> = {}
  for (const name of BROWSER_SIGNALS) bag[name] = headers.get(name) ?? undefined
  return bag
}

/**
 * The refusal for this request, or null when it may go on to its route.
 *
 * A keyless request costs nothing; a keyed one costs one cached lookup. A failed
 * lookup lets the request through to the route, whose own authentication refuses
 * the same keys.
 */
export async function refuseMisplacedKey(
  pathname: string,
  headers: HeaderSource,
  url?: URL | null,
  method = 'GET',
): Promise<KeyPlacementRefusal | null> {
  const key = presentedApiKey(headers, url)
  if (!key) return null

  let facts: PlacementFacts | null
  try {
    facts = await placementFacts(key)
  } catch {
    return null
  }
  if (!facts) return null

  // Checked first: it is refused from anywhere, and naming the browser would
  // point the caller at the wrong fix.
  if (facts.mcp) return mcpKeyInAppRefusal(facts.name, pathname)

  if (facts.serviceRole) {
    const verdict = detectBrowserOrigin(browserSignals(headers))
    if (verdict.isBrowser) {
      // The same evidence the inner guards record, so the exposure finding
      // (detectServiceRoleKeyExposure) sees a refusal made here too.
      if (facts.projectId) {
        recordServiceRoleBrowserBlock({
          projectId: facts.projectId,
          apiKeyId: facts.id,
          keyName: facts.name,
          keyPrefix: facts.keyPrefix,
          verdict,
          method,
          path: pathname,
        }).catch(() => {})
      }
      return serviceRoleInBrowserRefusal(facts.name, pathname)
    }
  }

  return null
}
