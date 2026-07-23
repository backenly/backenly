// Import functions first
import { testPostgresConnection as testPostgres } from './postgres'
import { testMongoConnection as testMongo } from './mongodb'

// Re-export everything for external use
export { prisma, testPostgresConnection, disconnectPostgres } from './postgres'
export { 
  connectMongoDB, 
  getMongoDB, 
  getCollection, 
  testMongoConnection, 
  disconnectMongoDB 
} from './mongodb'

// Physical database isolation (production-grade)
export {
  provisionIsolatedDatabase,
  getIsolatedPrismaClient,
  deprovisionIsolatedDatabase,
  verifyDatabaseIsolation,
  type IsolatedDatabaseConfig,
  type ProvisionedDatabase,
} from './isolated-database-manager'

// Initialize connections on import (for Next.js API routes)
export async function initializeDatabases() {
  const results = {
    postgres: false,
    mongodb: false,
  }

  try {
    results.postgres = await testPostgres()
  } catch (error) {
    console.error('Failed to initialize PostgreSQL:', error)
  }

  try {
    results.mongodb = await testMongo()
  } catch (error) {
    console.error('Failed to initialize MongoDB:', error)
  }

  return results
}

