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
    } catch {
      // Blacklist table doesn't exist yet — treat as not revoked.
    }
  }
  return { userId: String(payload.userId), role: payload.role ?? 'user' }
}

/** SHA-256 hash used to look up API keys — shared so every route hashes identically. */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}
