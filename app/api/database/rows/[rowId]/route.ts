export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { HybridDatabase, type DatabaseType } from '@/lib/db/hybrid'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { invalidateTableStats } from '@/lib/services/workspace-table-stats'

/**
 * Per-row update / delete for the inspector data browser.
 *
 *   PUT    /api/database/rows/{rowId}?type&table&schema&projectId   { data }
 *   DELETE /api/database/rows/{rowId}?type&table&schema&projectId
 *
 * The row id lives in the URL path segment — NOT the body or a query param.
 * `withProjectAccess` verifies the caller owns `projectId`; we then verify the
 * target `schema` is THIS project's workspace schema before touching any data,
 * so a valid session for project A can never mutate project B's rows.
 */

// The row id is the last path segment: /api/database/rows/{rowId}
function extractRowId(request: NextRequest): string | null {
  const segments = request.nextUrl.pathname.split('/').filter(Boolean)
  const raw = segments[segments.length - 1]
  if (!raw || raw === 'rows') return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// Reject any attempt to target a workspace schema that isn't this project's.
function assertSchemaOwnership(schema: string | undefined, projectId: string): NextResponse | null {
  if (schema?.startsWith('workspace_') && schema !== `workspace_${projectId}`) {
    return NextResponse.json(
      { success: false, error: 'Invalid workspace schema for this project' },
      { status: 403 }
    )
  }
  return null
}

// PUT /api/database/rows/[rowId] - Update a row/document
export const PUT = withProjectAccess(async (
  request: NextRequest,
  { user, project, projectId }
) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const body = await request.json().catch(() => ({}))

    const type = (searchParams.get('type') || 'postgresql') as DatabaseType
    const schema = searchParams.get('schema') || undefined
    const table = searchParams.get('table')
    const rowId = extractRowId(request)

    if (!table || !rowId || !body?.data || typeof body.data !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: table (query), row id (path), data (body)' },
        { status: 400 }
      )
    }

    if (Object.keys(body.data).length === 0) {
      return NextResponse.json(
        { success: false, error: 'No fields to update' },
        { status: 400 }
      )
    }

    const ownershipError = assertSchemaOwnership(schema, projectId)
    if (ownershipError) return ownershipError

    const result = await HybridDatabase.updateRow(type, schema, table, rowId, body.data)

    if (!result) {
      return NextResponse.json(
        { success: false, error: 'Row not found' },
        { status: 404 }
      )
    }

    // Bust the unified row-count cache so the dashboard and inspector reflect
    // the update on the next paint — not 30s later.
    invalidateTableStats(projectId, table)

    return NextResponse.json({ success: true, data: result })
  } catch (error: any) {
    console.error('Error updating row:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to update row', message: error.message },
      { status: 500 }
    )
  }
});

// DELETE /api/database/rows/[rowId] - Delete a row/document
export const DELETE = withProjectAccess(async (
  request: NextRequest,
  { user, project, projectId }
) => {
  try {
    const searchParams = request.nextUrl.searchParams

    const type = (searchParams.get('type') || 'postgresql') as DatabaseType
    const schema = searchParams.get('schema') || undefined
    const table = searchParams.get('table')
    const rowId = extractRowId(request)

    if (!table || !rowId) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: table (query), row id (path)' },
        { status: 400 }
      )
    }

    const ownershipError = assertSchemaOwnership(schema, projectId)
    if (ownershipError) return ownershipError

    const success = await HybridDatabase.deleteRow(type, schema, table, rowId)

    if (!success) {
      return NextResponse.json(
        { success: false, error: 'Row not found' },
        { status: 404 }
      )
    }

    invalidateTableStats(projectId, table)

    return NextResponse.json({ success: true, message: 'Row deleted successfully' })
  } catch (error: any) {
    console.error('Error deleting row:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to delete row', message: error.message },
      { status: 500 }
    )
  }
});
