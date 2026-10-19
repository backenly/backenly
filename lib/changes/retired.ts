/**
 * The answer a retired undo route gives.
 *
 * Restoring a project's schema is one thing now: restoring the state before a
 * governed change (lib/changes/recovery.ts), which checks what was written
 * since, re-proves the plan under lock, protects the current state first and
 * verifies the result. The routes that undid changes some other way (moving the
 * active-graph pointer, replaying a snapshot's DDL, re-adding what a version
 * named) are kept only to say so: 410, nothing changed, and where restoring
 * lives. A second way back with weaker guarantees would undo the point.
 */

import { NextResponse } from 'next/server'

export function movedToChanges(what: string): NextResponse {
  return NextResponse.json(
    {
      success: false,
      code: 'MOVED',
      error:
        `${what} has been replaced by restoring the state before a change. Open Database → Changes in the ` +
        'project, or POST /api/projects/{id}/changes/{changeId}/preview and then POST …/restore. Nothing was changed.',
    },
    { status: 410 },
  )
}
