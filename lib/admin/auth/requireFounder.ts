import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { requireAdminStepUp } from './adminStepUp'

const FOUNDER_EMAIL = process.env.FOUNDER_EMAIL

export interface FounderIdentity {
  userId: string
  userEmail: string
}

/**
 * First factor only: is this request carrying a valid session belonging to the
 * founder (or an admin-role user)?
 *
 * Exported separately because the step-up endpoint itself needs the identity
 * check WITHOUT the step-up check — otherwise re-authenticating would require
 * already being re-authenticated.
 *
 * Returns the identity, or the response to send. Callers discriminate with
 * `instanceof NextResponse`: this repo compiles with `strict: false`, where a
 * `{ ok: true } | { ok: false }` union does not narrow (the same wrinkle the
 * `Guard` type in lib/platform/controls.ts documents). `instanceof` narrows
 * regardless of strictNullChecks, and needs no placeholder fields.
 *
 * Usage:
 *   const founder = await resolveFounder(request)
 *   if (founder instanceof NextResponse) return founder
 *   founder.userId // ← narrowed to FounderIdentity
 */
export async function resolveFounder(request: NextRequest): Promise<FounderIdentity | NextResponse> {
  const auth = await authenticateRequest(request)

  if (!auth.authenticated || !auth.userId || !auth.userEmail) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const isFounder = FOUNDER_EMAIL && auth.userEmail.toLowerCase() === FOUNDER_EMAIL.toLowerCase()
  const isAdminRole = auth.userRole === 'admin' || auth.userRole === 'super_admin'

  if (!isFounder && !isAdminRole) {
    console.warn(
      `[Security] Unauthorized admin access attempt by ${auth.userEmail} (role: ${auth.userRole}) from ${request.headers.get('x-forwarded-for') ?? 'unknown IP'}`
    )
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return { userId: auth.userId, userEmail: auth.userEmail }
}

/**
 * Require that the request comes from the founder/admin (#70, #116).
 *
 * Two-factor admin auth — BOTH must pass:
 *   1. JWT check: user email matches FOUNDER_EMAIL OR userRole is admin/super_admin
 *   2. Step-up check (mutating methods only): a sudo cookie earned by
 *      re-entering a password/TOTP at /api/admin/reauth, or — for scripted
 *      callers — an X-Admin-Timestamp + X-Admin-Signature HMAC pair.
 *      See lib/admin/auth/adminStepUp.ts for why the HMAC alone was not enough.
 *
 * Returns a 401/403 response if not authorized, null if authorized.
 *
 * Usage:
 *   const authError = await requireFounder(request)
 *   if (authError) return authError
 */
export async function requireFounder(
  request: NextRequest
): Promise<NextResponse | null> {
  const founder = await resolveFounder(request)
  if (founder instanceof NextResponse) return founder

  // ── Second factor ─────────────────────────────────────────────────────────
  // Only enforce for mutating methods (POST, PUT, PATCH, DELETE).
  // GET/HEAD admin reads are protected by JWT only — they don't modify state.
  const method = request.method.toUpperCase()
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const stepUpError = await requireAdminStepUp(request, founder.userId)
    if (stepUpError) return stepUpError
  }

  return null // authorized
}
