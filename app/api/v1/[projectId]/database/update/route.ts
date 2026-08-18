export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, handleValidationError, ErrorCodes } from '@/lib/api/v1/errors'
import { updateSchema } from '@/lib/api/v1/schemas'
import { validateRequestBody } from '@/lib/validation/schemas'
import { prisma } from '@/lib/db'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { validateUpdatePayload } from '@/lib/services/workspace-validator'

/**
 * POST /v1/{projectId}/database/update
 * Update rows in the project's workspace schema table
 */
export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
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

    const validation = await validateRequestBody(updateSchema, request)
    if (!validation.success) {
      return handleValidationError((validation as { success: false; error: string; status: number }).error as any)
    }

    const { table, where, data } = validation.data
    const tableName = table.toLowerCase()
    const schemaName = `workspace_${context.projectId}`

    const tableRecord = await prisma.table.findFirst({
      where: { projectId: context.projectId, name: tableName },
    })
    if (!tableRecord) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, `Table '${table}' not found in this project`, 404)
    }

    // Validate update payload fields against live table schema (types, lengths, no unknown keys)
    const fieldValidation = await validateUpdatePayload(context.projectId, tableName, data)
    if (!fieldValidation.success) {
      const failure = fieldValidation as import('@/lib/services/workspace-validator').ValidationFailure
      return createErrorResponse(
        ErrorCodes.VALIDATION_ERROR,
        failure.error,
        422,
        { fields: failure.fields }
      )
    }

    // Build SET clause
    const setCols = Object.keys(data).filter(c => /^[a-z_][a-z0-9_]*$/i.test(c))
    if (setCols.length === 0) {
      return createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'No valid fields to update', 400)
    }

    const values: any[] = []
    let paramIdx = 1

    const setParts = setCols.map(c => {
      values.push(data[c])
      return `"${c}" = $${paramIdx++}`
    })

    // Build WHERE clause
    const whereParts: string[] = []
    if (where && typeof where === 'object') {
      for (const [col, val] of Object.entries(where)) {
        if (!/^[a-z_][a-z0-9_]*$/i.test(col)) continue
        whereParts.push(`"${col}" = $${paramIdx++}`)
        values.push(val)
      }
    }

    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''
    const sql = `UPDATE "${schemaName}"."${tableName}" SET ${setParts.join(', ')} ${whereClause} RETURNING *`
    const result = await executeWithUserContext(
      context.endUserId ?? '',
      context.apiKey.serviceRole,
      sql,
      values,
      context.endUserRole ?? 'user'
    )

    // Fire event triggers + AI functions + activity log + notifications (non-blocking)
    if (result.length > 0) {
      const { fireTriggers } = await import('@/lib/services/trigger-service')
      const { fireAiFunctions } = await import('@/lib/services/ai-functions/executor')
      const { triggerActivityAndNotification } = await import('@/lib/ai/activity-log-engine')
      const actorId = context.apiKey?.userId
      for (const row of result) {
        fireTriggers(context.projectId, { type: 'update', table: tableName, data: row }).catch(
          (err: any) => console.warn('[Triggers] fire failed (non-fatal):', err?.message)
        )
        fireAiFunctions(context.projectId, { type: 'update', table: tableName, data: row }).catch(
          (err: any) => console.warn('[AiFunctions] fire failed (non-fatal):', err?.message)
        )
        triggerActivityAndNotification(context.projectId, 'updated', tableName, String(row.id || ''), actorId, row).catch(() => {})

        // Platform notification: job completed / failed
        // Fires when a *_jobs row transitions to 'completed' or 'failed'
        const isJobTable = /_jobs?$/.test(tableName)
        if (isJobTable && row.status && row.user_id) {
          const { notifyJobCompleted, notifyJobFailed } = await import('@/lib/notifications/platform')
          if (row.status === 'completed') {
            notifyJobCompleted(row.user_id, context.projectId, tableName, String(row.id), row.output_url).catch(() => {})
          } else if (row.status === 'failed') {
            notifyJobFailed(row.user_id, context.projectId, tableName, String(row.id), row.error_message).catch(() => {})
          }
        }
      }
    }

    return createSuccessResponse({ data: result.length === 1 ? result[0] : result, updated: result.length })
  } catch (error: any) {
    console.error('Database update error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to update data', 500)
  }
}


