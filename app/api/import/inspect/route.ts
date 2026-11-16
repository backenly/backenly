export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/import/inspect — the Review step: what would move from a source,
 * read without changing it. Body: { orgId, source?, connection }.
 *
 * Backenly Cloud only (404 elsewhere). The caller must be allowed to create a
 * project in the organization (its owners and admins), and has ten previews
 * per ten minutes. The connection is used for this request and forgotten: it
 * is never stored, logged or echoed back (lib/import/redact.ts).
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
    const preview = await inspectImport({ userId: user.userId, orgId, connection })
    return NextResponse.json({ preview }, { headers: NO_STORE })
  } catch (err) {
    return errorResponse(sayable(err, connection), secretsOf(connection))
  }
})

export async function POST(request: NextRequest) {
  return cloudOnly() ?? inspect(request)
}
