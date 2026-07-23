export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, handleValidationError, ErrorCodes } from '@/lib/api/v1/errors'
import { invokeFunctionSchema } from '@/lib/api/v1/schemas'
import { validateRequestBody } from '@/lib/validation/schemas'

/**
 * POST /v1/{projectId}/functions/invoke
 * Invoke a serverless function (placeholder)
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

    const validation = await validateRequestBody(invokeFunctionSchema, request)
    if (!validation.success) {
      return handleValidationError((validation as { success: false; error: string; status: number }).error as any)
    }

    const { functionId, payload } = validation.data

    // Forward the caller's auth/signature headers to the function handler —
    // generated route modules read x-user-token / x-admin-key directly.
    const { pickFnHeaders } = await import('@/lib/services/ai-functions/forward-headers')

    const { executeAiFunction } = await import('@/lib/services/ai-functions/executor')

    const result = await executeAiFunction(functionId, params.projectId, {
      type: 'manual',
      data: payload || {},
    }, {
      endUserId: context.endUserId,
      endUserRole: context.endUserRole,
      serviceRole: context.apiKey.serviceRole,
      headers: pickFnHeaders(h => request.headers.get(h)),
    })

    if (!result.success) {
      if (result.errorCode === 'PLAN_LIMIT_EXCEEDED') {
        return createErrorResponse(
          ErrorCodes.PLAN_LIMIT_EXCEEDED,
          result.error || 'Plan limit exceeded',
          402,
          { upgradeRequired: true, requiredPlan: result.requiredPlan }
        )
      }
      const is404 = result.errorCode === 'NOT_FOUND'
      return createErrorResponse(
        is404 ? ErrorCodes.NOT_FOUND : ErrorCodes.INTERNAL_ERROR,
        result.error || 'Function execution failed',
        is404 ? 404 : 500
      )
    }

    return createSuccessResponse({
      functionId,
      success: result.success,
      logs: result.logs,
      returnValue: result.returnValue ?? null,
      durationMs: result.durationMs,
    })
  } catch (error: any) {
    console.error('Function invoke error:', error)
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      'Failed to invoke function',
      500
    )
  }
}
