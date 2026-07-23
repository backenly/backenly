import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { Prisma } from '@prisma/client'

/**
 * Custom error classes
 */
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class ValidationError extends AppError {
  constructor(message: string, public errors?: any[]) {
    super(message, 400, 'VALIDATION_ERROR')
    this.name = 'ValidationError'
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 401, 'AUTHENTICATION_ERROR')
    this.name = 'AuthenticationError'
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = 'Insufficient permissions') {
    super(message, 403, 'AUTHORIZATION_ERROR')
    this.name = 'AuthorizationError'
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT')
    this.name = 'ConflictError'
  }
}

/**
 * Error handler middleware
 */
export function handleError(error: unknown): NextResponse {
  // Log error for debugging
  console.error('Error:', error)

  // Handle known error types
  if (error instanceof AppError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        ...(error instanceof ValidationError && error.errors && { errors: error.errors }),
      },
      { status: error.statusCode }
    )
  }

  // Handle Zod validation errors
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        errors: error.errors.map(e => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      },
      { status: 400 }
    )
  }

  // Handle Prisma errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002':
        return NextResponse.json(
          {
            error: 'A record with this value already exists',
            code: 'DUPLICATE_ENTRY',
          },
          { status: 409 }
        )
      case 'P2025':
        return NextResponse.json(
          {
            error: 'Record not found',
            code: 'NOT_FOUND',
          },
          { status: 404 }
        )
      case 'P2003':
        return NextResponse.json(
          {
            error: 'Foreign key constraint failed',
            code: 'FOREIGN_KEY_ERROR',
          },
          { status: 400 }
        )
      default:
        return NextResponse.json(
          {
            error: 'Database error',
            code: 'DATABASE_ERROR',
          },
          { status: 500 }
        )
    }
  }

  // Handle Prisma client initialization errors
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return NextResponse.json(
      {
        error: 'Database connection failed',
        code: 'DATABASE_CONNECTION_ERROR',
      },
      { status: 503 }
    )
  }

  // Handle generic errors
  if (error instanceof Error) {
    // Don't expose internal error messages in production
    const isDevelopment = process.env.NODE_ENV === 'development'
    
    return NextResponse.json(
      {
        error: isDevelopment ? error.message : 'Internal server error',
        code: 'INTERNAL_ERROR',
        ...(isDevelopment && { stack: error.stack }),
      },
      { status: 500 }
    )
  }

  // Unknown error type
  return NextResponse.json(
    {
      error: 'An unexpected error occurred',
      code: 'UNKNOWN_ERROR',
    },
    { status: 500 }
  )
}

/**
 * Wrapper for API route handlers with error handling
 */
export function withErrorHandler(
  handler: (request: Request, context?: any) => Promise<NextResponse>
) {
  return async (request: Request, context?: any): Promise<NextResponse> => {
    try {
      return await handler(request, context)
    } catch (error) {
      return handleError(error)
    }
  }
}

