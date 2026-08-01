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
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'

export interface EndUserIdentity {
  userId: string
  role: string
}

/**
 * Verify an end-user's X-User-Token / Authorization JWT for a given project and
 * return their id + role — or null if the token is missing, invalid, for a
 * different project, or has been revoked via /auth/logout.
 */
export async function resolveEndUserFromToken(
  projectId: string,
  rawTokenInput: string | undefined,
): Promise<EndUserIdentity | null> {
  if (!rawTokenInput) return null
  const rawToken = rawTokenInput.startsWith('Bearer ') ? rawTokenInput.substring(7) : rawTokenInput
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { jwtSecret: true },
  })
  if (!project?.jwtSecret) return null
  let payload: any
  try {
    payload = verify(rawToken, resolveJwtSecret(project.jwtSecret), { algorithms: ['HS256'] })
  } catch {
    return null
  }
  if (payload?.projectId !== projectId || !payload.userId) return null
  // Honour /auth/logout revocations.
  if (payload.jti) {
    try {
      const schemaName = `workspace_${projectId}`
      const rows = await prisma.$queryRawUnsafe<{ jti: string }[]>(
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
  return { userId: String(payload.userId), role: payload.role ?? 'user' }
}

/** SHA-256 hash used to look up API keys — shared so every route hashes identically. */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}
