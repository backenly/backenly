export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/projects/[projectId]/lockdown
 *
 * Body: { lock: boolean, reason?: string }
 *
 * Toggles per-project lockdown. While locked, the public runtime
 * (lib/api/v1/middleware.ts) refuses every request to the project with a 503,
 * regardless of method or API key. Lifting the lockdown clears the flag —
 * no API-key state is touched, so the project resumes cleanly.
 *
 * FOUNDER-ONLY.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { authenticateRequest } from '@/lib/auth/middleware'
import { setProjectLockdown } from '@/lib/platform/controls'

export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const authError = await requireFounder(request)
  if (authError) return authError

  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId || !auth.userEmail) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: any = {}
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (typeof body.lock !== 'boolean') {
    return NextResponse.json({ error: 'lock (boolean) is required' }, { status: 400 })
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() || null : null

  try {
    await setProjectLockdown(params.projectId, body.lock, reason, {
      userId: auth.userId,
      userEmail: auth.userEmail,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Lockdown failed' }, { status: 400 })
  }

  return NextResponse.json({ success: true, projectId: params.projectId, locked: body.lock })
}
