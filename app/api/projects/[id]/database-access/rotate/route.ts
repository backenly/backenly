/**
 * POST /api/projects/[id]/database-access/rotate — { mode }
 * New password for an existing direct-access role. Live sessions for the role
 * are terminated server-side, so rotation revokes access immediately.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { rotateDirectAccess, type DirectAccessMode } from '@/lib/services/direct-access'

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
      console.error('[database-access] rotate failed:', err?.message)
      const status = /No .* credential to rotate/.test(err?.message ?? '') ? 404 : 500
      return NextResponse.json({ error: err?.message ?? 'Rotation failed.' }, { status })
    }
  })
}
