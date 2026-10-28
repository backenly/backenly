export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, handleValidationError, ErrorCodes, regionErrorResponse, dataRefusalResponse } from '@/lib/api/v1/errors'
import { deleteSchema } from '@/lib/api/v1/schemas'
import { typedParams } from '@/lib/api/v1/typed-params'
import { whereConditions } from '@/lib/api/v1/where'
import { validateRequestBody } from '@/lib/validation/schemas'
import { prisma } from '@/lib/db'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import type { QueryContext } from '@/lib/db/query-errors'
import { columnTypes } from '@/lib/mcp/runtime-db'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { recordedV1 } from '@/lib/traffic/recorded-v1'

/**
 * POST /v1/{projectId}/database/delete
 * Delete rows from the project's workspace schema table
 */
async function handlePOST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  // What was bound, so a refusal can name its column (lib/api/v1/data-errors.ts).
  let refusal: QueryContext | undefined
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

    // Build WHERE clause (require it — no accidental full-table deletes), with
    // the operators the SDK sends, each value cast to its column's type
    // (lib/api/v1/where.ts).
    const types = await columnTypes(context.projectId, schemaName, tableName)
    const bound = typedParams(types)
    refusal = bound.context(tableName)
    const whereParts = whereConditions(where, bound, types)

    if (whereParts.length === 0) {
      return createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'A WHERE condition is required for delete', 400)
    }

    const whereClause = `WHERE ${whereParts.join(' AND ')}`

    // Prefer soft delete when the table has a deleted_at column.
    // Fall back to hard delete for tables created before this feature or without the column.
    let result: any[]
    // The catalog of the project's database, in its region. Resolved before
    // the fail-soft catch below, which reads any failure as "no deleted_at
    // column" and so as a HARD delete.
    const db = await workspaceRawClient(context.projectId)
    const softColumns = await db.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name IN ('deleted_at', 'updatedAt')`,
      schemaName, tableName
    ).then(r => new Set(r.map(c => c.column_name))).catch(() => new Set<string>())
    const hasSoftDelete = softColumns.has('deleted_at')

    if (hasSoftDelete) {
      // Soft delete: set deleted_at = NOW(), and "updatedAt" where the table
      // has one, only on rows not already deleted. A table made with deleted_at
      // and no "updatedAt" (one an agent created by its own SQL) failed every
      // delete: column "updatedAt" does not exist.
      const touch = softColumns.has('updatedAt') ? ', "updatedAt" = NOW()' : ''
      const softSql = `UPDATE "${schemaName}"."${tableName}"
                       SET deleted_at = NOW()${touch}
                       ${whereClause} AND deleted_at IS NULL RETURNING id`
      result = await executeWithUserContext(
        context.projectId,
        context.endUserId ?? '',
        context.apiKey.serviceRole,
        softSql,
        bound.values,
        context.endUserRole ?? 'user'
      )
    } else {
      const hardSql = `DELETE FROM "${schemaName}"."${tableName}" ${whereClause} RETURNING id`
      result = await executeWithUserContext(
        context.projectId,
        context.endUserId ?? '',
        context.apiKey.serviceRole,
        hardSql,
        bound.values,
        context.endUserRole ?? 'user'
      )
    }

    // Fire event triggers + AI functions + activity log + notifications (non-blocking)
    if (result.length > 0) {
      const { fireTriggers } = await import('@/lib/services/trigger-service')
      const { triggerActivityAndNotification } = await import('@/lib/ai/activity-log-engine')
      const actorId = context.apiKey?.userId
      for (const row of result) {
        fireTriggers(context.projectId, { type: 'delete', table: tableName, data: row }).catch(
          (err: any) => console.warn('[Triggers] fire failed (non-fatal):', err?.message)
        )
        triggerActivityAndNotification(context.projectId, 'deleted', tableName, String(row.id || ''), actorId, row).catch(() => {})
      }
    }

    return createSuccessResponse({ success: true, deleted: result.length })
  } catch (error: any) {
    const refused = dataRefusalResponse(error, refusal)
    if (refused) return refused
    console.error('Database delete error:', error)
    return regionErrorResponse(error) ?? createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to delete data', 500)
  }
}

export const POST = recordedV1(handlePOST)
