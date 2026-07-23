/**
 * MongoDB Connection Module
 * 
 * ARCHITECTURAL DECISION:
 * MongoDB is OPTIONAL and INVISIBLE to end users.
 * 
 * - PostgreSQL = user-visible database (tables, schemas, data)
 * - MongoDB = internal platform intelligence (optional)
 *   - AI prompt history
 *   - Execution traces
 *   - Debug logs
 *   - Analytics events
 * 
 * Users should NEVER:
 * - See MongoDB in the UI
 * - Choose between Postgres/Mongo
 * - Configure MongoDB manually
 * 
 * MongoDB benefits users silently through:
 * - Automatic logging
 * - AI memory
 * - Execution history
 * 
 * If MONGODB_URI is not set, the platform works fine with Postgres only.
 */

import { MongoClient, Db, Collection, Document } from 'mongodb'
import { getMongoClient, getWorkspaceMongoDB, getWorkspaceMongoCollection } from '@/lib/services/workspaceDatabase'

// Legacy support: Keep old functions for backward compatibility
// But they now use the platform database (backenly_platform)
let legacyDb: Db | null = null

// Validate MongoDB URI format
function getMongoDBURI(): string | null {
  const uri = process.env.MONGODB_URI
  if (!uri || uri.trim() === '') {
    return null // Return null if not set (optional)
  }
  
  // Check if URI starts with valid scheme
  if (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) {
    console.error(`❌ Invalid MongoDB URI format. Must start with "mongodb://" or "mongodb+srv://". Got: ${uri.substring(0, 50)}...`)
    return null
  }
  
  return uri
}

const MONGODB_URI = getMongoDBURI()
const DB_NAME = process.env.MONGODB_DB_NAME || 'backenly_platform'

// Legacy singleton pattern for MongoDB connection (platform database)
// For workspace-specific databases, use getWorkspaceMongoDB() instead
export async function connectMongoDB(): Promise<Db> {
  if (legacyDb) {
    return legacyDb
  }

  if (!MONGODB_URI) {
    throw new Error('MongoDB URI is not configured. Set MONGODB_URI in your .env file.')
  }

  try {
    const client = await getMongoClient()
    if (!client) {
      throw new Error('Failed to get MongoDB client')
    }
    legacyDb = client.db(DB_NAME)
    console.log(`✅ MongoDB connected successfully (platform database: ${DB_NAME})`)
    return legacyDb
  } catch (error) {
    console.error('❌ MongoDB connection error:', error)
    throw error
  }
}

export async function getMongoDB(): Promise<Db> {
  if (!legacyDb) {
    return await connectMongoDB()
  }
  return legacyDb
}

export async function getCollection<T extends Document = Document>(collectionName: string): Promise<Collection<T>> {
  const database = await getMongoDB()
  return database.collection<T>(collectionName)
}

// Export workspace-specific functions for use in workspace routes
export { getWorkspaceMongoDB, getWorkspaceMongoCollection }

// Helper function to test connection
export async function testMongoConnection(): Promise<boolean> {
  // If MongoDB URI is not configured, skip connection (optional service)
  if (!MONGODB_URI) {
    console.log('ℹ️  MongoDB URI not configured, skipping connection test')
    return false
  }
  
  try {
    const database = await connectMongoDB()
    await database.admin().ping()
    return true
  } catch (error) {
    console.error('MongoDB connection error:', error)
    return false
  }
}

// Helper function to disconnect
export async function disconnectMongoDB(): Promise<void> {
  const { closeMongoClient } = await import('@/lib/services/workspaceDatabase')
  await closeMongoClient()
  legacyDb = null
  console.log('MongoDB disconnected')
}

// Graceful shutdown
if (typeof window === 'undefined') {
  process.on('SIGINT', async () => {
    await disconnectMongoDB()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await disconnectMongoDB()
    process.exit(0)
  })
}

