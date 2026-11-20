export const dynamic = 'force-dynamic'

/**
 * GET /api/import/inspect/{lookId} — the Review step's read of a source, run in
 * the import sandbox (lib/import/sandbox-jobs.ts): 200 { state: 'reading' }
 * while it runs, 200 { preview } once it has, or the refusal it ended with (a
 * 422 naming the field for a source the person can fix). Polled by
 * lib/import/client.ts. Answered only to the person who asked for the look;
 * anyone else gets the same 404 as for no look at all.
 *
 * Backenly Cloud only (404 elsewhere).
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { NO_STORE, cloudOnly, errorResponse } from '@/lib/import/http'
import { readLook } from '@/lib/import/sandbox-jobs'

const read = withAuth(async (_request: NextRequest, { user, params }) => {
  const { lookId } = ((await params) ?? {}) as { lookId?: string }
  try {
    const look = lookId ? await readLook(lookId, user.userId) : null
    if (!look) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE })
    if (look.state === 'reading') return NextResponse.json({ state: 'reading' }, { headers: NO_STORE })
    if (look.state === 'done') return NextResponse.json({ preview: look.preview }, { headers: NO_STORE })
    const { status, error, field, code, extra } = look.refusal
    return NextResponse.json({ error, ...(field ? { field } : {}), ...(code ? { code } : {}), ...(extra ?? {}) }, { status, headers: NO_STORE })
  } catch (err) {
    return errorResponse(err)
  }
})

export async function GET(request: NextRequest, context: { params: Promise<{ lookId: string }> }) {
  return cloudOnly() ?? read(request, context)
}
