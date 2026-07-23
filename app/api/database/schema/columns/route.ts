export const dynamic = 'force-dynamic'

/**
 * Column-level schema mutations from the inspector.
 *
 *   POST   /api/database/schema/columns   { tableName, column: { name, type, nullable?, default? } }
 *   PATCH  /api/database/schema/columns   { tableName, oldName, newName }
 *   DELETE /api/database/schema/columns   { tableName, columnName }
 *
 * Every handler funnels through the canonical `tableLifecycle` service — same
 * governance as the AI brain's `add_column` / `rename_column` / `drop_column`
 * tools (schema versioning snapshot, typegen refresh, Zod cache invalidation,
 * post-execution verify+self-heal).
 *
 * `withProjectAccess` enforces project ownership before any mutation runs.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import {
  addWorkspaceColumn,
  renameWorkspaceColumn,
  dropWorkspaceColumn,
} from '@/lib/services/tableLifecycle'
import type { ExecutionResult } from '@/lib/ai/minimal-executor'

function toResponse(result: ExecutionResult, successStatus = 200) {
  if (!result.success) {
    const status =
      result.error === 'INVALID_NAME' || result.error === 'INVALID_COLUMN_NAME' || result.error === 'INVALID_COLUMN_TYPE' || result.error === 'NO_CHANGE' ? 400 :
      result.error === 'APPROVAL_REQUIRED' ? 409 :
      500
    return NextResponse.json(
      { error: result.message, code: result.error ?? 'MUTATION_FAILED' },
      { status },
    )
  }
  return NextResponse.json({ success: true, message: result.message, data: result.data }, { status: successStatus })
}

export const POST = withProjectAccess(async (request: NextRequest, { projectId }) => {
  try {
    const body = await request.json().catch(() => ({}))
    const { tableName, column } = body ?? {}
    if (!tableName || !column?.name || !column?.type) {
      return NextResponse.json(
        { error: 'tableName and column { name, type } are required' },
        { status: 400 },
      )
    }
    const result = await addWorkspaceColumn(projectId, { tableName, column })
    return toResponse(result, 201)
  } catch (error: any) {
    console.error('[schema/columns POST] failed:', error)
    return NextResponse.json({ error: error?.message || 'Failed to add column' }, { status: 500 })
  }
})

export const PATCH = withProjectAccess(async (request: NextRequest, { projectId }) => {
  try {
    const body = await request.json().catch(() => ({}))
    const { tableName, oldName, newName } = body ?? {}
    if (!tableName || !oldName || !newName) {
      return NextResponse.json(
        { error: 'tableName, oldName, and newName are required' },
        { status: 400 },
      )
    }
    const result = await renameWorkspaceColumn(projectId, { tableName, oldName, newName })
    return toResponse(result)
  } catch (error: any) {
    console.error('[schema/columns PATCH] failed:', error)
    return NextResponse.json({ error: error?.message || 'Failed to rename column' }, { status: 500 })
  }
})

export const DELETE = withProjectAccess(async (request: NextRequest, { projectId }) => {
  try {
    const body = await request.json().catch(() => ({}))
    const { tableName, columnName } = body ?? {}
    if (!tableName || !columnName) {
      return NextResponse.json(
        { error: 'tableName and columnName are required' },
        { status: 400 },
      )
    }
    const result = await dropWorkspaceColumn(projectId, { tableName, columnName })
    return toResponse(result)
  } catch (error: any) {
    console.error('[schema/columns DELETE] failed:', error)
    return NextResponse.json({ error: error?.message || 'Failed to drop column' }, { status: 500 })
  }
})
