/**
 * The end user's token in `Authorization: Bearer`, read the same way by both
 * runtimes.
 *
 * The header can carry the project's API key or an end user's session, and only
 * the session is a JWT that names a project: a key is not a JWT, and a platform
 * session names no project. So a Bearer value whose unverified payload has a
 * string `projectId` is taken as the end user, and nothing else is. Nothing here
 * verifies it; the caller resolves it through its revocation and blocked checks.
 *
 * Framework-free, so the Express runtime (server/routes/dynamic.ts) and the Next
 * v1 routes (lib/api/v1/middleware.ts, lib/middleware/apiKeyAuth.ts) apply one
 * rule rather than two that drift.
 */
export function endUserBearerToken(authorization: string | null | undefined): string | undefined {
  if (!authorization || !authorization.startsWith('Bearer ')) return undefined
  const token = authorization.substring(7).trim()
  try {
    const claims: any = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())
    return typeof claims?.projectId === 'string' ? token : undefined
  } catch {
    return undefined
  }
}
