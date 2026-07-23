export const dynamic = 'force-dynamic'

/**
 * POST /api/v1/[projectId]/functions
 *
 * Invoke a serverless AI function by name (not UUID).
 * Called by the SDK's backend.fn['functionName'].call(data) pattern.
 *
 * Body: { name: string, data?: Record<string, any> }
 */

import { NextRequest } from 'next/server'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { prisma } from '@/lib/db'

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response

    let body: { name?: string; data?: Record<string, any> }
    try {
      body = await request.json()
    } catch {
      return createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Invalid JSON body', 400)
    }

    const { name, data } = body
    if (!name || typeof name !== 'string') {
      return createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Function name is required', 400)
    }

    const fn = await prisma.aiFunction.findFirst({
      where: { projectId: params.projectId, name, status: 'active' },
      select: { id: true },
    })

    if (!fn) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, `Function "${name}" not found or inactive`, 404)
    }

    // Forward the caller's auth/signature headers to the function handler —
    // generated route modules read x-user-token / x-admin-key directly.
    const { pickFnHeaders } = await import('@/lib/services/ai-functions/forward-headers')

    const { executeAiFunction } = await import('@/lib/services/ai-functions/executor')
    const result = await executeAiFunction(fn.id, params.projectId, {
      type: 'manual',
      data: data && typeof data === 'object' ? data : {},
    }, {
      endUserId: middleware.context.endUserId,
      endUserRole: middleware.context.endUserRole,
      serviceRole: middleware.context.apiKey.serviceRole,
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
      if (result.errorCode === 'NOT_FOUND') {
        return createErrorResponse(ErrorCodes.NOT_FOUND, result.error || 'Function not found', 404)
      }
      return createErrorResponse(
        ErrorCodes.INTERNAL_ERROR,
        result.error || 'Function execution failed',
        500
      )
    }

    return createSuccessResponse({
      name,
      success: true,
      result: result.returnValue ?? null,
      logs: result.logs,
      durationMs: result.durationMs,
    })
  } catch (error: any) {
    console.error('[fn/invoke-by-name] Error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to invoke function', 500)
  }
}
