export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/import/inspect — the Review step: what would move from a source,
 * read without changing it. Body: { orgId, source?, connection }.
 *
 * On Backenly Cloud the source is read in the import sandbox, never in this
 * process (lib/import/sandbox.ts): 202 { lookId }; poll
 * GET /api/import/inspect/{lookId}. Elsewhere (the tests): 200 { preview }.
 *
 * Backenly Cloud only (404 elsewhere). The caller must be allowed to create a
 * project in the organization (its owners and admins), and has ten previews
 * per ten minutes. The connection is never logged or echoed back
 * (lib/import/redact.ts); for a look it is sealed in the look's row until the
 * look ends, then wiped (lib/import/sandbox-jobs.ts).
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { IMPORT_BUDGETS, NO_STORE, badRequest, cloudOnly, errorResponse, jsonBody, spendBudget } from '@/lib/import/http'
import { inspectImport, sayable } from '@/lib/import/jobs'
import { secretsOf } from '@/lib/import/redact'
import { parseInspect } from '@/lib/import/validation'

const inspect = withAuth(async (request: NextRequest, { user }) => {
  const body = await jsonBody(request)
  if (body === null) return badRequest('Send the form as JSON.')
  const parsed = parseInspect(body)
  if (parsed.ok === false) return badRequest(parsed.error, parsed.field)

  const { orgId, connection } = parsed.value
  try {
    // The person's own budget: spent before the source is read.
    await spendBudget(`import:inspect:user:${user.userId}`, IMPORT_BUDGETS.inspect, 'previews in the last ten minutes')
    const look = await inspectImport({ userId: user.userId, orgId, connection })
    // On Backenly Cloud the source is read in the import sandbox: poll GET /api/import/inspect/{lookId}.
    if ('lookId' in look) return NextResponse.json({ lookId: look.lookId }, { status: 202, headers: NO_STORE })
    return NextResponse.json({ preview: look.preview }, { headers: NO_STORE })
  } catch (err) {
    return errorResponse(sayable(err, connection), secretsOf(connection))
  }
})

export async function POST(request: NextRequest) {
  return cloudOnly() ?? inspect(request)
}
