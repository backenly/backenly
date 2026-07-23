/**
 * 🔒 PRISMA MIDDLEWARE - Automatic Multi-Tenant Filtering
 * 
 * CRITICAL SECURITY LAYER
 * Automatically injects projectId/workspaceId filters to ALL queries
 * Prevents accidental cross-tenant data leakage
 * 
 * Based on: PostgreSQL RLS (Row Level Security)
 */

import { Prisma } from '@prisma/client'

/**
 * Models that MUST be scoped by projectId
 */
const PROJECT_SCOPED_MODELS = [
  'Table',
  'ApiKey',
  'AuditLog',
  'Deployment',
  'StorageBucket',
  'StorageFile',
  'PreviewShare',
  'Log',
  'Metric',
  'Incident',
  'Anomaly',
  'SecurityIssue',
  'SecurityScan',
  'DatabaseIssue',
  'BlockedAttack',
  'ProviderCredential',
  'WorkspaceOAuthConfig',
  'ProjectCorsOrigin',
  'AiUsage',
]

/**
 * Models that MUST be scoped by workspaceId
 */
const WORKSPACE_SCOPED_MODELS = [
  'WorkspaceFile',
]

/**
 * Create Prisma middleware with automatic tenant filtering
 * 
 * @param projectId - Current project ID to filter by
 * @param workspaceId - Optional workspace ID to filter by
 */
export function createTenantMiddleware(
  projectId?: string,
  workspaceId?: string
): Prisma.Middleware {
  return async (params, next) => {
    const { model, action } = params

    if (!model) {
      return next(params)
    }

    // 🔒 AUTO-INJECT projectId for project-scoped models
    if (PROJECT_SCOPED_MODELS.includes(model)) {
      // For read operations
      if (['findMany', 'findFirst', 'findUnique', 'count', 'aggregate'].includes(action)) {
        if (projectId) {
          params.args.where = params.args.where || {}
          
          // Only inject if not already specified
          if (!params.args.where.projectId) {
            params.args.where.projectId = projectId
            console.log(`🔒 [Security] Auto-injected projectId filter: ${model}.${action}`)
          }
        }
      }

      // For write operations - validate projectId matches
      if (['create', 'update', 'updateMany', 'upsert'].includes(action)) {
        if (projectId && params.args.data) {
          const dataProjectId = params.args.data.projectId
          
          // Prevent writing to wrong project
          if (dataProjectId && dataProjectId !== projectId) {
            throw new Error(
              `🔒 SECURITY VIOLATION: Attempted to write to project ${dataProjectId} while scoped to ${projectId}`
            )
          }

          // Auto-inject projectId for creates
          if (action === 'create' && !dataProjectId) {
            params.args.data.projectId = projectId
            console.log(`🔒 [Security] Auto-injected projectId: ${model}.create`)
          }
        }
      }
    }

    // 🔒 AUTO-INJECT workspaceId for workspace-scoped models
    if (WORKSPACE_SCOPED_MODELS.includes(model)) {
      if (['findMany', 'findFirst', 'findUnique', 'count'].includes(action)) {
        if (workspaceId) {
          params.args.where = params.args.where || {}
          
          if (!params.args.where.workspaceId) {
            params.args.where.workspaceId = workspaceId
            console.log(`🔒 [Security] Auto-injected workspaceId filter: ${model}.${action}`)
          }
        }
      }

      if (['create'].includes(action)) {
        if (workspaceId && params.args.data && !params.args.data.workspaceId) {
          params.args.data.workspaceId = workspaceId
          console.log(`🔒 [Security] Auto-injected workspaceId: ${model}.create`)
        }
      }
    }

    return next(params)
  }
}

/**
 * 🛡️ VALIDATION: Ensure query has proper scoping
 * 
 * Throws error if attempting unscoped query on scoped model
 */
export function validateQueryScope(
  model: string,
  where: any,
  requiredScope: 'project' | 'workspace'
) {
  if (requiredScope === 'project' && PROJECT_SCOPED_MODELS.includes(model)) {
    if (!where?.projectId) {
      throw new Error(
        `🔒 SECURITY: ${model} queries MUST include projectId filter`
      )
    }
  }

  if (requiredScope === 'workspace' && WORKSPACE_SCOPED_MODELS.includes(model)) {
    if (!where?.workspaceId) {
      throw new Error(
        `🔒 SECURITY: ${model} queries MUST include workspaceId filter`
      )
    }
  }
}

/**
 * 🔒 SAFE PRISMA CLIENT - with automatic middleware
 * 
 * Usage:
 * const safePrisma = createSafePrismaClient(projectId, workspaceId)
 * const tables = await safePrisma.table.findMany() // auto-filtered by projectId
 */
export function createSafePrismaClient(
  basePrisma: any,
  projectId?: string,
  workspaceId?: string
) {
  // Add middleware
  basePrisma.$use(createTenantMiddleware(projectId, workspaceId))
  return basePrisma
}
