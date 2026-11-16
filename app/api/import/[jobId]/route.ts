export const dynamic = 'force-dynamic'

/**
 * GET /api/import/{jobId} — one import's progress: { progress: ImportProgress }.
 * Polled every second by the Move step.
 *
 * Backenly Cloud only (404 elsewhere). Answered to whoever administers the
 * project the import fills (the organization's owners and admins); anyone
 * else gets the same 404 as for a job that does not exist.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { NO_STORE, cloudOnly, errorResponse } from '@/lib/import/http'
import { getImportJob } from '@/lib/import/jobs'

const read = withAuth(async (_request: NextRequest, { user, params }) => {
  const { jobId } = ((await params) ?? {}) as { jobId?: string }
  try {
    const job = jobId ? await getImportJob(jobId) : null
    if (!job || !job.projectId || !(await canAdministerProject(user.userId, job.projectId))) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404, headers: NO_STORE })
    }
    return NextResponse.json({ progress: job.progress }, { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err)
  }
})

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  return cloudOnly() ?? read(request, context)
}
