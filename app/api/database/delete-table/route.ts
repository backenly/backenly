export const dynamic = 'force-dynamic'

/**
 * DELETE /api/database/delete-table
 *
 * Manual table deletion from the inspector. Funnels through the canonical
 * `tableLifecycle` service, which calls the same `executeAction` the AI uses.
 *
 * Before this rewrite the route ran a bare `DROP TABLE … CASCADE` and left
 * everything else dangling: `prisma.table` metadata, `prisma.apiDefinition`
 * rows (API Builder kept showing endpoints that 500), the realtime NOTIFY
 * trigger, and the entity in BackendGraph. Now all of that is cleaned by the
 * canonical executor in one operation.
 *
 * Schema is derived from `projectId` server-side via the executor — any
 * client-supplied `schema` is ignored.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { dropWorkspaceTable } from '@/lib/services/tableLifecycle'
import { invalidateTableStats } from '@/lib/services/workspace-table-stats'

export const DELETE = withProjectAccess(async (request: NextRequest, { projectId }) => {
  const requestId = `drop-table-${Date.now().toString(36)}`
  try {
    const body = await request.json().catch(() => ({}))
    const { tableName, databaseType } = body ?? {}

    if (databaseType && databaseType !== 'postgresql') {
      return NextResponse.json(
        { error: 'MongoDB collection deletion is not supported here. Use MongoDB Atlas or your client to drop collections directly.' },
        { status: 400 },
      )
    }

    if (!tableName) {
      return NextResponse.json({ error: 'tableName is required' }, { status: 400 })
    }

    console.log(`🗑️  [${requestId}] drop-table via lifecycle:`, { projectId, tableName })

    const result = await dropWorkspaceTable(projectId, tableName)

    if (!result.success) {
      const status =
        result.error === 'INVALID_NAME' ? 400 :
        result.error === 'APPROVAL_REQUIRED' ? 409 :
        500
      return NextResponse.json(
        { error: result.message, code: result.error ?? 'DROP_FAILED' },
        { status },
      )
    }

    // Drop the entire project's cached counter set — the table list changed.
    invalidateTableStats(projectId)

    return NextResponse.json({
      success: true,
      message: result.message,
      data: result.data,
    })
  } catch (error: any) {
    console.error(`❌ [${requestId}] drop-table failed:`, error)
    return NextResponse.json(
      { error: error?.message || 'Failed to delete table' },
      { status: 500 },
    )
  }
})
