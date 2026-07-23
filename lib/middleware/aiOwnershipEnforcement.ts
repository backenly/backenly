/**
 * AI Ownership Enforcement Middleware
 * 
 * This module enforces that all backend modifications go through the AI-managed
 * blueprint system. Direct schema, API, or auth modifications are blocked.
 * 
 * Philosophy:
 * - AI is the single source of truth for backend architecture
 * - Users describe intent, AI executes deterministically
 * - Manual overrides are explicitly rejected
 */

export interface EnforcementError {
  code: string
  message: string
  userMessage: string
  suggestedAction: string
}

/**
 * Checks if a request is attempting to directly modify backend infrastructure
 * outside of the AI execution flow
 */
export function isDirectInfrastructureModification(
  operation: string,
  context: { isAIExecution?: boolean; hasBlueprint?: boolean }
): boolean {
  // Allow modifications from AI execution engine
  if (context.isAIExecution) {
    return false
  }

  // Block operations that modify infrastructure
  const blockedOperations = [
    'CREATE_TABLE',
    'ALTER_TABLE',
    'DROP_TABLE',
    'ADD_COLUMN',
    'DROP_COLUMN',
    'MODIFY_COLUMN',
    'CREATE_INDEX',
    'DROP_INDEX',
    'CREATE_API',
    'MODIFY_API',
    'DELETE_API',
    'ENABLE_AUTH_PROVIDER',
    'DISABLE_AUTH_PROVIDER',
    'MODIFY_AUTH_CONFIG',
    'CREATE_STORAGE_BUCKET',
    'DELETE_STORAGE_BUCKET',
  ]

  return blockedOperations.includes(operation)
}

/**
 * Generates enforcement error with helpful messaging
 */
export function createEnforcementError(operation: string, projectId?: string): EnforcementError {
  const operationDescriptions: Record<string, string> = {
    CREATE_TABLE: 'create a table',
    ALTER_TABLE: 'modify table structure',
    DROP_TABLE: 'delete a table',
    ADD_COLUMN: 'add a column',
    DROP_COLUMN: 'remove a column',
    MODIFY_COLUMN: 'modify a column',
    CREATE_INDEX: 'create an index',
    DROP_INDEX: 'drop an index',
    CREATE_API: 'create an API endpoint',
    MODIFY_API: 'modify an API endpoint',
    DELETE_API: 'delete an API endpoint',
    ENABLE_AUTH_PROVIDER: 'enable authentication',
    DISABLE_AUTH_PROVIDER: 'disable authentication',
    MODIFY_AUTH_CONFIG: 'modify authentication',
    CREATE_STORAGE_BUCKET: 'create a storage bucket',
    DELETE_STORAGE_BUCKET: 'delete a storage bucket',
  }

  const actionDescription = operationDescriptions[operation] || 'modify backend infrastructure'
  const changePageUrl = projectId ? `/app/projects/${projectId}/intent-log` : '/app'

  return {
    code: 'AI_OWNERSHIP_ENFORCED',
    message: `Direct ${operation} blocked: AI-managed backend`,
    userMessage: `Backenly manages backend state via AI. Manual edits are not allowed.`,
    suggestedAction: `To ${actionDescription}, describe what you want on the Change page and Backenly will execute it deterministically.`,
  }
}

/**
 * Middleware function to enforce AI ownership on API routes
 */
export function enforceAIOwnership(
  operation: string,
  context: {
    isAIExecution?: boolean
    hasBlueprint?: boolean
    projectId?: string
  }
): { allowed: boolean; error?: EnforcementError } {
  const isBlocked = isDirectInfrastructureModification(operation, context)

  if (isBlocked) {
    return {
      allowed: false,
      error: createEnforcementError(operation, context.projectId),
    }
  }

  return { allowed: true }
}

/**
 * Checks if a request has the AI execution token
 * This is set internally by the execution engine
 */
export function isAIExecutionRequest(headers: Headers | Record<string, string>): boolean {
  const token = headers instanceof Headers 
    ? headers.get('X-AI-Execution-Token')
    : headers['X-AI-Execution-Token'] || headers['x-ai-execution-token']

  // Check for internal execution token
  // In production, this would be a signed JWT with short expiry
  return token === process.env.AI_EXECUTION_TOKEN
}

/**
 * Logs enforcement events for monitoring
 */
export function logEnforcementEvent(
  projectId: string,
  operation: string,
  userId: string | null,
  blocked: boolean
): void {
  const event = {
    timestamp: new Date().toISOString(),
    projectId,
    operation,
    userId,
    blocked,
    enforcement: 'AI_OWNERSHIP',
  }

  console.log('[AI Ownership Enforcement]', JSON.stringify(event))

  // In production, send to monitoring system
  // Example: Sentry, DataDog, CloudWatch, etc.
}

/**
 * Feature flag check for gradual rollout
 * Allows disabling enforcement for specific projects during migration
 */
export function isEnforcementEnabled(projectId: string): boolean {
  // Check for bypass flag (for migration/testing)
  const bypassFlag = process.env.BYPASS_AI_ENFORCEMENT === 'true'
  if (bypassFlag) {
    console.warn(`[AI Ownership] Enforcement bypassed via env flag for ${projectId}`)
    return false
  }

  // Check project-specific bypass (stored in metadata)
  // This would be in the database in production
  const projectBypass = false // TODO: Check project metadata

  return !projectBypass
}

/**
 * Formats enforcement error for API response
 */
export function formatEnforcementErrorResponse(error: EnforcementError) {
  return {
    success: false,
    error: error.code,
    message: error.userMessage,
    suggestedAction: error.suggestedAction,
    details: {
      enforcement: 'AI_OWNERSHIP',
      reason: 'Backenly is an AI-managed platform. All backend modifications must go through the Change page.',
    },
  }
}
