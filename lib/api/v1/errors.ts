import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

/**
 * Standard API error response format
 */
export interface ApiError {
  error: {
    code: string
    message: string
    details?: Record<string, any>
    requestId?: string
  }
}

/**
 * Standard API success response format
 */
export interface ApiSuccess<T = any> {
  data: T
  meta?: {
    page?: number
    limit?: number
    total?: number
    hasMore?: boolean
    nextCursor?: string | null
  }
}

/**
 * Create a standardized error response
 */
export function createErrorResponse(
  code: string,
  message: string,
  status: number = 400,
  details?: Record<string, any>,
  requestId?: string
): NextResponse<ApiError> {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(details && { details }),
        ...(requestId && { requestId }),
      },
    },
    { status }
  )
}

/**
 * Create a standardized success response. `status` is 200 unless the request
 * created something (201).
 */
export function createSuccessResponse<T>(
  data: T,
  meta?: ApiSuccess<T>['meta'],
  status: 200 | 201 = 200,
): NextResponse<ApiSuccess<T>> {
  return NextResponse.json(
    {
      data,
      ...(meta && { meta }),
    },
    { status },
  )
}

/**
 * Handle Zod validation errors
 */
export function handleValidationError(error: ZodError): NextResponse<ApiError> {
  const details: Record<string, string[]> = {}
  
  error.errors.forEach((err) => {
    const path = err.path.join('.')
    if (!details[path]) {
      details[path] = []
    }
    details[path].push(err.message)
  })

  return createErrorResponse(
    'VALIDATION_ERROR',
    'Request validation failed',
    400,
    { fields: details }
  )
}

/**
 * The answer for a project whose data is in a region this process has no
 * connection to (REGION_NOT_CONFIGURED), or whose row names a region this
 * build does not know (UNKNOWN_REGION); null for any other error.
 *
 * 503, not 500: nothing was read from another region's database instead
 * (lib/data-plane/regional.ts), and the request succeeds once the deployment
 * is configured. The message names no variables. Matched on the code so this
 * module stays free of the database client.
 */
export function regionErrorResponse(error: unknown): NextResponse<ApiError> | null {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (code !== 'REGION_NOT_CONFIGURED' && code !== 'UNKNOWN_REGION') return null
  return createErrorResponse(code, "This project's data region is not reachable from this server.", 503)
}

/**
 * Common error codes
 */
export const ErrorCodes = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  PLAN_LIMIT_EXCEEDED: 'PLAN_LIMIT_EXCEEDED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  CONFLICT: 'CONFLICT',
  // The request was valid and a dependency this deployment needs was not
  // reachable. Distinct from INTERNAL_ERROR because it is RETRYABLE, and
  // distinct from NOT_FOUND because the resource exists.
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const

