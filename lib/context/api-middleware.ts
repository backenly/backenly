/**
 * PHASE 1: API Middleware with Execution Context Enforcement
 * 
 * Gateway-level enforcement that REJECTS requests without valid project_id
 */

import { NextRequest, NextResponse } from 'next/server'
import { 
  ExecutionContext, 
  createExecutionContextFromRequest, 
  ExecutionContextError 
} from './execution-context'
import { withAuth } from '@/lib/auth/route-protection'

export interface ApiHandler<T = any> {
  (context: ExecutionContext): Promise<NextResponse<T>>
}

/**
 * API Gateway middleware that enforces execution context
 * 
 * USAGE:
 * export const GET = withProjectContext(async (context) => {
 *   // context.projectId is guaranteed to exist
 *   // All database operations MUST use this context
 *   return NextResponse.json({ projectId: context.projectId })
 * })
 * 
 * CRITICAL: This is the ONLY way to create API handlers
 */
export function withProjectContext<T = any>(
  handler: ApiHandler<T>
): (request: NextRequest) => Promise<NextResponse> {
  return withAuth(async (request: NextRequest, { user }) => {
    try {
      // Create execution context (validates project_id and access)
      const context = await createExecutionContextFromRequest(request, user.userId)
      
      // Execute handler with guaranteed context
      return await handler(context)
      
    } catch (error) {
      if (error instanceof ExecutionContextError) {
        // Gateway rejection - no project_id or invalid access
        return NextResponse.json(
          {
            error: 'Project context required',
            message: error.message,
            code: 'NO_PROJECT_CONTEXT',
          },
          { status: 400 }
        )
      }
      
      // Unknown error
      console.error('[API Gateway] Unexpected error:', error)
      return NextResponse.json(
        {
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
        { status: 500 }
      )
    }
  })
}

/**
 * Background job wrapper with execution context
 * 
 * USAGE:
 * await executeBackgroundJob(projectId, userId, async (context) => {
 *   // Execute project-scoped work
 * })
 */
export async function executeBackgroundJob<T>(
  projectId: string,
  userId: string | undefined,
  job: (context: ExecutionContext) => Promise<T>
): Promise<T> {
  const { createBackgroundExecutionContext } = await import('./execution-context')
  
  const context = await createBackgroundExecutionContext(projectId, userId)
  
  console.log(`[Background Job] Starting: ${context.executionId} | Project: ${projectId}`)
  
  try {
    const result = await job(context)
    console.log(`[Background Job] Complete: ${context.executionId}`)
    return result
  } catch (error) {
    console.error(`[Background Job] Failed: ${context.executionId}`, error)
    throw error
  }
}
