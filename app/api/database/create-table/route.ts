export const dynamic = 'force-dynamic'

/**
 * POST /api/database/create-table
 *
 * Manual table creation from the inspector. Funnels through the canonical
 * `tableLifecycle` service, which calls the same `executeAction` the AI uses.
 * Result: a manually-created table is IDENTICAL to an AI-created one —
 *   - UUID PK, soft-delete column, updatedAt trigger
 *   - Auto-indexes on FK / filter columns
 *   - Realtime NOTIFY trigger installed
 *   - Auto-generated REST API (visible in APIs section immediately)
 *   - BackendGraph entity registered
 *   - Decision memory + typegen refresh + post-execution verify+self-heal
 *
 * Schema is ALWAYS derived from `projectId` server-side. Any client-supplied
 * `schema` field is ignored — the prior route trusted it, which was a tenancy
 * escape vector.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { createWorkspaceTable } from '@/lib/services/tableLifecycle'
import { invalidateTableStats } from '@/lib/services/workspace-table-stats'

export const POST = withProjectAccess(async (request: NextRequest, { projectId }) => {
  const requestId = `create-table-${Date.now().toString(36)}`
  try {
    const body = await request.json().catch(() => ({}))
    const { tableName, description, databaseType, columns } = body ?? {}

    if (databaseType && databaseType !== 'postgresql') {
      return NextResponse.json(
        { error: 'MongoDB collections are created automatically on first insert. Use the AI assistant to write data into your collection.' },
        { status: 400 },
      )
    }

    if (!tableName) {
      return NextResponse.json({ error: 'tableName is required' }, { status: 400 })
    }

    console.log(`🔵 [${requestId}] create-table via lifecycle:`, { projectId, tableName })

    const result = await createWorkspaceTable(projectId, {
      tableName,
      description,
      columns: Array.isArray(columns) ? columns : undefined,
    })

    if (!result.success) {
      // Translate canonical error codes to HTTP status
      const status =
        result.error === 'INVALID_NAME' ? 400 :
        result.message?.toLowerCase().includes('already exists') ? 409 :
        500
      return NextResponse.json(
        { error: result.message, code: result.error ?? 'CREATE_FAILED' },
        { status },
      )
    }

    // Drop the entire project's cached counter set — a new table means the
    // list itself changed, not just one entry, so we clear all.
    invalidateTableStats(projectId)

    return NextResponse.json({
      success: true,
      data: {
        tableName: result.tableName,
        apiGenerated: result.apiGenerated,
        message: result.message,
      },
    })
  } catch (error: any) {
    console.error(`❌ [${requestId}] create-table failed:`, error)
    return NextResponse.json(
      { error: error?.message || 'Failed to create table' },
      { status: 500 },
    )
  }
})
