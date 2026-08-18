export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, handleValidationError, ErrorCodes } from '@/lib/api/v1/errors'
import { insertSchema } from '@/lib/api/v1/schemas'
import { validateRequestBody } from '@/lib/validation/schemas'
import { prisma } from '@/lib/db'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { validateInsertPayload } from '@/lib/services/workspace-validator'

/**
 * POST /v1/{projectId}/database/insert
 * Insert data into the project's workspace schema table
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

    const validation = await validateRequestBody(insertSchema, request)
    if (!validation.success) {
      return handleValidationError((validation as { success: false; error: string; status: number }).error as any)
    }

    const { table, data } = validation.data
    const tableName = table.toLowerCase()
    const schemaName = `workspace_${context.projectId}`

    const tableRecord = await prisma.table.findFirst({
      where: { projectId: context.projectId, name: tableName },
    })
    if (!tableRecord) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, `Table '${table}' not found in this project`, 404)
    }

    // Build INSERT from data object
    const rows = Array.isArray(data) ? data : [data]
    const inserted: any[] = []

    for (const row of rows) {
      // Validate row fields against live table schema (types, lengths, required columns)
      const fieldValidation = await validateInsertPayload(context.projectId, tableName, row)
      if (!fieldValidation.success) {
        const failure = fieldValidation as import('@/lib/services/workspace-validator').ValidationFailure
        return createErrorResponse(
          ErrorCodes.VALIDATION_ERROR,
          failure.error,
          422,
          { fields: failure.fields }
        )
      }

      const cols = Object.keys(row).filter(c => /^[a-z_][a-z0-9_]*$/i.test(c))
      if (cols.length === 0) continue

      const colList = cols.map(c => `"${c}"`).join(', ')
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
      const values = cols.map(c => row[c])

      const sql = `INSERT INTO "${schemaName}"."${tableName}" (${colList}) VALUES (${placeholders}) RETURNING *`
      const result = await executeWithUserContext(
        context.endUserId ?? '',
        context.apiKey.serviceRole,
        sql,
        values,
        context.endUserRole ?? 'user'
      )
      if (result[0]) inserted.push(result[0])
    }

    // Fire event triggers + AI functions + activity log + notifications (non-blocking)
    if (inserted.length > 0) {
      const { fireTriggers } = await import('@/lib/services/trigger-service')
      const { fireAiFunctions } = await import('@/lib/services/ai-functions/executor')
      const { triggerActivityAndNotification } = await import('@/lib/ai/activity-log-engine')
      const actorId = context.apiKey?.userId
      for (const row of inserted) {
        fireTriggers(context.projectId, { type: 'insert', table: tableName, data: row }).catch(
          (err: any) => console.warn('[Triggers] fire failed (non-fatal):', err?.message)
        )
        fireAiFunctions(context.projectId, { type: 'insert', table: tableName, data: row }).catch(
          (err: any) => console.warn('[AiFunctions] fire failed (non-fatal):', err?.message)
        )
        triggerActivityAndNotification(context.projectId, 'created', tableName, String(row.id || ''), actorId, row).catch(() => {})

        // Platform notification: job directly inserted with terminal status
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

    return createSuccessResponse({ data: inserted.length === 1 ? inserted[0] : inserted })
  } catch (error: any) {
    console.error('Database insert error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to insert data', 500)
  }
}


