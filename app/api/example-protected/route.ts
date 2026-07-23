export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withRBAC } from '@/lib/middleware/rbac'
import { Permissions } from '@/lib/auth/rbac'
import { validateRequestBody, validateQueryParams } from '@/lib/validation/schemas'
import { createProjectSchema, paginationSchema } from '@/lib/validation/schemas'
import { withErrorHandler } from '@/lib/middleware/errorHandler'
import { NotFoundError } from '@/lib/middleware/errorHandler'

/**
 * Example protected API endpoint demonstrating:
 * - RBAC authorization
 * - Input validation
 * - Error handling
 * 
 * GET /api/example-protected?limit=10&offset=0
 * POST /api/example-protected
 */

// GET handler with RBAC and query validation
export const GET = withErrorHandler(
  withRBAC(
    async (request: NextRequest) => {
      // Validate query parameters
      const queryValidation = validateQueryParams(
        paginationSchema,
        request.nextUrl.searchParams
      )

      if (!queryValidation.success) {
        return NextResponse.json(
          { error: (queryValidation as { success: false; error: string; status: number }).error },
          { status: (queryValidation as { success: false; error: string; status: number }).status }
        )
      }

      const { limit = 10, offset = 0 } = queryValidation.data

      // Your business logic here
      return NextResponse.json({
        data: [],
        pagination: {
          limit,
          offset,
          total: 0,
        },
      })
    },
    Permissions.PROJECT_READ // Require PROJECT_READ permission
  )
)

// POST handler with RBAC and body validation
export const POST = withErrorHandler(
  withRBAC(
    async (request: NextRequest) => {
      // Validate request body
      const bodyValidation = await validateRequestBody(
        createProjectSchema,
        request
      )

      if (!bodyValidation.success) {
        return NextResponse.json(
          { error: (bodyValidation as { success: false; error: string; status: number }).error },
          { status: (bodyValidation as { success: false; error: string; status: number }).status }
        )
      }

      const data = bodyValidation.data

      // Your business logic here
      // Example: throw NotFoundError if resource doesn't exist
      // throw new NotFoundError('Project')

      return NextResponse.json(
        {
          success: true,
          data: {
            id: 'example-id',
            ...data,
          },
        },
        { status: 201 }
      )
    },
    Permissions.PROJECT_WRITE // Require PROJECT_WRITE permission
  )
)

