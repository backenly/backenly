/**
 * PHASE 3: Project-Scoped API Gateway
 * 
 * ALL API requests routed through gateway that resolves project context BEFORE execution
 * No API handler can be invoked without validated project scope
 */

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { ExecutionContext, createExecutionContextFromRequest } from '@/lib/context/execution-context'
import { validateTokenForContext } from '@/lib/auth/project-scoped-tokens'

export class ApiGatewayError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message)
    this.name = 'ApiGatewayError'
  }
}

/**
 * API Gateway Handler signature
 * 
 * CRITICAL: All handlers receive ExecutionContext, never raw request
 */
export type ApiGatewayHandler<T = any> = (
  context: ExecutionContext,
  request: NextRequest
) => Promise<NextResponse<T>>

/**
 * API Gateway Request metadata
 */
interface GatewayMetadata {
  requestId: string
  startTime: number
  endpoint: string
  method: string
}

/**
 * Main API Gateway
 * 
 * Resolves project context BEFORE invoking handler
 * Rejects requests without valid project scope
 * 
 * Usage:
 * export const GET = apiGateway(async (context, request) => {
 *   // context.projectId guaranteed to exist
 *   // All operations automatically scoped to project
 *   return NextResponse.json({ data: 'protected' })
 * })
 */
export function apiGateway<T = any>(
  handler: ApiGatewayHandler<T>
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest) => {
    const metadata: GatewayMetadata = {
      requestId: `gw_${crypto.randomUUID()}`,
      startTime: Date.now(),
      endpoint: request.nextUrl.pathname,
      method: request.method,
    }
    
    console.log(
      `[API Gateway] ${metadata.requestId} | ${metadata.method} ${metadata.endpoint}`
    )
    
    try {
      // STEP 1: Extract and validate auth token
      const authHeader = request.headers.get('authorization')
      if (!authHeader) {
        throw new ApiGatewayError(
          'Missing authorization header',
          'MISSING_AUTH',
          401
        )
      }
      
      // STEP 2: Create execution context (validates project_id)
      const context = await createExecutionContextFromRequest(request)
      
      // STEP 3: Validate token against context (prevents token reuse across projects)
      const token = authHeader.replace('Bearer ', '')
      await validateTokenForContext(token, context)
      
      console.log(
        `[API Gateway] ${metadata.requestId} | Project: ${context.projectId} | User: ${context.userId}`
      )
      
      // STEP 4: Invoke handler with guaranteed project context
      const response = await handler(context, request)
      
      const duration = Date.now() - metadata.startTime
      console.log(
        `[API Gateway] ${metadata.requestId} | Complete (${duration}ms)`
      )
      
      // Add security headers
      response.headers.set('X-Project-Id', context.projectId)
      response.headers.set('X-Execution-Id', context.executionId)
      response.headers.set('X-Content-Type-Options', 'nosniff')
      response.headers.set('X-Frame-Options', 'DENY')
      
      return response
      
    } catch (error) {
      const duration = Date.now() - metadata.startTime
      
      if (error instanceof ApiGatewayError) {
        console.error(
          `[API Gateway] ${metadata.requestId} | ${error.code} (${duration}ms)`
        )
        
        return NextResponse.json(
          {
            error: error.code,
            message: error.message,
            requestId: metadata.requestId,
          },
          { status: error.status }
        )
      }
      
      console.error(
        `[API Gateway] ${metadata.requestId} | Unexpected error (${duration}ms):`,
        error
      )
      
      return NextResponse.json(
        {
          error: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
          requestId: metadata.requestId,
        },
        { status: 500 }
      )
    }
  }
}

/**
 * Public API Gateway (for external client APIs)
 * 
 * Resolves project from API key instead of session
 */
export function publicApiGateway<T = any>(
  handler: ApiGatewayHandler<T>
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest) => {
    const metadata: GatewayMetadata = {
      requestId: `pub_gw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      startTime: Date.now(),
      endpoint: request.nextUrl.pathname,
      method: request.method,
    }
    
    console.log(
      `[Public API Gateway] ${metadata.requestId} | ${metadata.method} ${metadata.endpoint}`
    )
    
    try {
      // STEP 1: Extract API key
      const authHeader = request.headers.get('authorization')
      if (!authHeader) {
        throw new ApiGatewayError(
          'Missing API key. Provide Authorization: Bearer <api-key>',
          'MISSING_API_KEY',
          401
        )
      }
      
      const apiKey = authHeader.replace('Bearer ', '')
      
      // STEP 2: Validate API key and resolve project (stub for now)
      // TODO: Implement full API key validation
      const projectId = request.headers.get('x-project-id')
      if (!projectId) {
        throw new ApiGatewayError(
          'Invalid API key or missing project context',
          'INVALID_API_KEY',
          401
        )
      }
      const userId = 'api-key-user'
      
      // STEP 3: Create execution context
      const { createOrchestrationContext } = await import('@/lib/context/execution-context')
      const context = await createOrchestrationContext(projectId, userId, {
        apiKey: true,
        source: 'public_api',
      })
      
      console.log(
        `[Public API Gateway] ${metadata.requestId} | Project: ${projectId}`
      )
      
      // STEP 4: Invoke handler
      const response = await handler(context, request)
      
      const duration = Date.now() - metadata.startTime
      console.log(
        `[Public API Gateway] ${metadata.requestId} | Complete (${duration}ms)`
      )
      
      // Add security headers
      response.headers.set('X-Project-Id', projectId)
      response.headers.set('X-Execution-Id', context.executionId)
      
      return response
      
    } catch (error) {
      const duration = Date.now() - metadata.startTime
      
      if (error instanceof ApiGatewayError) {
        console.error(
          `[Public API Gateway] ${metadata.requestId} | ${error.code} (${duration}ms)`
        )
        
        return NextResponse.json(
          {
            error: error.code,
            message: error.message,
            requestId: metadata.requestId,
          },
          { status: error.status }
        )
      }
      
      console.error(
        `[Public API Gateway] ${metadata.requestId} | Unexpected error (${duration}ms):`,
        error
      )
      
      return NextResponse.json(
        {
          error: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
          requestId: metadata.requestId,
        },
        { status: 500 }
      )
    }
  }
}


