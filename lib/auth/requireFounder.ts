import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from './middleware'
import { requireAdminSignature } from './adminSigning'

const FOUNDER_EMAIL = process.env.FOUNDER_EMAIL

/**
 * Require that the request comes from the founder/admin (#70, #116).
 *
 * Two-factor admin auth — BOTH must pass:
 *   1. JWT check: user email matches FOUNDER_EMAIL OR userRole is admin/super_admin
 *   2. HMAC signature check: X-Admin-Timestamp + X-Admin-Signature headers
 *      (prevents a stolen JWT from being replayed to destructive admin endpoints)
 *
 * Returns a 403 response if not authorized, null if authorized.
 *
 * Usage:
 *   const authError = await requireFounder(request)
 *   if (authError) return authError
 */
export async function requireFounder(
  request: NextRequest
): Promise<NextResponse | null> {
  const auth = await authenticateRequest(request)

  if (!auth.authenticated || !auth.userId || !auth.userEmail) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  const isFounder = FOUNDER_EMAIL && auth.userEmail.toLowerCase() === FOUNDER_EMAIL.toLowerCase()
  const isAdminRole = auth.userRole === 'admin' || auth.userRole === 'super_admin'

  if (!isFounder && !isAdminRole) {
    console.warn(
      `[Security] Unauthorized admin access attempt by ${auth.userEmail} (role: ${auth.userRole}) from ${request.headers.get('x-forwarded-for') ?? 'unknown IP'}`
    )
    return NextResponse.json(
      { error: 'Forbidden' },
      { status: 403 }
    )
  }

  // ── Second factor: HMAC signature (#116) ──────────────────────────────────
  // Only enforce for mutating methods (POST, PUT, PATCH, DELETE).
  // GET/HEAD admin reads are protected by JWT only — they don't modify state.
  const method = request.method.toUpperCase()
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const sigError = await requireAdminSignature(request)
    if (sigError) return sigError
  }

  return null // authorized
}
