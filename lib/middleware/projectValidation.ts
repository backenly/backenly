/**
 * Project Validation Middleware
 * 
 * CRITICAL: This middleware enforces 100% project isolation
 * 
 * Every database operation MUST:
 * 1. Include projectId in the request (query param or body)
 * 2. Verify user owns the project
 * 3. Never fallback to session or guesses
 * 
 * This prevents cross-project data leakage.
 */

import { NextRequest, NextResponse } from 'next/server'

import { requireAuth } from '@/lib/auth/middleware'
import { getProjectResolver } from '@/lib/edition'
import { ProjectResolutionError } from '@/lib/edition/types'

export interface ValidatedProjectRequest {
  projectId: string
  userId: string
  project: {
    id: string
    name: string
    /**
     * Null until an operator exists to own it. A self-hosted deployment
     * bootstraps THE project before anyone has signed up, so callers must not
     * assume this is set.
     */
    userId: string | null
  }
}

/**
 * Validate and enforce project ownership
 * 
 * This is the SINGLE SOURCE OF TRUTH for project access validation
 * 
 * @returns ValidatedProjectRequest if successful
 * @throws NextResponse with 400/403 if validation fails
 */
export async function validateProjectAccess(
  request: NextRequest
): Promise<ValidatedProjectRequest> {
  // Step 1: Authenticate user
  const user = await requireAuth(request)
  
  // Step 2: Extract projectId from request
  const projectId = extractProjectId(request)
  
  if (!projectId) {
    throw NextResponse.json(
      {
        error: 'Missing projectId',
        message: 'projectId is required in query parameters or request body',
        code: 'PROJECT_ID_REQUIRED',
      },
      { status: 400 }
    )
  }
  
  // Step 3: ask the edition whether this caller may reach this project.
  //
  // This used to be a fourth hand-written copy of the ownership clause, and it
  // is reached by 39 routes, so it decided access for most of the product. On a
  // self-hosted deployment it was simply wrong: bootstrap creates THE project
  // before anyone has signed up, so `Project.userId` is NULL, no clause matched,
  // and the operator of a one-project install got 403 from their own MCP keys
  // endpoint while other routes on the same project answered 200.
  //
  // Routing it through the resolver is what makes those answers agree. Cloud
  // keeps the identical owner/organization/grant rule; single-tenant treats
  // every authenticated account as the operator, which is what it already
  // claimed to do everywhere else.
  let project: { id: string; name: string; userId: string | null }
  try {
    const resolved = await getProjectResolver().resolveForUser(user.userId, projectId)
    project = { id: resolved.id, name: resolved.name, userId: resolved.userId }
  } catch (err) {
    if (err instanceof ProjectResolutionError) {
      console.error(`❌ Project access denied: userId=${user.userId}, projectId=${projectId}`)
      throw NextResponse.json(
        {
          error: 'Project not found',
          message: 'Project does not exist or you do not have access',
          code: 'PROJECT_ACCESS_DENIED',
          projectId,
        },
        { status: err.status === 400 ? 400 : 403 }
      )
    }
    // Not an authorization answer — a dead database must not be reported as a
    // denial, or an outage looks like a permissions bug.
    throw err
  }

  console.log(`✅ Project access validated: userId=${user.userId}, projectId=${projectId}, projectName=${project.name}`)
  
  return {
    projectId: project.id,
    userId: user.userId,
    project,
  }
}

/**
 * Extract projectId from request
 * 
 * Checks in order:
 * 1. Query parameter (?projectId=xxx)
 * 2. Request body (for POST/PUT)
 * 3. URL path params (for /api/projects/[projectId]/...)
 * 
 * @returns projectId or null
 */
function extractProjectId(request: NextRequest): string | null {
  // 1. Check query parameters (most common)
  const url = new URL(request.url)
  const queryProjectId = url.searchParams.get('projectId')
  if (queryProjectId) {
    console.log(`📍 ProjectId from query: ${queryProjectId}`)
    return queryProjectId
  }
  
  // 2. Check URL path (e.g., /api/projects/abc123/database)
  const pathMatch = request.nextUrl.pathname.match(/\/projects\/([a-zA-Z0-9-_]+)/)
  if (pathMatch && pathMatch[1]) {
    console.log(`📍 ProjectId from path: ${pathMatch[1]}`)
    return pathMatch[1]
  }
  
  // 3. For POST/PUT, check body (note: this consumes the body)
  // We'll handle this in the API route if needed
  
  console.warn(`⚠️ No projectId found in request: ${request.method} ${request.nextUrl.pathname}`)
  return null
}

/**
 * Middleware wrapper for API routes that require project validation
 * 
 * Usage:
 * ```ts
 * export async function GET(request: NextRequest) {
 *   return withProjectValidation(request, async (validatedRequest) => {
 *     // Your API logic here with guaranteed valid projectId
 *     const { projectId, userId, project } = validatedRequest
 *     // ... safe to use projectId
 *   })
 * }
 * ```
 */
export async function withProjectValidation<T>(
  request: NextRequest,
  handler: (validated: ValidatedProjectRequest) => Promise<NextResponse<T>>
): Promise<NextResponse<T>> {
  try {
    const validated = await validateProjectAccess(request)
    return await handler(validated)
  } catch (error) {
    if (error instanceof NextResponse) {
      return error as NextResponse<T>
    }
    
    console.error('❌ Unexpected error in project validation:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: 'An unexpected error occurred during project validation',
      },
      { status: 500 }
    ) as NextResponse<T>
  }
}
