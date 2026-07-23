import { Response } from 'express'
import { ZodError } from 'zod'

export const ErrorCodes = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  CONFLICT: 'CONFLICT',
} as const

export function sendError(
  res: Response,
  code: string,
  message: string,
  status: number = 400,
  details?: Record<string, any>
) {
  res.status(status).json({
    error: {
      code,
      message,
      ...(details && { details }),
    },
  })
}

export function sendSuccess(res: Response, data: any, meta?: Record<string, any>) {
  res.json({
    data,
    ...(meta && { meta }),
  })
}

export function sendValidationError(res: Response, error: ZodError) {
  const details: Record<string, string[]> = {}
  error.errors.forEach((err) => {
    const path = err.path.join('.')
    if (!details[path]) details[path] = []
    details[path].push(err.message)
  })
  sendError(res, ErrorCodes.VALIDATION_ERROR, 'Request validation failed', 400, { fields: details })
}
