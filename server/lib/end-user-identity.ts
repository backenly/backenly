/**
 * Shared end-user identity resolution for Express v1 routes.
 *
 * Every data route that touches workspace tables must resolve the caller's
 * RLS identity the same way, or own_rows policies drift between paths:
 *   - service-role API key            → bypass RLS
 *   - non-service key + X-User-Token  → act as that end-user
 *   - non-service key, no user token  → no user context (own_rows → no rows)
 */

import crypto from 'crypto'
import { verify } from 'jsonwebtoken'
import { prisma } from '@/lib/db'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { noteEndUserActivity } from '@/lib/quota/kernel'
import { crossEnvironmentToken, endUserTokenSecret } from '@/lib/branches/auth-environment'

export interface EndUserIdentity {
  userId: string
  role: string
}

/** The preview branch a request's key is bound to, for end-user tokens. */
export interface EndUserBranch {
  id: string
  name: string
  schemaName: string
}

function bareToken(rawTokenInput: string): string {
  return rawTokenInput.startsWith('Bearer ') ? rawTokenInput.substring(7) : rawTokenInput
}

/**
 * Verify an end-user's X-User-Token / Authorization JWT for a given project and
 * return their id + role — or null if the token is missing, invalid, for a
 * different project, or has been revoked via /auth/logout.
 *
 * With `branch`, the token must have been issued on that branch: it is verified
 * with the branch's derived secret and checked against the branch's own
 * blacklist (lib/branches/auth-environment.ts). Without it, only a production
 * token verifies.
 */
export async function resolveEndUserFromToken(
  projectId: string,
  rawTokenInput: string | undefined,
  branch: EndUserBranch | null = null,
): Promise<EndUserIdentity | 'blocked' | null> {
  if (!rawTokenInput) return null
  const rawToken = bareToken(rawTokenInput)
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { jwtSecret: true },
  })
  if (!project?.jwtSecret) return null
  let payload: any
  try {
    payload = verify(rawToken, endUserTokenSecret(resolveJwtSecret(project.jwtSecret), branch), { algorithms: ['HS256'] })
  } catch {
    return null
  }
  if (payload?.projectId !== projectId || !payload.userId) return null
  if ((payload.br ?? null) !== (branch?.id ?? null)) return null
  // The blacklist and the users table are in the project's database, in its
  // region. Resolved before the fail-open checks below: they accept a token
  // when its status cannot be read, which for a region this process cannot
  // reach would honour every revoked and blocked token. The error fails the
  // request instead.
  const db = await workspaceRawClient(projectId)
  // Honour /auth/logout revocations.
  if (payload.jti) {
    try {
      const schemaName = branch?.schemaName ?? `workspace_${projectId}`
      const rows = await db.$queryRawUnsafe<{ jti: string }[]>(
        `SELECT jti FROM "${schemaName}"."_token_blacklist" WHERE jti = $1 LIMIT 1`,
        payload.jti,
      )
      if (rows.length > 0) return null
    } catch (err: any) {
      // A project that has never revoked a token has no `_token_blacklist`
      // table, so 42P01 genuinely means "nothing can have been revoked" and
      // accepting the token is correct.
      //
      // ANY OTHER failure means revocation status could not be determined, and
      // the token is accepted anyway. That is a deliberate FAIL-OPEN policy, not
      // an accident: failing closed would reject every token during a transient
      // database error, turning a blip into a total auth outage for every
      // end user of every project. Accepting a small revocation window is the
      // better trade at this scale — but it IS a trade, and it was previously
      // made by an empty `catch {}` that nobody could see or revisit.
      //
      // So the unexpected case is now loud. If this ever fires, a revoked token
      // was honoured, and that is a security event worth a human reading.
      const text = String(err?.message ?? err)
      const tableMissing = err?.code === '42P01' || text.includes('42P01')
      if (!tableMissing) {
        console.error(
          `[EndUserIdentity] token revocation check FAILED OPEN for project ${projectId} ` +
          `(jti=${String(payload.jti).slice(0, 8)}…): ${text}. ` +
          `A revoked token would have been accepted.`,
        )
      }
    }
  }
  // Blocking promises "existing JWT tokens stop working immediately"
  // (block_end_user's description and its success message) — which is only
  // true if request-time resolution checks it. Before this check, is_blocked
  // was read at sign-in and refresh alone, so a blocked user's live token
  // kept working for up to seven days. A missing table or column means
  // nobody was ever blocked; any other failure fails open like the
  // revocation check above, and just as loudly.
  try {
    const schemaName = branch?.schemaName ?? `workspace_${projectId}`
    const rows = await db.$queryRawUnsafe<{ is_blocked: boolean | null }[]>(
      `SELECT is_blocked FROM "${schemaName}"."users" WHERE id::text = $1 LIMIT 1`,
      String(payload.userId),
    )
    // 'blocked', not null: the caller answers 403 — the promised behavior —
    // instead of silently serving the request as an anonymous caller.
    if (rows[0]?.is_blocked === true) return 'blocked'
  } catch (err: any) {
    const text = String(err?.message ?? err)
    const absent = err?.code === '42P01' || err?.code === '42703' || text.includes('42P01') || text.includes('42703')
    if (!absent) {
      console.error(
        `[EndUserIdentity] is_blocked check FAILED OPEN for project ${projectId}: ${text}. ` +
        `A blocked user's token would have been accepted.`,
      )
    }
  }
  // An authenticated data request is use: count the end user active this month
  // (throttled to one write a day, never blocks). A preview branch's test users
  // are not the month's active users.
  if (!branch) {
    noteEndUserActivity(projectId, String(payload.userId), typeof payload.email === 'string' ? payload.email : null)
  }
  return { userId: String(payload.userId), role: payload.role ?? 'user' }
}

/**
 * The refusal for a user token that did not verify because it belongs to the
 * other environment, or null when it is simply not valid (which the data plane
 * answers as it always has, by serving the request with no user).
 */
export async function crossEnvironmentUserToken(
  projectId: string,
  rawTokenInput: string,
  branch: EndUserBranch | null,
): Promise<{ code: string; error: string } | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { jwtSecret: true },
  })
  if (!project?.jwtSecret) return null
  return crossEnvironmentToken(bareToken(rawTokenInput), resolveJwtSecret(project.jwtSecret), branch)
}

/** SHA-256 hash used to look up API keys — shared so every route hashes identically. */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}
