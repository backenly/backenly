/**
 * PHASE 3 — the PostgREST gateway.
 *
 * Option A runs ONE PostgREST across every `workspace_{projectId}` schema, which
 * forces two responsibilities into this layer. Both are security-critical, and
 * both are easier to get wrong quietly than loudly.
 *
 * 1. SCHEMA SELECTION. PostgREST picks the schema from the `Accept-Profile` /
 *    `Content-Profile` request headers. If a client can influence those headers,
 *    it can address ANOTHER TENANT'S SCHEMA — a total isolation bypass through
 *    a header. They are therefore always derived server-side from the
 *    authenticated projectId, and any client-supplied copy is stripped before
 *    the request is forwarded. Stripping is not defence in depth here; it is the
 *    defence.
 *
 * 2. IDENTITY. End-user tokens are signed per project with `project.jwtSecret`,
 *    which is what stops cross-project replay. A single PostgREST instance has
 *    exactly ONE `jwt-secret`, so it cannot validate per-project tokens at all.
 *    The gateway is therefore the trust boundary: it verifies the caller's token
 *    against that project's secret, then mints a short-lived INTERNAL token
 *    signed with PostgREST's shared secret carrying only `sub` and `role`.
 *
 * The internal token is deliberately minimal and short-lived. It is a
 * capability for one request, not a session: anything extra in it becomes
 * something a compromised PostgREST could replay.
 */

import jwt from 'jsonwebtoken'

/** Headers a client must never be able to influence. */
export const RESERVED_UPSTREAM_HEADERS = [
  'accept-profile',
  'content-profile',
  'authorization',
  'x-postgrest-internal',
] as const

/** Roles the gateway is willing to mint. Nothing else is representable. */
export type InternalRole = 'authenticated' | 'anon' | 'service_role'

export interface InternalClaims {
  /** End-user id. Absent for anon and service_role. */
  sub?: string
  role: InternalRole
  /** Present for auditing only — never used for schema selection. */
  project_id: string
}

const IDENT = /^[a-z0-9_-]{1,63}$/i

/**
 * The schema this project's requests must be confined to.
 *
 * Validated rather than trusted: the projectId reaches this function from a
 * URL path, and an unvalidated value would be interpolated into a header that
 * selects a PostgreSQL schema.
 */
export function profileForProject(projectId: string): string {
  const id = String(projectId ?? '').trim()
  if (!IDENT.test(id)) {
    throw new Error(`Refusing to build a schema profile from an invalid projectId: "${projectId}"`)
  }
  return `workspace_${id}`
}

/**
 * The schema a request is confined to, given an optional branch.
 *
 * ── Why the branch may only ever arrive from the API KEY ────────────────────
 *
 * The header note at the top of this file is the whole reason this function is
 * shaped the way it is. `Accept-Profile` selects a PostgreSQL schema, so a
 * client able to influence it can address another tenant's data. The gateway
 * answers that by deriving the profile server-side and stripping any client
 * copy.
 *
 * Branches reopen that question: something now has to say WHICH schema, and the
 * obvious design — a `X-Backenly-Branch` request header — is precisely the
 * bypass the stripping exists to prevent, rebuilt one layer up. A header the
 * client controls, feeding the value that decides which schema is read, is the
 * same vulnerability whatever it is called.
 *
 * So the branch is bound to the API KEY (`ApiKey.branchId`) and resolved from
 * the database during authentication. A key issued against a branch reads that
 * branch and nothing else; a key issued against main cannot be pointed at a
 * branch by any request it sends. Choosing an environment becomes an act of
 * credential issuance, which is what it already is everywhere else.
 *
 * `expectedProjectId` is not decoration. The branch schema name is read from a
 * row keyed by the API key, and a mis-scoped or tampered row would otherwise
 * name another project's schema. Verifying the prefix here means the check
 * happens at the point of use rather than trusting whatever the caller resolved.
 */
export function profileForBranchSchema(
  expectedProjectId: string,
  branchSchema: string | null | undefined,
): string {
  const main = profileForProject(expectedProjectId)
  if (!branchSchema) return main

  const candidate = String(branchSchema).trim()
  const prefix = `${main}_br_`
  if (!candidate.startsWith(prefix) || candidate.length <= prefix.length) {
    throw new Error(
      `Refusing to serve branch schema "${branchSchema}": it does not belong to project ${expectedProjectId}.`,
    )
  }
  // The remainder still reaches a header that names a schema, so it is validated
  // rather than trusted, exactly as the projectId is above.
  const suffix = candidate.slice(prefix.length)
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(suffix)) {
    throw new Error(`Refusing to serve branch schema "${branchSchema}": invalid branch identifier.`)
  }
  return candidate
}

/**
 * Build the header set forwarded to PostgREST.
 *
 * Every reserved header is dropped from the incoming request FIRST and then set
 * from server-derived values. Order matters: filtering after setting would let
 * a client-supplied duplicate win depending on header-map semantics.
 */
export function buildUpstreamHeaders(
  incoming: Headers | Record<string, string>,
  opts: {
    projectId: string
    internalToken: string
    method: string
    /**
     * Branch schema to serve instead of main. MUST come from the authenticated
     * API key, never from the request — see profileForBranchSchema. It is
     * re-validated against `projectId` here rather than assumed correct,
     * because this is the last point before the value becomes a header that
     * selects a schema.
     */
    branchSchema?: string | null
  },
): Record<string, string> {
  // Duck-typed rather than `instanceof Headers`: this runs under the Next
  // runtime, Node, and Jest, which do not always share the same Headers class,
  // and a failed instanceof would silently fall through to Object.entries and
  // read NOTHING — dropping the client's headers is harmless, but the same
  // mistake in the opposite direction is not, so it is never guessed.
  const entries: Array<[string, string]> = []
  const anyIncoming = incoming as any
  if (anyIncoming && typeof anyIncoming.forEach === 'function' && typeof anyIncoming.get === 'function') {
    anyIncoming.forEach((value: string, key: string) => entries.push([key, value]))
  } else {
    entries.push(...Object.entries((incoming as Record<string, string>) ?? {}))
  }

  const reserved = new Set<string>(RESERVED_UPSTREAM_HEADERS)
  const out: Record<string, string> = {}

  for (const [rawKey, value] of entries) {
    const key = rawKey.toLowerCase()
    if (reserved.has(key)) continue
    // Hop-by-hop headers must not be proxied.
    if (key === 'host' || key === 'connection' || key === 'content-length') continue
    // The caller's own credentials stop here — the gateway is the boundary.
    if (key === 'x-api-key' || key === 'x-user-token') continue
    out[key] = value
  }

  const profile = profileForBranchSchema(opts.projectId, opts.branchSchema)
  out['accept-profile'] = profile
  // PostgREST reads Content-Profile (not Accept-Profile) for writes, so a
  // gateway that set only the former would leave mutations pointed at the
  // default schema while reads were correctly scoped.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(opts.method.toUpperCase())) {
    out['content-profile'] = profile
  }
  out['authorization'] = `Bearer ${opts.internalToken}`

  return out
}

/**
 * Claims for the internal token.
 *
 * `service_role` is only ever produced from a server-side decision (an owner
 * API key), never from anything the caller can assert.
 */
export function internalClaimsFor(input: {
  projectId: string
  endUserId?: string | null
  serviceRole?: boolean
}): InternalClaims {
  const projectId = profileForProject(input.projectId).replace(/^workspace_/, '')

  if (input.serviceRole) {
    return { role: 'service_role', project_id: projectId }
  }
  if (input.endUserId) {
    return { role: 'authenticated', sub: String(input.endUserId), project_id: projectId }
  }
  return { role: 'anon', project_id: projectId }
}

/** Seconds an internal token stays valid. One request's worth, not a session. */
export const INTERNAL_TOKEN_TTL_SECONDS = 60

export function mintInternalToken(
  claims: InternalClaims,
  secret: string,
  ttlSeconds: number = INTERNAL_TOKEN_TTL_SECONDS,
): string {
  if (!secret) {
    // Failing closed matters: an unsigned or default-signed token would be
    // accepted by PostgREST and grant whatever role it names.
    throw new Error('POSTGREST_JWT_SECRET is not configured — refusing to mint an internal token.')
  }
  return jwt.sign(claims as object, secret, {
    algorithm: 'HS256',
    expiresIn: ttlSeconds,
  })
}

export function verifyInternalToken(token: string, secret: string): InternalClaims {
  return jwt.verify(token, secret, { algorithms: ['HS256'] }) as unknown as InternalClaims
}

/**
 * Target URL on the PostgREST instance.
 *
 * The table segment is validated because it lands in a URL path; the rest of
 * the query string is forwarded untouched so PostgREST's own grammar
 * (`select=`, `order=`, `eq.`, embedded resources) keeps working.
 */
export function upstreamUrl(
  baseUrl: string,
  table: string,
  search: string,
): string {
  const name = String(table ?? '').trim()
  if (!IDENT.test(name)) {
    throw new Error(`Invalid table name in runtime path: "${table}"`)
  }
  const base = baseUrl.replace(/\/$/, '')
  const qs = search && search !== '?' ? (search.startsWith('?') ? search : `?${search}`) : ''
  return `${base}/${name}${qs}`
}
