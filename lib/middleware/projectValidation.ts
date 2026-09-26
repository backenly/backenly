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
import { touchProjectActivity } from '@/lib/projects/activity'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

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
  const extracted = extractProjectId(request)

  // A request naming two different projects is refused outright. Resolving it
  // in favour of either one is what would let a caller authorize project A and
  // operate on project B.
  if (extracted === PROJECT_ID_CONFLICT) {
    throw NextResponse.json(
      {
        error: 'Conflicting projectId',
        message: 'The URL path and the projectId query parameter name different projects.',
      },
      { status: 400 },
    )
  }
  const projectId = extracted
  
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
 * The PATH WINS, and a disagreement is refused.
 *
 * This used to return the query parameter whenever one was present, falling
 * back to the path. That made a confused deputy possible by construction: a
 * request to `/api/projects/VICTIM/thing?projectId=MINE` would AUTHORIZE the
 * caller's own project and then, in any handler that read its path parameter,
 * ACT ON somebody else's.
 *
 * No route in the tree mixed the two that way - every handler under
 * withProjectValidation uses the authorized id it is handed - so this was a
 * latent hazard rather than a live defect. It was one careless edit from being
 * real, and the edit would have looked entirely reasonable.
 *
 * Two rules now, and neither depends on a caller remembering anything:
 *
 *   - when the path carries a project id, that is the id, full stop
 *   - when both are present and DIFFER, the request is refused rather than
 *     silently resolved in favour of either
 *
 * Refusing beats preferring the path: a request carrying two different project
 * ids is not a request anybody meant to send, and answering it at all invites
 * somebody to build on the behaviour.
 *
 * @returns projectId, or null when absent, or a ProjectIdConflict when the two
 *          sources disagree
 */
/** Returned when the path and the query name different projects. */
export const PROJECT_ID_CONFLICT = Symbol('PROJECT_ID_CONFLICT')

/**
 * The decision itself, as a pure function.
 *
 * Separated from the request so it can be tested without constructing a
 * NextRequest - which the test environment's Request polyfill cannot build.
 * The rule is the security-relevant part; reading two values off a request is
 * not, and tying them together would have left the rule untested.
 */
export function resolveProjectId(
  pathname: string,
  queryProjectId: string | null,
): string | null | typeof PROJECT_ID_CONFLICT {
  // The path is authoritative. `/projects/<id>/...` is part of the route's
  // identity; a query parameter is something a caller appended.
  const pathMatch = pathname.match(/\/projects\/([a-zA-Z0-9-_]+)/)
  const pathProjectId = pathMatch?.[1] ?? null

  if (pathProjectId && queryProjectId && pathProjectId !== queryProjectId) {
    return PROJECT_ID_CONFLICT
  }
  if (pathProjectId) return pathProjectId
  if (queryProjectId) return queryProjectId
  return null
}

export function extractProjectId(
  request: NextRequest,
): string | null | typeof PROJECT_ID_CONFLICT {
  const url = new URL(request.url)
  const resolved = resolveProjectId(request.nextUrl.pathname, url.searchParams.get('projectId'))

  if (resolved === PROJECT_ID_CONFLICT) {
    console.warn(
      `⚠️ Refusing a request naming two different projects: ` +
      `${request.method} ${request.nextUrl.pathname}?projectId=${url.searchParams.get('projectId')}`,
    )
  } else if (resolved === null) {
    console.warn(`⚠️ No projectId found in request: ${request.method} ${request.nextUrl.pathname}`)
  }
  return resolved
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
    // A member CHANGING the project is using it. Reads are deliberately not
    // counted: this wrapper also serves history, usage, health and every other
    // panel the dashboard polls, and an open tab must not keep an abandoned
    // backend awake. Opening the console is counted separately, once, by the
    // activity beacon (app/api/projects/[id]/activity).
    if (!SAFE_METHODS.has(request.method.toUpperCase())) {
      void touchProjectActivity(validated.projectId)
    }
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
