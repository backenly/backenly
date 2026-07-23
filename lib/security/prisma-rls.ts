/**
 * 🔒 SECURITY: Row-Level Security (RLS) Middleware
 * 
 * This ensures all Prisma queries are automatically filtered by projectId
 * to prevent cross-tenant data leakage.
 * 
 * CRITICAL: Every database query MUST go through this middleware.
 */

import { PrismaClient } from '@prisma/client'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'

export function createSecurePrismaClient(baseProjectId?: string) {
  const prisma = new PrismaClient()

  // Intercept all queries and inject projectId filter
  return prisma.$extends({
    query: {
      // Add projectId filter to all models that have it
      $allModels: {
        async $allOperations({ operation, model, args, query }) {
          // Models that should be filtered by projectId
          const projectScopedModels = [
            'Table',
            'ApiKey', 
            'AuditLog',
            'Deployment',
            'StorageBucket',
            'File',
            'PreviewShare'
          ]

          if (projectScopedModels.includes(model)) {
            // For read operations, always filter by projectId
            if (['findMany', 'findFirst', 'findUnique', 'count', 'aggregate'].includes(operation)) {
              // @ts-expect-error - Prisma args is complex union type, where exists on read ops
              if (!args.where) {
                // @ts-expect-error - Same as above
                args.where = {}
              }
              
              // Inject projectId if provided
              // @ts-expect-error - Same as above
              if (baseProjectId && !args.where.projectId) {
                // @ts-expect-error - Same as above
                args.where.projectId = baseProjectId
              }
            }

            // For write operations, validate projectId matches
            if (['create', 'update', 'updateMany', 'delete', 'deleteMany'].includes(operation)) {
              // @ts-expect-error - Prisma args is complex union type, data/where exists on write ops
              const providedProjectId = args.data?.projectId || args.where?.projectId
              
              if (baseProjectId && providedProjectId && providedProjectId !== baseProjectId) {
                throw new Error(`🔒 SECURITY VIOLATION: Attempted to access project ${providedProjectId} while authenticated for project ${baseProjectId}`)
              }
            }
          }

          return query(args)
        },
      },
    },
  })
}

/**
 * Validate that a user has access to a project
 */
export async function validateProjectAccess(
  userId: string,
  projectId: string,
  prisma: PrismaClient
): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      userId: userId,
    },
  })

  return !!project
}

/**
 * Ensure workspace schema isolation
 * Validates that queries only access the correct workspace schema
 */
export function validateWorkspaceSchema(projectId: string, schemaName: string): boolean {
  // Single source of truth — must match how the schema is actually named at
  // provision/CREATE-TABLE time (canonical sanitiser keeps hyphens). A local
  // regex here would silently reject the correct schema.
  const expectedSchema = getWorkspaceDatabaseNames(projectId).postgresSchema

  if (schemaName !== expectedSchema) {
    console.error(`🔒 SECURITY: Schema mismatch! Expected ${expectedSchema}, got ${schemaName}`)
    return false
  }
  
  return true
}

/**
 * Sanitize SQL inputs to prevent SQL injection
 */
export function sanitizeSQLIdentifier(identifier: string): string {
  // Remove any characters that aren't alphanumeric, underscore, or hyphen
  return identifier.replace(/[^a-zA-Z0-9_-]/g, '')
}
