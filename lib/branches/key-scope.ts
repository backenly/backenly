/**
 * Which runtime surfaces a branch-bound API key may reach, and the refusal for
 * every other one.
 *
 * A key bound to a preview branch (`ApiKey.branchId`) is routed to that
 * branch's schema by the data plane: `/api/v1/{projectId}/db/*` and `/api/v2/*`
 * authenticate through getProjectIdFromAuth (server/routes/dynamic.ts), which
 * hands the branch schema to the PostgREST gateway. End-user sign-up, sign-in,
 * refresh and logout resolve the branch the same way
 * (lib/branches/auth-environment.ts). Nothing else is branch-aware. The emailed
 * auth flows, functions, storage, realtime, presence, broadcast, logs, the
 * legacy `/database/*` routes and every Next-owned section resolve to the
 * project's main schema.
 *
 * Those surfaces used to accept the key anyway and serve PRODUCTION. A signup
 * made "on the preview" created a real end user, fired the production signup
 * functions and sent a real email; `/fn/{name}` ran the production function.
 * That is the failure BRANCH_INACTIVE exists to prevent, a preview credential
 * quietly reading and writing production, so it is answered the same way:
 * refused, never routed to main.
 *
 * The check lives at the two doors every runtime request passes through rather
 * than in each route, so a surface added later is refused until someone makes
 * it branch-aware on purpose:
 *   - recordedV1 (lib/traffic/recorded-v1.ts) wraps every Next /api/v1 route,
 *     and a test fails the build when one is not wrapped;
 *   - the Express runtime refuses before the Next proxy and every router
 *     (server/app.ts), which is the door on a self-hosted install.
 */

import { createHash } from 'crypto'
import { prisma } from '@/lib/db/prisma'

export const BRANCH_SURFACE_UNAVAILABLE = 'BRANCH_SURFACE_UNAVAILABLE'

/**
 * Which environment answered, on every data-plane response.
 *
 * A preview key and a main key hit the same URL, so nothing in a response said
 * which schema served it. A test an agent runs "against the preview" could not
 * tell that it was in fact reading production, which is the one mistake a
 * preview environment exists to prevent. Exposed to browsers in server/app.ts
 * and middleware.ts, so a frontend's test can assert it too.
 */
export const ENVIRONMENT_HEADER = 'X-Backenly-Environment'

export function environmentHeaderValue(branchName?: string | null): string {
  return branchName ? `branch:${branchName}` : 'main'
}

/** What a branch-bound key can reach, as a caller should read it. */
export const BRANCH_SCOPED_SURFACES = [
  '/api/v1/{projectId}/db/*',
  '/api/v2/{projectId}/*',
  '/api/v1/{projectId}/auth/{signup,signin,refresh-token,logout}',
] as const

/**
 * The end-user auth endpoints that run on the branch, aliases included.
 *
 * The emailed flows (forgot and reset password, email verification, magic
 * links) are not among them: their link is opened from an inbox with no key,
 * so nothing could say which branch the token in it belongs to.
 */
export const BRANCH_SCOPED_AUTH_ACTIONS: ReadonlySet<string> = new Set([
  'signup', 'register', 'signin', 'login', 'refresh-token', 'refresh', 'logout',
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Is this runtime path served from the branch when the key is bound to one?
 *
 * Takes the request pathname (`/api/v1/<id>/db/todos?x=1`). Anything that is
 * not a recognisable runtime path answers false, so an unknown shape is
 * treated as main-only and refused for a branch key rather than let through.
 */
export function isBranchScopedRuntimePath(pathname: string): boolean {
  const clean = pathname.split(/[?#]/)[0]
  const segments = clean.split('/').filter(Boolean)
  if (segments[0] !== 'api') return false
  if (segments[1] === 'v2') return true
  if (segments[1] !== 'v1') return false

  const rest = segments.slice(2)
  if (rest.length === 0) return false

  if (UUID_RE.test(rest[0])) {
    const section = rest[1]?.toLowerCase()
    // GET /api/v1/{projectId} is the keyless discovery document: it reads no
    // tenant data and ignores the key, so it is not a surface to refuse.
    if (section === undefined) return true
    // /db/{table}/vector-search is served by Next against main, not by the
    // data plane, even though it hangs off the CRUD prefix.
    if (section === 'db') return rest.length >= 3 && rest[3]?.toLowerCase() !== 'vector-search'
    if (section === 'auth') return rest.length === 3 && BRANCH_SCOPED_AUTH_ACTIONS.has(rest[2].toLowerCase())
    return false
  }

  // The legacy `/api/v1/{table}[/{id}]` form, where the key names the project.
  // It reaches the same data plane, except `/fn/{name}`, which runs a function.
  return rest[0].toLowerCase() !== 'fn'
}

interface HeaderSource {
  get(name: string): string | null | undefined
}

/**
 * The API key a request presents, wherever the runtime accepts one from:
 * `x-api-key`, PostgREST's `apikey`, `?apiKey=` / `?api_key=` (EventSource
 * cannot set headers) and `Authorization: Bearer <key>`.
 *
 * A Bearer value that is a JWT is an end-user or platform token, not a key, so
 * it is skipped rather than looked up.
 */
export function presentedApiKey(headers: HeaderSource, url?: URL | null): string | null {
  const header = (headers.get('x-api-key') || headers.get('apikey') || '').trim()
  if (header) return header

  const query = (url?.searchParams.get('apiKey') || url?.searchParams.get('api_key') || '').trim()
  if (query) return query

  const auth = (headers.get('authorization') || '').trim()
  if (auth.toLowerCase().startsWith('bearer ')) {
    const value = auth.slice(7).trim()
    if (value && value.split('.').length !== 3) return value
  }
  return null
}

export interface BoundBranch {
  id: string
  name: string
  status: string
}

const CACHE_TTL_MS = 30_000
const CACHE_CEILING = 10_000
const cache = new Map<string, { branch: BoundBranch | null; at: number }>()

/**
 * The branch a key is bound to, or null for a main key or an unknown value.
 *
 * Cached briefly by key hash. A key's branch is fixed when the key is issued
 * (create_api_key and POST /api/api-keys set it once), so the cache can only be
 * stale for a key that was deleted, which every route's own authentication
 * refuses anyway.
 */
export async function branchBoundToKey(rawKey: string): Promise<BoundBranch | null> {
  const keyHash = createHash('sha256').update(rawKey).digest('hex')
  const now = Date.now()
  const hit = cache.get(keyHash)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.branch

  const row = await prisma.apiKey.findFirst({
    where: { keyHash },
    select: { branch: { select: { id: true, name: true, status: true } } },
  })
  const branch = row?.branch ?? null

  if (cache.size >= CACHE_CEILING) cache.clear()
  cache.set(keyHash, { branch, at: now })
  return branch
}

/** Exported for tests. */
export function clearBranchKeyCache(): void {
  cache.clear()
}

export interface BranchSurfaceRefusal {
  status: 403
  body: {
    error: string
    code: typeof BRANCH_SURFACE_UNAVAILABLE
    branch: string
    branchScoped: readonly string[]
    hint: string
  }
}

export function branchSurfaceRefusal(branch: BoundBranch): BranchSurfaceRefusal {
  return {
    status: 403,
    body: {
      error:
        `This key is bound to the preview branch "${branch.name}", and this endpoint is not branch-scoped: ` +
        'it would read or write production. Only the data API and end-user sign-up, sign-in, refresh ' +
        'and logout are served from a branch.',
      code: BRANCH_SURFACE_UNAVAILABLE,
      branch: branch.name,
      branchScoped: BRANCH_SCOPED_SURFACES,
      hint: 'Use a main key for this endpoint, or test this part of the backend against production deliberately.',
    },
  }
}

/**
 * The branch a request's key is bound to, for the request log.
 *
 * Null for a keyless request, a main key, or a lookup that fails: the log is
 * evidence, and recording must never slow or fail the request it describes.
 * Shares the cache above, so the data plane's own lookups make this free.
 */
export async function branchIdForRequest(headers: HeaderSource, url?: URL | null): Promise<string | null> {
  const key = presentedApiKey(headers, url)
  if (!key) return null
  try {
    return (await branchBoundToKey(key))?.id ?? null
  } catch {
    return null
  }
}

/**
 * The refusal for this request, or null when it may proceed.
 *
 * Costs nothing for a request with no key or on a branch-scoped path, which is
 * nearly all data traffic; only a keyed request to a main-only surface pays one
 * cached lookup. A lookup failure lets the request through to the route, whose
 * own authentication then runs: this check narrows what a branch key reaches,
 * and an outage of it must not take down every keyed route.
 */
export async function refuseBranchKeyOffDataPlane(
  pathname: string,
  headers: HeaderSource,
  url?: URL | null,
): Promise<BranchSurfaceRefusal | null> {
  if (isBranchScopedRuntimePath(pathname)) return null
  const key = presentedApiKey(headers, url)
  if (!key) return null
  let branch: BoundBranch | null
  try {
    branch = await branchBoundToKey(key)
  } catch {
    return null
  }
  return branch ? branchSurfaceRefusal(branch) : null
}
