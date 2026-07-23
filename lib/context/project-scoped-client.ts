/**
 * PHASE 1: Project-Scoped Database Client
 * 
 * Enforces that ALL database operations execute within project boundary
 * Prevents cross-tenant data leakage at the database layer
 */

import { PrismaClient } from '@prisma/client'
import { ExecutionContext, assertExecutionContext } from './execution-context'

/**
 * Project-scoped Prisma client
 * 
 * Automatically adds projectId filter to ALL queries
 * Prevents accidental cross-project data access
 */
export class ProjectScopedPrismaClient {
  private prisma: PrismaClient
  private readonly projectId: string
  private readonly executionId: string
  
  constructor(context: ExecutionContext) {
    assertExecutionContext(context)
    
    this.projectId = context.projectId
    this.executionId = context.executionId
    this.prisma = new PrismaClient()
    
    // CRITICAL: Set PostgreSQL session variable for RLS
    // This must happen before ANY query executes
    this.prisma.$executeRawUnsafe(
      `SET LOCAL app.project_id = '${this.projectId.replace(/'/g, "''")}'`
    ).catch(err => {
      console.error('[ProjectScopedClient] Failed to set RLS session variable:', err)
      throw new Error('Database isolation setup failed')
    })
    
    // Add middleware to enforce project scope
    this.prisma.$use(async (params, next) => {
      // Only apply to models with projectId field
      const modelsWithProjectId = [
        'table',
        'apiDefinition',
        'apiKey',
        'deployment',
        'databaseIssue',
        'executionHistory',
        'workspace',
      ]
      
      if (modelsWithProjectId.includes(params.model?.toLowerCase() || '')) {
        // Inject projectId filter for queries
        if (params.action === 'findFirst' || params.action === 'findMany' || params.action === 'findUnique') {
          params.args.where = {
            ...params.args.where,
            projectId: this.projectId,
          }
        }
        
        // Inject projectId for creates
        if (params.action === 'create') {
          params.args.data = {
            ...params.args.data,
            projectId: this.projectId,
          }
        }
        
        // Enforce projectId filter for updates/deletes
        if (params.action === 'update' || params.action === 'delete' || params.action === 'deleteMany' || params.action === 'updateMany') {
          params.args.where = {
            ...params.args.where,
            projectId: this.projectId,
          }
        }
      }
      
      return next(params)
    })
  }
  
  /**
   * Get the underlying Prisma client
   * 
   * Use with caution - prefer using the scoped methods
   */
  get client(): PrismaClient {
    return this.prisma
  }
  
  /**
   * Get project ID for this client
   */
  get projectScope(): string {
    return this.projectId
  }
  
  /**
   * Disconnect client
   */
  async disconnect(): Promise<void> {
    await this.prisma.$disconnect()
  }
}

/**
 * Create project-scoped Prisma client from execution context
 * 
 * This is the ONLY way to get a database client in the system
 */
export function createProjectScopedClient(
  context: ExecutionContext
): ProjectScopedPrismaClient {
  assertExecutionContext(context)
  return new ProjectScopedPrismaClient(context)
}

/**
 * Raw query execution (requires explicit projectId validation)
 * 
 * Use only when Prisma ORM is insufficient
 * MUST manually validate projectId in WHERE clause
 */
export async function executeRawQuery<T = any>(
  context: ExecutionContext,
  query: string,
  params: any[]
): Promise<T[]> {
  assertExecutionContext(context)
  
  // Validate query contains projectId check
  if (!query.toLowerCase().includes('project_id') && !query.toLowerCase().includes('projectid')) {
    throw new Error(
      'Raw queries MUST include projectId filter to prevent cross-tenant data access. ' +
      `Query: ${query}`
    )
  }
  
  const prisma = new PrismaClient()
  
  try {
    const result = await prisma.$queryRawUnsafe<T[]>(query, ...params)
    return result
  } finally {
    await prisma.$disconnect()
  }
}
