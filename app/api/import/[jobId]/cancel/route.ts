export const dynamic = 'force-dynamic'

/**
 * POST /api/import/{jobId}/cancel — stop a running import: { progress }.
 *
 * The job stops at its next check between batches; what arrived stays in the
 * new project, which its owner can delete. Nothing in the source changes, as
 * nothing there ever does. Backenly Cloud only (404 elsewhere); answered to
 * whoever administers the project the import fills.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { NO_STORE, cloudOnly, errorResponse } from '@/lib/import/http'
import { cancelImportJob, getImportJob } from '@/lib/import/jobs'

const cancel = withAuth(async (_request: NextRequest, { user, params }) => {
  const { jobId } = ((await params) ?? {}) as { jobId?: string }
  try {
    const job = jobId ? await getImportJob(jobId) : null
    if (!job || !job.projectId || !(await canAdministerProject(user.userId, job.projectId))) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404, headers: NO_STORE })
    }
    if (job.progress.status !== 'running' && job.progress.status !== 'queued') {
      return NextResponse.json({ progress: job.progress }, { headers: NO_STORE })
    }
    const progress = (await cancelImportJob(jobId!)) ?? job.progress
    return NextResponse.json({ progress }, { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err)
  }
})

export async function POST(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  return cloudOnly() ?? cancel(request, context)
}
