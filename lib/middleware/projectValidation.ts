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
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/auth/middleware'

export interface ValidatedProjectRequest {
  projectId: string
  userId: string
  project: {
    id: string
    name: string
    userId: string
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
  
  // Step 3: Verify project exists and user has access — owner OR a member of
  // the project's organization (Phase 6). The org clause is additive: it matches
  // nothing for org-less projects or non-members, so owner access is unchanged.
  // Project-scoped members (Pro+): the org clause requires `restricted: false`,
  // so a restricted member only passes via the explicit projectMembers grant —
  // mirroring GET /api/projects and verifyProjectAccess.
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      OR: [
        { userId: user.userId },
        { organization: { members: { some: { userId: user.userId, restricted: false } } } },
        { projectMembers: { some: { userId: user.userId } } },
      ],
    },
    select: {
      id: true,
      name: true,
      userId: true,
    },
  })
  
  if (!project) {
    console.error(`❌ Project access denied: userId=${user.userId}, projectId=${projectId}`)
    throw NextResponse.json(
      {
        error: 'Project not found',
        message: 'Project does not exist or you do not have access',
        code: 'PROJECT_ACCESS_DENIED',
        projectId,
      },
      { status: 403 }
    )
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
