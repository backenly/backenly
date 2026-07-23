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
 * Create a standardized success response
 */
export function createSuccessResponse<T>(
  data: T,
  meta?: ApiSuccess<T>['meta']
): NextResponse<ApiSuccess<T>> {
  return NextResponse.json({
    data,
    ...(meta && { meta }),
  })
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
} as const

