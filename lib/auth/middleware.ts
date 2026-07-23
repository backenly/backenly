import { NextRequest } from 'next/server'
import { verifySession } from './session'
import { extractTokenFromHeader } from './jwt'
import { prisma } from '@/lib/db/prisma'

export interface AuthenticatedRequest extends NextRequest {
  userId?: string
  userEmail?: string
  userRole?: string
}

// In-memory dedupe so we don't hammer the DB with one write per authenticated
// request. 60s window keeps "last active" accurate within a minute while
// dropping ~99% of writes for active users. Per-process; PM2 cluster mode
// would mean N writes/min/user worst case, still negligible.
const LAST_ACTIVE_WINDOW_MS = 60 * 1000
const lastActiveTouchedAt = new Map<string, number>()

function touchLastActive(userId: string): void {
  const now = Date.now()
  const prev = lastActiveTouchedAt.get(userId) ?? 0
  if (now - prev < LAST_ACTIVE_WINDOW_MS) return
  lastActiveTouchedAt.set(userId, now)

  // Fire-and-forget. Failure must never block auth (e.g. column missing
  // mid-deploy before `db:push` lands the new field).
  prisma.user
    .update({ where: { id: userId }, data: { lastActiveAt: new Date(now) } })
    .catch(() => {
      // Roll back the dedupe stamp so the next request retries.
      lastActiveTouchedAt.delete(userId)
    })
}

async function ensureUserCanAuthenticate(userId: string): Promise<string | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { suspendedAt: true, deletedAt: true },
    })
    if (user?.deletedAt) return 'Account no longer exists'
    if (user?.suspendedAt) return 'Account suspended. Contact support.'
    return null
  } catch {
    return null
  }
}

interface AuthResult {
  authenticated: boolean
  userId?: string
  userEmail?: string
  userRole?: string
  error?: string
}

/**
 * Resolve a single session token into an identity.
 *
 * The three-way return lets the caller try credentials in order:
 *   - null                           → token absent, or its signature is
 *                                      invalid/expired. Soft failure: try the
 *                                      next credential (e.g. fall back to cookie).
 *   - { authenticated: true, … }     → success.
 *   - { authenticated: false, error} → hard stop (account suspended/deleted).
 *                                      The token itself is valid, so trying a
 *                                      different credential for the same user is
 *                                      pointless — surface this immediately.
 */
async function authenticateWithToken(token: string | null | undefined): Promise<AuthResult | null> {
  if (!token) return null

  const session = await verifySession(token)
  if (!session.valid) return null

  if (session.userId) {
    const statusError = await ensureUserCanAuthenticate(session.userId)
    if (statusError) return { authenticated: false, error: statusError }
    touchLastActive(session.userId)
  }

  return {
    authenticated: true,
    userId: session.userId,
    userEmail: session.email,
    userRole: session.role,
  }
}

/**
 * Middleware to authenticate requests.
 *
 * Accepts EITHER an `Authorization: Bearer` token or the httpOnly `auth-token`
 * cookie, and — critically — falls back from one to the other. The Bearer token
 * (used by API clients and the dashboard's localStorage copy) is tried first; if
 * it is absent OR stale/expired, we fall back to the session cookie.
 *
 * Why the fallback matters: login issues two INDEPENDENT credentials — a 7-day
 * httpOnly cookie that auto-renews via a 30-day refresh token, and a copy of the
 * JWT the browser keeps in localStorage that is never refreshed after login. The
 * two drift apart. A browser whose localStorage token has expired still holds a
 * perfectly valid, auto-renewing session cookie. Validating only the Bearer and
 * refusing the cookie 401'd every panel that sent the stale token, while the
 * cookie-only surfaces (SSR, sidebar counts) kept working — the exact split-brain
 * that made Functions / Storage / Auth / Realtime render empty on one device but
 * not another. Falling back to the cookie makes a stale localStorage token
 * harmless as long as the session cookie is still valid.
 */
export async function authenticateRequest(request: NextRequest): Promise<AuthResult> {
  const bearerToken = extractTokenFromHeader(request.headers.get('authorization'))
  const cookieToken = request.cookies?.get('auth-token')?.value ?? null

  // Bearer first, then cookie. Dedupe so an identical token (some clients send
  // the same JWT in both the header and the cookie) isn't verified twice.
  const candidates = Array.from(new Set([bearerToken, cookieToken].filter(Boolean))) as string[]

  for (const token of candidates) {
    const result = await authenticateWithToken(token)
    if (result) return result // success, or a hard stop (suspended/deleted)
  }

  return {
    authenticated: false,
    error: candidates.length
      ? 'Invalid or expired session'
      : 'No authentication token provided',
  }
}

/**
 * Require authentication - throws if not authenticated
 */
export async function requireAuth(request: NextRequest): Promise<{
  userId: string
  userEmail: string
  userRole?: string
}> {
  const auth = await authenticateRequest(request)

  if (!auth.authenticated || !auth.userId || !auth.userEmail) {
    throw new Error(auth.error || 'Authentication required')
  }

  return {
    userId: auth.userId,
    userEmail: auth.userEmail,
    userRole: auth.userRole,
  }
}

/**
 * Require admin role.
 * Returns a 403 NextResponse when the caller is not an admin, null otherwise.
 *
 * "Admin" is defined as:
 *   1. userRole === 'admin' (stored on the session/JWT)  OR
 *   2. userEmail matches FOUNDER_EMAIL env var (emergency founder access)
 *
 * Usage in route handlers:
 *   const adminError = await requireAdmin(request)
 *   if (adminError) return adminError
 */
export async function requireAdmin(request: NextRequest): Promise<import('next/server').NextResponse | null> {
  const { NextResponse } = await import('next/server')
  const auth = await authenticateRequest(request)

  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? 'Authentication required' },
      { status: 401 }
    )
  }

  const founderEmail = process.env.FOUNDER_EMAIL
  const isFounder = founderEmail && auth.userEmail?.toLowerCase() === founderEmail.toLowerCase()
  const isAdminRole = auth.userRole === 'admin'

  if (!isFounder && !isAdminRole) {
    return NextResponse.json(
      { error: 'Admin access required' },
      { status: 403 }
    )
  }

  return null
}
