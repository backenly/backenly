export const dynamic = 'force-dynamic'

/**
 * GET /api/import/{jobId}/start — where an import's start is, while its source
 * is checked in the import sandbox before the project exists
 * (lib/import/sandbox-jobs.ts): 200 { state: 'checking' }, then 200
 * { jobId, projectId } once the project is created and the move began, or the
 * refusal the start ended with (a 422 naming the field for a source the person
 * can fix, the project creation's own refusal otherwise). Polled by
 * lib/import/client.ts. Answered only to the person who started it; anyone
 * else gets the same 404 as for no import at all.
 *
 * Backenly Cloud only (404 elsewhere).
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { NO_STORE, cloudOnly, errorResponse } from '@/lib/import/http'
import { readImportStart } from '@/lib/import/sandbox-jobs'

const read = withAuth(async (_request: NextRequest, { user, params }) => {
  const { jobId } = ((await params) ?? {}) as { jobId?: string }
  try {
    const start = jobId ? await readImportStart(jobId, user.userId) : null
    if (!start) return NextResponse.json({ error: 'Import not found' }, { status: 404, headers: NO_STORE })
    if (start.state === 'checking') return NextResponse.json({ state: 'checking' }, { headers: NO_STORE })
    if (start.state === 'started') return NextResponse.json({ jobId, projectId: start.projectId }, { headers: NO_STORE })
    const { status, error, field, code, extra } = start.refusal
    return NextResponse.json({ error, ...(field ? { field } : {}), ...(code ? { code } : {}), ...(extra ?? {}) }, { status, headers: NO_STORE })
  } catch (err) {
    return errorResponse(err)
  }
})

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  return cloudOnly() ?? read(request, context)
}
