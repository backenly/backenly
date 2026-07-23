export const dynamic = 'force-dynamic'

/**
 * Constraint-level schema mutations from the inspector.
 *
 *   POST /api/database/schema/constraints
 *     { tableName, columnName, constraintType: 'not_null'|'unique'|'check'|'foreign_key', expression? }
 *
 * Funnels through the canonical `tableLifecycle` service so the inspector and
 * the AI brain share one path — same governance, same self-heal.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { addWorkspaceConstraint, type ConstraintType } from '@/lib/services/tableLifecycle'

export const POST = withProjectAccess(async (request: NextRequest, { projectId }) => {
  try {
    const body = await request.json().catch(() => ({}))
    const { tableName, columnName, constraintType, expression } = body ?? {}
    if (!tableName || !columnName || !constraintType) {
      return NextResponse.json(
        { error: 'tableName, columnName, and constraintType are required' },
        { status: 400 },
      )
    }
    const result = await addWorkspaceConstraint(projectId, {
      tableName,
      columnName,
      constraintType: constraintType as ConstraintType,
      expression,
    })
    if (!result.success) {
      const status =
        result.error === 'INVALID_NAME' || result.error === 'INVALID_COLUMN_NAME' || result.error === 'INVALID_CONSTRAINT' ? 400 : 500
      return NextResponse.json(
        { error: result.message, code: result.error ?? 'CONSTRAINT_FAILED' },
        { status },
      )
    }
    return NextResponse.json({ success: true, message: result.message, data: result.data })
  } catch (error: any) {
    console.error('[schema/constraints POST] failed:', error)
    return NextResponse.json({ error: error?.message || 'Failed to add constraint' }, { status: 500 })
  }
})
