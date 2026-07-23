/**
 * Workspace Database Connection Manager
 * 
 * Provides workspace-specific database connections for:
 * - PostgreSQL (schema-scoped)
 * - MongoDB (database-scoped)
 * 
 * This enables true multi-tenancy with proper isolation.
 */

import { prisma } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { MongoClient, Db, Collection, Document } from 'mongodb'
import { getWorkspaceDatabaseNames } from './databaseProvisioning'

// Shared MongoDB client (singleton)
let mongoClient: MongoClient | null = null

/**
 * Get or create shared MongoDB client
 */
export async function getMongoClient(): Promise<MongoClient | null> {
  if (mongoClient) {
    return mongoClient
  }

  const uri = process.env.MONGODB_URI
  if (!uri || uri.trim() === '') {
    console.warn('⚠️  MONGODB_URI not configured, MongoDB features will be unavailable')
    return null
  }

  // Validate URI format
  if (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) {
    console.error(`❌ Invalid MongoDB URI format. Must start with "mongodb://" or "mongodb+srv://"`)
    return null
  }

  try {
    mongoClient = new MongoClient(uri)
    await mongoClient.connect()
    console.log('✅ MongoDB client connected (shared connection pool)')
    return mongoClient
  } catch (error) {
    console.error('❌ MongoDB connection error:', error)
    return null
  }
}

/**
 * Get workspace-specific MongoDB database
 */
export async function getWorkspaceMongoDB(
  projectId: string
): Promise<Db | null> {
  const client = await getMongoClient()
  if (!client) {
    return null
  }

  const { mongodbDatabase } = getWorkspaceDatabaseNames(projectId)
  return client.db(mongodbDatabase)
}

/**
 * Get workspace-specific MongoDB collection
 */
export async function getWorkspaceMongoCollection<T extends Document = Document>(
  projectId: string,
  collectionName: string
): Promise<Collection<T> | null> {
  const db = await getWorkspaceMongoDB(projectId)
  if (!db) {
    return null
  }

  return db.collection<T>(collectionName)
}

/**
 * Get workspace-specific PostgreSQL Prisma client
 * 
 * Note: This returns a Prisma client configured to use the workspace's schema.
 * For now, we use raw queries with schema qualification.
 * In the future, we could create a Prisma client per workspace.
 */
export async function getWorkspacePostgresClient(projectId: string) {
  // Get workspace info
  const workspace = await prisma.workspace.findFirst({
    where: { projectId },
    select: {
      postgresSchema: true,
      databaseProvisioned: true,
    },
  })

  if (!workspace || !workspace.databaseProvisioned || !workspace.postgresSchema) {
    // Auto-provision if not already done
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    try {
      const sanitizedSchema = postgresSchema.replace(/"/g, '""') // Escape quotes
      await prisma.$executeRawUnsafe(
        `CREATE SCHEMA IF NOT EXISTS "${sanitizedSchema}"`
      )

      // A schema PostgREST has not been told about serves nothing: every table
      // in it answers PGRST106. `IF NOT EXISTS` also means the CREATE SCHEMA
      // event trigger may not fire here, so this path must ask explicitly.
      const { ensureSchemaRegistered } = await import('@/lib/postgrest/registration')
      await ensureSchemaRegistered(projectId)

      // Update workspace
      await prisma.workspace.updateMany({
        where: { projectId },
        data: {
          postgresSchema,
          databaseProvisioned: true,
          databaseProvisionedAt: new Date(),
        },
      })
    } catch (error) {
      console.error(`Failed to auto-provision PostgreSQL schema:`, error)
    }
  }

  const resolvedSchema = workspace?.postgresSchema || getWorkspaceDatabaseNames(projectId).postgresSchema

  // Return a wrapper that adds schema qualification to queries.
  // We set search_path inside each transaction so even if a query forgets
  // the {schema} placeholder, PostgreSQL resolves unqualified table names
  // to this tenant's schema — not public. Prevents cross-tenant leaks from app bugs.
  return {
    schema: resolvedSchema,
    executeRaw: async (query: string, ...params: any[]) => {
      const schemaQualifiedQuery = query.replace(/\{schema\}/g, `"${resolvedSchema}"`)
      return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${resolvedSchema}", public`)
        return tx.$executeRawUnsafe(schemaQualifiedQuery, ...params)
      })
    },
    queryRaw: async (query: string, ...params: any[]) => {
      const schemaQualifiedQuery = query.replace(/\{schema\}/g, `"${resolvedSchema}"`)
      return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${resolvedSchema}", public`)
        return tx.$queryRawUnsafe(schemaQualifiedQuery, ...params)
      })
    },
  }
}

/**
 * Execute a DML query in the workspace's PostgreSQL schema.
 * Uses the per-project connection pool with statement_timeout applied.
 */
export async function executeInWorkspaceSchema(
  projectId: string,
  query: string,
  ...params: any[]
): Promise<any> {
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
  const schemaQualifiedQuery = query.replace(/\{schema\}/g, `"${postgresSchema}"`)
  const { executeWorkspace } = await import('./workspace-pool')
  return executeWorkspace(projectId, schemaQualifiedQuery, params)
}

/**
 * Run a SELECT query in the workspace's PostgreSQL schema.
 * Uses the per-project connection pool with statement_timeout applied.
 */
export async function queryWorkspaceSchema(
  projectId: string,
  query: string,
  ...params: any[]
): Promise<any> {
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
  const schemaQualifiedQuery = query.replace(/\{schema\}/g, `"${postgresSchema}"`)
  const { queryWorkspace } = await import('./workspace-pool')
  return queryWorkspace(projectId, schemaQualifiedQuery, params)
}

/**
 * Cleanup: Close MongoDB client
 */
export async function closeMongoClient(): Promise<void> {
  if (mongoClient) {
    await mongoClient.close()
    mongoClient = null
    console.log('MongoDB client disconnected')
  }
}

// Graceful shutdown
if (typeof window === 'undefined') {
  process.on('SIGINT', async () => {
    await closeMongoClient()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await closeMongoClient()
    process.exit(0)
  })
}

