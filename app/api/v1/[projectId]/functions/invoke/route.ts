export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, handleValidationError, ErrorCodes } from '@/lib/api/v1/errors'
import { invokeFunctionSchema } from '@/lib/api/v1/schemas'
import { validateRequestBody } from '@/lib/validation/schemas'
import { markAsWritten, recordedV1 } from '@/lib/traffic/recorded-v1'

/**
 * POST /v1/{projectId}/functions/invoke
 * Invoke a serverless function (placeholder)
 */
async function handlePOST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
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
      // Recorded as an HTTP call, which it is; the event keeps type 'manual'.
      trigger: 'http',
    })

    const { logsFor, runnerRefusal, completedRunStatus, statusHasBody } = await import('@/lib/services/ai-functions/reply')
    if (!result.success) {
      if (result.errorCode === 'PLAN_LIMIT_EXCEEDED') {
        return createErrorResponse(
          ErrorCodes.PLAN_LIMIT_EXCEEDED,
          result.error || 'Plan limit exceeded',
          402,
          { upgradeRequired: true, requiredPlan: result.requiredPlan }
        )
      }
      // Turned away by the function runner: not run, and not the function's 500.
      const refusal = runnerRefusal(result)
      if (refusal) {
        const response = createErrorResponse(refusal.code, refusal.error, refusal.status, refusal.retryAfter ? { retryAfter: refusal.retryAfter } : undefined)
        if (refusal.retryAfter) response.headers.set('Retry-After', String(refusal.retryAfter))
        return response
      }
      const is404 = result.errorCode === 'NOT_FOUND'
      return createErrorResponse(
        is404 ? ErrorCodes.NOT_FOUND : ErrorCodes.INTERNAL_ERROR,
        result.error || 'Function execution failed',
        is404 ? 404 : 500
      )
    }

    // The status line is the handler's own, as at /fn/{name}: a 401 or 503 the
    // function answered went out as a 200 here (#604). The envelope is kept.
    const status = completedRunStatus(result.httpStatus)
    const envelope = {
      functionId,
      success: status < 400,
      ...logsFor(result.logs, !!context.apiKey.serviceRole),
      returnValue: result.returnValue ?? null,
      durationMs: result.durationMs,
    }
    return markAsWritten(
      statusHasBody(status) ? NextResponse.json({ data: envelope }, { status }) : new NextResponse(null, { status }),
    )
  } catch (error: any) {
    console.error('Function invoke error:', error)
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      'Failed to invoke function',
      500
    )
  }
}

export const POST = recordedV1(handlePOST)
