/**
 * POST /api/projects/[id]/approvals/[findingId]/rollback: retired.
 *
 * This re-ran the "DDL" stored with the schema snapshot taken before a fix,
 * against the workspace and outside the change ledger. That text was a comment
 * header and a list of column names, not SQL, so on a schema with tables it
 * failed, and on an empty one it reported success having done nothing. A fix's
 * changes are governed changes now, and its undo restores exactly those
 * (revertAutoFix, lib/changes/recovery.ts).
 *
 * The administer floor stays, so the route answers the same callers as before.
 */

import { NextRequest } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { movedToChanges } from '@/lib/changes/retired'

export async function POST(request: NextRequest) {
  return withProjectValidation<any>(
    request,
    async () => movedToChanges('Rolling back an approved fix from its snapshot'),
    { floor: 'administer' },
  )
}
