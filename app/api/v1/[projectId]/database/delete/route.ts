export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, handleValidationError, ErrorCodes } from '@/lib/api/v1/errors'
import { deleteSchema } from '@/lib/api/v1/schemas'
import { validateRequestBody } from '@/lib/validation/schemas'
import { prisma } from '@/lib/db'
import { executeWithUserContext } from '@/lib/services/workspace-rls'

/**
 * POST /v1/{projectId}/database/delete
 * Delete rows from the project's workspace schema table
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) {
      return middleware.response
    }

    const { context } = middleware

    const permissionCheck = requirePermission(context, ['write', 'admin'])
    if (permissionCheck) {
      return permissionCheck
    }

    const capabilityCheck = requireCapability(context, request.nextUrl.pathname)
    if (capabilityCheck) {
      return capabilityCheck
    }

    const validation = await validateRequestBody(deleteSchema, request)
    if (!validation.success) {
      return handleValidationError((validation as { success: false; error: string; status: number }).error as any)
    }

    const { table, where } = validation.data
    const tableName = table.toLowerCase()
    const schemaName = `workspace_${context.projectId}`

    const tableRecord = await prisma.table.findFirst({
      where: { projectId: context.projectId, name: tableName },
    })
    if (!tableRecord) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, `Table '${table}' not found in this project`, 404)
    }

    // Build WHERE clause (require it — no accidental full-table deletes)
    const whereParts: string[] = []
    const values: any[] = []
    let paramIdx = 1

    if (where && typeof where === 'object') {
      for (const [col, val] of Object.entries(where)) {
        if (!/^[a-z_][a-z0-9_]*$/i.test(col)) continue
        whereParts.push(`"${col}" = $${paramIdx++}`)
        values.push(val)
      }
    }

    if (whereParts.length === 0) {
      return createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'A WHERE condition is required for delete', 400)
    }

    const whereClause = `WHERE ${whereParts.join(' AND ')}`

    // Prefer soft delete when the table has a deleted_at column.
    // Fall back to hard delete for tables created before this feature or without the column.
    let result: any[]
    const hasSoftDelete = await prisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = 'deleted_at'`,
      schemaName, tableName
    ).then(r => Number(r[0]?.count ?? 0) > 0).catch(() => false)

    if (hasSoftDelete) {
      // Soft delete: set deleted_at = NOW(), only on rows not already deleted
      const softSql = `UPDATE "${schemaName}"."${tableName}"
                       SET deleted_at = NOW(), "updatedAt" = NOW()
                       ${whereClause} AND deleted_at IS NULL RETURNING id`
      result = await executeWithUserContext(
        context.endUserId ?? '',
        context.apiKey.serviceRole,
        softSql,
        values,
        context.endUserRole ?? 'user'
      )
    } else {
      const hardSql = `DELETE FROM "${schemaName}"."${tableName}" ${whereClause} RETURNING id`
      result = await executeWithUserContext(
        context.endUserId ?? '',
        context.apiKey.serviceRole,
        hardSql,
        values,
        context.endUserRole ?? 'user'
      )
    }

    // Fire event triggers + AI functions + activity log + notifications (non-blocking)
    if (result.length > 0) {
      const { fireTriggers } = await import('@/lib/services/trigger-service')
      const { fireAiFunctions } = await import('@/lib/services/ai-functions/executor')
      const { triggerActivityAndNotification } = await import('@/lib/ai/activity-log-engine')
      const actorId = context.apiKey?.userId
      for (const row of result) {
        fireTriggers(context.projectId, { type: 'delete', table: tableName, data: row }).catch(
          (err: any) => console.warn('[Triggers] fire failed (non-fatal):', err?.message)
        )
        fireAiFunctions(context.projectId, { type: 'delete', table: tableName, data: row }).catch(
          (err: any) => console.warn('[AiFunctions] fire failed (non-fatal):', err?.message)
        )
        triggerActivityAndNotification(context.projectId, 'deleted', tableName, String(row.id || ''), actorId, row).catch(() => {})
      }
    }

    return createSuccessResponse({ success: true, deleted: result.length })
  } catch (error: any) {
    console.error('Database delete error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to delete data', 500)
  }
}


