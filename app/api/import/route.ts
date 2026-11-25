export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST /api/import — move a backend into a NEW project.
 *   Body: { orgId, source?, connection, name, region, include: { users, files } }
 *   202 { jobId, projectId }: the project exists and the import runs on; poll
 *   GET /api/import/{jobId}. On Backenly Cloud the source is first checked in
 *   the import sandbox (lib/import/sandbox.ts) and the project created once it
 *   passes: 202 { jobId, projectId: null, state: 'checking' }; poll
 *   GET /api/import/{jobId}/start for the project, or the refusal.
 *
 * GET /api/import?orgId= — the organization's running imports and those that
 * ended in the last 24 hours, newest first: { jobs: ImportProgress[] }.
 *
 * Backenly Cloud only (404 elsewhere). Starting takes what creating a project
 * takes (an owner or admin of the organization, room in its plan, an open
 * region, an account in good standing, the platform writable) and has three
 * starts per hour per organization, counted only for callers who may start one. Jobs are listed to whoever administers
 * their project. The connection is never logged or echoed back; in the sandbox
 * it is sealed in the job's row until the job ends (lib/import/sandbox-jobs.ts).
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { assertAccountCanConsume, assertWritable } from '@/lib/platform-controls'
import type { ImportJobsResponse } from '@/lib/import/contract'
import { IMPORT_BUDGETS, NO_STORE, badRequest, cloudOnly, errorResponse, jsonBody, spendBudget } from '@/lib/import/http'
import { listImportJobs, sayable, startImport } from '@/lib/import/jobs'
import { secretsOf } from '@/lib/import/redact'
import { parseStart } from '@/lib/import/validation'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const start = withAuth(async (request: NextRequest, { user }) => {
  const writable = await assertWritable()
  if (!writable.ok) return NextResponse.json({ error: writable.reason }, { status: writable.status })
  const standing = await assertAccountCanConsume(user.userId)
  if (!standing.ok) return NextResponse.json({ error: standing.reason, code: standing.code }, { status: standing.status })

  const body = await jsonBody(request)
  if (body === null) return badRequest('Send the form as JSON.')
  const parsed = parseStart(body)
  if (parsed.ok === false) return badRequest(parsed.error, parsed.field)

  try {
    // The organization's budget, spent only once the caller may create a project there.
    const { jobId, projectId } = await startImport(
      { ...parsed.value, userId: user.userId },
      { spendBudget: () => spendBudget(`import:start:org:${parsed.value.orgId}`, IMPORT_BUDGETS.start, 'imports started in this organization in the last hour') },
    )
    return NextResponse.json(projectId ? { jobId, projectId } : { jobId, projectId: null, state: 'checking' }, { status: 202, headers: NO_STORE })
  } catch (err) {
    return errorResponse(sayable(err, parsed.value.connection), secretsOf(parsed.value.connection))
  }
})

const list = withAuth(async (request: NextRequest, { user }) => {
  const orgId = request.nextUrl?.searchParams.get('orgId') ?? ''
  if (!UUID.test(orgId)) return badRequest('Choose an organization.')
  try {
    const jobs: ImportJobsResponse['jobs'] = []
    for (const job of await listImportJobs(orgId)) {
      if (job.projectId && (await canAdministerProject(user.userId, job.projectId))) jobs.push(job.progress)
    }
    return NextResponse.json({ jobs } satisfies ImportJobsResponse, { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err)
  }
})

export async function POST(request: NextRequest) {
  return cloudOnly() ?? start(request)
}

export async function GET(request: NextRequest) {
  return cloudOnly() ?? list(request)
}
