/**
 * The token the runtime mints for one request, checked before anything else.
 *
 * The runtime (lib/postgrest/gateway.ts) authenticates the caller, then mints a
 * 60 s HS256 token with the region's PostgREST secret. For a project with a
 * database of its own the token also names the project (`aud`) and its
 * database (`db`). This host starts a PostgREST process only for a token that
 * is signed with that secret, unexpired, addressed to the project in the path,
 * and names a project database, so nothing but the runtime can make it start
 * one. Each child is configured with the same secret and `PGRST_JWT_AUD`, so
 * PostgREST checks the same token again.
 *
 * Node's own crypto, no dependency: the host carries no library that could
 * accept an algorithm it did not ask for.
 */

import { createHmac, timingSafeEqual } from 'crypto'

/**
 * A project database: `p_` and 32 lowercase hex digits. The same pattern as
 * DEDICATED_DATABASE_NAME in lib/postgrest/gateway.ts (a unit test holds the
 * two equal). Validated, never trusted: it becomes the database a child
 * connects to.
 */
export const PROJECT_DATABASE_NAME = /^p_[0-9a-f]{32}$/

/** A project id as the runtime's gateway accepts one (IDENT in lib/postgrest/gateway.ts). */
export const PROJECT_ID = /^[a-z0-9_-]{1,63}$/i

/** The roles the runtime's gateway mints (InternalRole). */
export const MINTED_ROLES: ReadonlySet<string> = new Set(['anon', 'authenticated', 'service_role'])

/** Seconds of clock difference tolerated between the runtime's tasks and this one. */
export const CLOCK_TOLERANCE_SECONDS = 5

export interface HostClaims {
  role?: string
  sub?: string
  project_id?: string
  /** The project the token was minted for. */
  aud: string
  /** The project's database. */
  db: string
  exp: number
  iat?: number
  nbf?: number
}

export type TokenVerdict =
  | { ok: true; claims: HostClaims; token: string }
  | { ok: false; status: 401 | 403; code: string; message: string }

const BASE64URL = /^[A-Za-z0-9_-]+$/

function refuse(status: 401 | 403, code: string, message: string): TokenVerdict {
  return { ok: false, status, code, message }
}

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The bearer token in an Authorization header, or null. */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null
  const match = /^Bearer[ ]+([^\s]+)[ ]*$/i.exec(header)
  return match ? match[1] : null
}

/**
 * Verify a token for a request addressed to `projectId`.
 *
 * 401 for anything that is not a valid, unexpired token signed with the
 * secret; 403 for a valid token that is not for this project or names no
 * project database.
 */
export function verifyHostToken(
  token: string | null,
  secret: string,
  projectId: string,
  nowMs: number = Date.now(),
): TokenVerdict {
  if (!secret) return refuse(401, 'TOKEN_INVALID', 'This host has no secret to verify tokens with.')
  if (!token) return refuse(401, 'UNAUTHORIZED', 'A bearer token is required.')

  const parts = token.split('.')
  if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) {
    return refuse(401, 'TOKEN_INVALID', 'The token is not a signed JWT.')
  }
  const [headerPart, payloadPart, signaturePart] = parts

  const header = decodeJson(headerPart)
  if (!isRecord(header) || header.alg !== 'HS256') {
    return refuse(401, 'TOKEN_INVALID', 'The token must be signed with HS256.')
  }
  if (header.typ !== undefined && header.typ !== 'JWT') {
    return refuse(401, 'TOKEN_INVALID', 'The token is not a JWT.')
  }
  if (header.crit !== undefined) {
    return refuse(401, 'TOKEN_INVALID', 'The token asks for extensions this host does not understand.')
  }

  // Compared as the base64url text the signer produced, in constant time. A
  // signature that decodes to the same bytes under another spelling is refused.
  const expected = Buffer.from(
    createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${headerPart}.${payloadPart}`).digest('base64url'),
    'utf8',
  )
  const given = Buffer.from(signaturePart, 'utf8')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return refuse(401, 'TOKEN_INVALID', 'The token signature does not verify.')
  }

  const claims = decodeJson(payloadPart)
  if (!isRecord(claims)) return refuse(401, 'TOKEN_INVALID', 'The token carries no claims.')

  const now = nowMs / 1000
  const { exp, nbf, iat } = claims
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return refuse(401, 'TOKEN_INVALID', 'The token must expire.')
  }
  if (now >= exp + CLOCK_TOLERANCE_SECONDS) return refuse(401, 'TOKEN_EXPIRED', 'The token has expired.')
  if (nbf !== undefined && (typeof nbf !== 'number' || now < nbf - CLOCK_TOLERANCE_SECONDS)) {
    return refuse(401, 'TOKEN_INVALID', 'The token is not valid yet.')
  }
  if (iat !== undefined && (typeof iat !== 'number' || iat > now + CLOCK_TOLERANCE_SECONDS)) {
    return refuse(401, 'TOKEN_INVALID', 'The token was issued in the future.')
  }

  // A string, exactly the project in the path. A list of audiences is refused:
  // the runtime mints one project per token, and a token naming several could
  // be sent to any of them.
  if (typeof claims.aud !== 'string' || claims.aud !== projectId) {
    return refuse(403, 'TOKEN_AUDIENCE_MISMATCH', 'The token was not minted for this project.')
  }
  if (claims.project_id !== undefined && claims.project_id !== claims.aud) {
    return refuse(403, 'TOKEN_AUDIENCE_MISMATCH', 'The token names two different projects.')
  }
  if (typeof claims.db !== 'string' || !PROJECT_DATABASE_NAME.test(claims.db)) {
    return refuse(403, 'TOKEN_DATABASE_INVALID', 'The token does not name a project database.')
  }
  if (claims.role !== undefined && (typeof claims.role !== 'string' || !MINTED_ROLES.has(claims.role))) {
    return refuse(403, 'TOKEN_ROLE_INVALID', 'The token names a role the runtime does not mint.')
  }
  if (claims.sub !== undefined && typeof claims.sub !== 'string') {
    return refuse(401, 'TOKEN_INVALID', 'The token subject is not a string.')
  }

  return { ok: true, claims: claims as unknown as HostClaims, token }
}
