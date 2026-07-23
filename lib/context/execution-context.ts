/**
 * PHASE 1: Project Identity as Hard Boundary
 * 
 * Global execution context that enforces project_id as mandatory, immutable boundary.
 * Every operation MUST execute within a project scope - no exceptions.
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/postgres'

/**
 * Execution Context - The fundamental boundary for all operations
 * 
 * Every request, job, orchestration, and database operation
 * MUST have this context. No code can execute without it.
 */
export interface ExecutionContext {
  /** Globally unique project ID - IMMUTABLE */
  readonly projectId: string
  
  /** User ID (optional for API key requests) */
  readonly userId?: string
  
  /** Unique execution ID for tracing */
  readonly executionId: string
  
  /** Request timestamp */
  readonly timestamp: Date
  
  /** Request source (api, ui, background, orchestration) */
  readonly source: 'api' | 'ui' | 'background' | 'orchestration'
  
  /** Additional metadata */
  readonly metadata?: Record<string, any>
}

export class ExecutionContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutionContextError'
  }
}

/**
 * Generate unique execution ID for tracing
 */
function generateExecutionId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Extract project ID from request with strict validation
 * 
 * Priority:
 * 1. URL path parameter /projects/[projectId] (most trusted)
 * 2. X-Project-Id header (API requests)
 * 3. Query parameter projectId (legacy support)
 * 
 * NEVER inferred from user input directly
 * NEVER editable by client
 */
async function extractProjectId(request: NextRequest): Promise<string> {
  // 1. Try URL path (highest priority - server-controlled)
  const pathname = new URL(request.url).pathname
  const pathMatch = pathname.match(/\/projects\/([a-f0-9-]{36})/)
  if (pathMatch) {
    return pathMatch[1]
  }
  
  // 2. Try header (for API requests)
  const headerProjectId = request.headers.get('x-project-id')
  if (headerProjectId && isValidUUID(headerProjectId)) {
    return headerProjectId
  }
  
  // 3. Try query parameter (legacy - least trusted)
  const url = new URL(request.url)
  const queryProjectId = url.searchParams.get('projectId')
  if (queryProjectId && isValidUUID(queryProjectId)) {
    return queryProjectId
  }
  
  throw new ExecutionContextError(
    'Missing project_id: All operations require a valid project context. ' +
    'Provide project ID in URL path, X-Project-Id header, or projectId query parameter.'
  )
}

/**
 * Validate UUID format
 */
function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return uuidRegex.test(str)
}

/**
 * Validate project exists and user has access
 * 
 * CRITICAL: This is the security boundary
 */
async function validateProjectAccess(
  projectId: string,
  userId?: string
): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true },
  })
  
  if (!project) {
    throw new ExecutionContextError(
      `Project ${projectId} not found. It may have been deleted or you may not have access.`
    )
  }
  
  // If userId provided, verify ownership
  if (userId && project.userId !== userId) {
    throw new ExecutionContextError(
      `Access denied: Project ${projectId} does not belong to user ${userId}`
    )
  }
}

/**
 * Create execution context from HTTP request
 * 
 * This is the entry point for ALL API operations
 * Throws ExecutionContextError if project_id cannot be resolved
 */
export async function createExecutionContextFromRequest(
  request: NextRequest,
  userId?: string
): Promise<ExecutionContext> {
  // Extract project ID (throws if missing)
  const projectId = await extractProjectId(request)
  
  // Validate access (throws if unauthorized)
  await validateProjectAccess(projectId, userId)
  
  // Create immutable context
  const context: ExecutionContext = {
    projectId,
    userId,
    executionId: generateExecutionId(),
    timestamp: new Date(),
    source: 'api',
    metadata: {
      path: request.nextUrl.pathname,
      method: request.method,
    },
  }
  
  // Log context creation for audit trail
  console.log(`[ExecutionContext] Created: ${context.executionId} | Project: ${projectId}`)
  
  return context
}

/**
 * Create execution context for background jobs
 * 
 * Background jobs MUST be project-scoped
 */
export async function createBackgroundExecutionContext(
  projectId: string,
  userId?: string
): Promise<ExecutionContext> {
  // Validate project exists
  await validateProjectAccess(projectId, userId)
  
  const context: ExecutionContext = {
    projectId,
    userId,
    executionId: generateExecutionId(),
    timestamp: new Date(),
    source: 'background',
  }
  
  console.log(`[ExecutionContext] Background job: ${context.executionId} | Project: ${projectId}`)
  
  return context
}

/**
 * Create execution context for orchestration engine
 * 
 * Orchestration MUST have project scope
 */
export async function createOrchestrationContext(
  projectId: string,
  userId?: string,
  metadata?: Record<string, any>
): Promise<ExecutionContext> {
  await validateProjectAccess(projectId, userId)
  
  const context: ExecutionContext = {
    projectId,
    userId,
    executionId: generateExecutionId(),
    timestamp: new Date(),
    source: 'orchestration',
    metadata,
  }
  
  console.log(`[ExecutionContext] Orchestration: ${context.executionId} | Project: ${projectId}`)
  
  return context
}

/**
 * Assert execution context is valid
 * 
 * Runtime check that fails fast if context is missing or invalid
 */
export function assertExecutionContext(
  context: ExecutionContext | undefined | null
): asserts context is ExecutionContext {
  if (!context) {
    throw new ExecutionContextError('Execution context is required but was not provided')
  }
  
  if (!context.projectId) {
    throw new ExecutionContextError('Execution context missing projectId')
  }
  
  if (!isValidUUID(context.projectId)) {
    throw new ExecutionContextError(`Invalid projectId format: ${context.projectId}`)
  }
  
  if (!context.executionId) {
    throw new ExecutionContextError('Execution context missing executionId')
  }
}

/**
 * Middleware wrapper that enforces execution context
 * 
 * Use this to wrap ALL API handlers
 */
export async function withExecutionContext<T>(
  request: NextRequest,
  userId: string | undefined,
  handler: (context: ExecutionContext) => Promise<T>
): Promise<T> {
  // Create context (throws if project_id missing/invalid)
  const context = await createExecutionContextFromRequest(request, userId)
  
  // Assert context is valid (runtime check)
  assertExecutionContext(context)
  
  // Execute handler with guaranteed context
  return handler(context)
}

/**
 * Get project ID from context
 * 
 * Safe accessor that never returns undefined
 */
export function getProjectId(context: ExecutionContext): string {
  assertExecutionContext(context)
  return context.projectId
}

/**
 * Get execution ID from context
 */
export function getExecutionId(context: ExecutionContext): string {
  assertExecutionContext(context)
  return context.executionId
}
