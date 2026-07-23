/**
 * 🔒 ROUTE PROTECTION HELPERS
 * 
 * Professional-grade middleware wrappers for Next.js API routes
 * 
 * Usage Examples:
 * 
 * 1. Simple auth (user must be logged in):
 *    export const GET = withAuth(async (request, { user }) => { ... })
 * 
 * 2. Project-scoped (user must own project):
 *    export const POST = withProjectAccess(async (request, { user, project }) => { ... })
 * 
 * 3. Role-based (user must be owner):
 *    export const DELETE = withRole('owner', async (request, { user, project }) => { ... })
 */

import { NextRequest, NextResponse } from 'next/server'
import { 
  requireUser, 
  requireProjectAccess, 
  requireRole,
  UnauthorizedError,
  ForbiddenError 
} from './server'

type RouteHandler<T = any> = (
  request: NextRequest,
  context: T
) => Promise<NextResponse> | NextResponse

/**
 * 🔒 WITH AUTH - Requires user to be logged in
 * 
 * Usage:
 *   export const GET = withAuth(async (request, { user, params }) => {
 *     // user.userId, user.email, user.role available
 *     // params available for dynamic routes
 *     return NextResponse.json({ data })
 *   })
 */
export function withAuth(
  handler: RouteHandler<{ user: Awaited<ReturnType<typeof requireUser>>; params?: Promise<Record<string, string>> }>
) {
  return async (request: NextRequest, { params }: { params?: Promise<Record<string, string>> } = {}) => {
    try {
      const user = await requireUser()
      return await handler(request, { user, params })
    } catch (error: any) {
      if (error instanceof UnauthorizedError) {
        return NextResponse.json(
          { error: error.message },
          { status: 401 }
        )
      }
      return NextResponse.json(
        { error: 'Authentication failed' },
        { status: 401 }
      )
    }
  }
}

/**
 * 🔒 WITH PROJECT ACCESS - Requires user to own the project
 * 
 * Extracts projectId from:
 * - Query param: ?projectId=xxx
 * - Header: x-project-id
 * - Request body: { projectId: xxx }
 * 
 * Usage:
 *   export const POST = withProjectAccess(async (request, { user, project, projectId }) => {
 *     // Guaranteed: user owns this project
 *     return NextResponse.json({ project })
 *   })
 */
export function withProjectAccess(
  handler: RouteHandler<Awaited<ReturnType<typeof requireProjectAccess>>>
) {
  return async (request: NextRequest) => {
    try {
      const ctx = await requireProjectAccess(request as any)
      return await handler(request, ctx)
    } catch (error: any) {
      if (error instanceof UnauthorizedError) {
        return NextResponse.json(
          { 
            code: 'UNAUTHORIZED',
            error: error.message 
          },
          { status: 401 }
        )
      }
      if (error instanceof ForbiddenError) {
        // 🚫 CRITICAL: Use correct status code based on error message
        const isNotFound = error.message.includes('not found');
        return NextResponse.json(
          { 
            code: isNotFound ? 'PROJECT_NOT_FOUND' : 'PROJECT_FORBIDDEN',
            error: error.message 
          },
          { status: isNotFound ? 404 : 403 }
        )
      }
      return NextResponse.json(
        { 
          code: 'ACCESS_DENIED',
          error: 'Access denied' 
        },
        { status: 403 }
      )
    }
  }
}

/**
 * 🔒 WITH ROLE - Requires specific role for project
 * 
 * Usage:
 *   export const DELETE = withRole('owner', async (request, { user, project }) => {
 *     // Only owners can delete
 *     return NextResponse.json({ success: true })
 *   })
 * 
 *   export const PUT = withRole(['owner', 'admin'], async (request, ctx) => {
 *     // Owners or admins can update
 *   })
 */
export function withRole(
  allowedRoles: string | string[],
  handler: RouteHandler<Awaited<ReturnType<typeof requireRole>>>
) {
  return async (request: NextRequest) => {
    try {
      const ctx = await requireRole(request as any, allowedRoles)
      return await handler(request, ctx)
    } catch (error: any) {
      if (error instanceof UnauthorizedError) {
        return NextResponse.json(
          { error: error.message },
          { status: 401 }
        )
      }
      if (error instanceof ForbiddenError) {
        return NextResponse.json(
          { error: error.message },
          { status: 403 }
        )
      }
      return NextResponse.json(
        { error: 'Access denied' },
        { status: 403 }
      )
    }
  }
}

/**
 * 🔒 WITH API KEY - For external API access
 * 
 * Validates API key from header: x-api-key
 * 
 * Usage:
 *   export const POST = withApiKey(async (request, { projectId, userId }) => {
 *     // API key validated, projectId scoped
 *     return NextResponse.json({ data })
 *   })
 */
export function withApiKey(
  handler: RouteHandler<{ projectId: string; userId: string; apiKey: any }>
) {
  return async (request: NextRequest) => {
    try {
      const apiKey = request.headers.get('x-api-key')
      
      if (!apiKey) {
        return NextResponse.json(
          { error: 'API key required in x-api-key header' },
          { status: 401 }
        )
      }

      const { validateApiKey } = await import('./server')
      const ctx = await validateApiKey(apiKey)
      
      return await handler(request, ctx)
    } catch (error: any) {
      return NextResponse.json(
        { error: error.message || 'Invalid API key' },
        { status: 401 }
      )
    }
  }
}

/**
 * 📝 USAGE EXAMPLES
 * 
 * // Basic auth - any logged in user
 * export const GET = withAuth(async (request, { user }) => {
 *   return NextResponse.json({ userId: user.userId })
 * })
 * 
 * // Project access - user must own project
 * export const GET = withProjectAccess(async (request, { user, project, projectId }) => {
 *   const data = await prisma.table.findMany({
 *     where: { projectId }  // ✅ Scoped to their project
 *   })
 *   return NextResponse.json({ data })
 * })
 * 
 * // Role-based - only owners can delete
 * export const DELETE = withRole('owner', async (request, { user, project }) => {
 *   await prisma.project.delete({ where: { id: project.id } })
 *   return NextResponse.json({ success: true })
 * })
 * 
 * // API key - external access
 * export const POST = withApiKey(async (request, { projectId }) => {
 *   const body = await request.json()
 *   const result = await doSomething(projectId, body)
 *   return NextResponse.json(result)
 * })
 */
