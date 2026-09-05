export const dynamic = 'force-dynamic'

/**
 * GET  /api/admin/controls  → current PlatformControl state
 * POST /api/admin/controls  → patch toggles (aiFrozen, signupsDisabled, maintenanceMode, readOnly, note)
 *
 * FOUNDER-ONLY (requireFounder). Mutating method goes through the same HMAC
 * second-factor as the other admin write endpoints.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { authenticateRequest } from '@/lib/auth/middleware'
import { getPlatformControls, setPlatformControls, type ControlPatch } from '@/lib/platform/controls'

export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError
  const state = await getPlatformControls(true)
  return NextResponse.json({ controls: state })
}

export async function POST(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  // We need the founder's identity for the audit trail; requireFounder already
  // validated them but didn't return the userId, so do a lightweight re-fetch.
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId || !auth.userEmail) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: ControlPatch & { note?: string | null } = {}
  try {
    body = (await request.json()) ?? {}
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Validate types so the typed columns don't silently coerce.
  const patch: ControlPatch = {}
  if (typeof body.aiFrozen === 'boolean') patch.aiFrozen = body.aiFrozen
  if (typeof body.signupsDisabled === 'boolean') patch.signupsDisabled = body.signupsDisabled
  if (typeof body.maintenanceMode === 'boolean') patch.maintenanceMode = body.maintenanceMode
  if (typeof body.readOnly === 'boolean') patch.readOnly = body.readOnly
  if (body.note === null || typeof body.note === 'string') patch.note = body.note

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const next = await setPlatformControls(patch, { userId: auth.userId, userEmail: auth.userEmail })
  return NextResponse.json({ controls: next })
}
