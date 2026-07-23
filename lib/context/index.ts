/**
 * PHASE 1: Project Identity as Hard Boundary - Public API
 * 
 * Central export for execution context enforcement system
 */

// Core execution context
export type { ExecutionContext } from './execution-context'
export type { ApiHandler } from './api-middleware'
export {
  ExecutionContextError,
  createExecutionContextFromRequest,
  createBackgroundExecutionContext,
  createOrchestrationContext,
  assertExecutionContext,
  withExecutionContext,
  getProjectId,
  getExecutionId,
} from './execution-context'

// Project-scoped database client
export type { ProjectScopedPrismaClient } from './project-scoped-client'
export {
  createProjectScopedClient,
  executeRawQuery,
} from './project-scoped-client'

// API middleware
export {
  withProjectContext,
  executeBackgroundJob,
} from './api-middleware'
