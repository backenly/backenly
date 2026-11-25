/**
 * POST /api/projects/[id]/database-access/rotate — { mode }
 * New password for an existing direct-access role. Live sessions for the role
 * are terminated server-side, so rotation revokes access immediately. On a
 * project's own database this answer is the one place a read-write login's
 * new password is ever shown.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { DirectAccessUnavailableError, rotateDirectAccess, type DirectAccessMode } from '@/lib/services/direct-access'

// ADMIN: rotation mints a new password and returns it, and kills every live
// session on the old one — credential issuance and revocation in one call.
export async function POST(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const body = await request.json().catch(() => ({}))
    const mode: unknown = body?.mode
    if (mode !== 'READ_ONLY' && mode !== 'READ_WRITE') {
      return NextResponse.json({ error: 'mode must be READ_ONLY or READ_WRITE' }, { status: 400 })
    }
    try {
      const credential = await rotateDirectAccess(validated.projectId, mode as DirectAccessMode)
      return NextResponse.json({ credential })
    } catch (err: any) {
      // Nothing outside can connect with the login, so there is nothing to rotate it for.
      if (err instanceof DirectAccessUnavailableError) {
        return NextResponse.json({ error: err.message, code: err.code, reason: err.reason }, { status: 503 })
      }
      console.error('[database-access] rotate failed:', err?.message)
      const status = /No .* credential to rotate/.test(err?.message ?? '') ? 404 : 500
      return NextResponse.json({ error: err?.message ?? 'Rotation failed.' }, { status })
    }
  }, { floor: 'administer' })
}
