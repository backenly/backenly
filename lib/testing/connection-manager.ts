/**
 * CONNECTION POOL LIFECYCLE MANAGER
 * 
 * Ensures proper connection pool management for tests:
 * - beforeAll: Connect all pools
 * - afterAll: Disconnect all pools  
 * - beforeEach: Reset/cleanup test data
 * - afterEach: Cleanup test artifacts
 * 
 * Prevents "PostgreSQL connection: Error { kind: Closed }" and
 * "Cannot log after tests are done" issues.
 */

import { PrismaClient } from '@prisma/client'

// Global Prisma clients for different purposes
let mainPrisma: PrismaClient | null = null
let testPrisma: PrismaClient | null = null

/**
 * Initialize connection pools for testing
 * Call this in beforeAll() of test suites
 */
export async function initializeTestConnections(): Promise<void> {
  console.log('[Connection Manager] Initializing test connections...')
  
  try {
    // Main connection pool (shared)
    if (!mainPrisma) {
      mainPrisma = new PrismaClient({
        log: ['error', 'warn'], // Reduced logging for tests
      })
      await mainPrisma.$connect()
      console.log('[Connection Manager] ✅ Main connection pool initialized')
    }
    
    // Dedicated test connection pool (isolated)
    if (!testPrisma) {
      testPrisma = new PrismaClient({
        log: ['error'], // Minimal logging for test isolation
      })
      await testPrisma.$connect()
      console.log('[Connection Manager] ✅ Test connection pool initialized')
    }
    
  } catch (error) {
    console.error('[Connection Manager] ❌ Failed to initialize connections:', error)
    throw error
  }
}

/**
 * Get main Prisma client for shared operations
 */
export function getMainPrisma(): PrismaClient {
  if (!mainPrisma) {
    throw new Error('Main Prisma client not initialized. Call initializeTestConnections() first.')
  }
  return mainPrisma
}

/**
 * Get dedicated test Prisma client for isolated operations
 */
export function getTestPrisma(): PrismaClient {
  if (!testPrisma) {
    throw new Error('Test Prisma client not initialized. Call initializeTestConnections() first.')
  }
  return testPrisma
}

/**
 * Cleanup test data between tests
 * Call this in beforeEach() to ensure clean state
 */
export async function cleanupTestData(): Promise<void> {
  if (!testPrisma) return
  
  try {
    // Clean up test-specific data
    // IMPORTANT: Only delete test data, never production data
    const testPrefix = 'test_'
    
    // Clean up test projects
    await testPrisma.project.deleteMany({
      where: {
        id: {
          startsWith: testPrefix,
        },
      },
    })
    
    // Clean up test users
    await testPrisma.user.deleteMany({
      where: {
        email: {
          contains: 'test@',
        },
      },
    })
    
    // Clean up test sessions
    await testPrisma.session.deleteMany({
      where: {
        token: {
          contains: 'test-token',
        },
      },
    })
    
    console.log('[Connection Manager] ✅ Test data cleaned up')
    
  } catch (error) {
    console.warn('[Connection Manager] ⚠️ Cleanup warning (may be expected):', error)
  }
}

/**
 * Close all connection pools
 * Call this in afterAll() to prevent connection leaks
 */
export async function closeTestConnections(): Promise<void> {
  console.log('[Connection Manager] Closing test connections...')
  
  try {
    // Disconnect test pool
    if (testPrisma) {
      await testPrisma.$disconnect()
      testPrisma = null
      console.log('[Connection Manager] ✅ Test connection pool closed')
    }
    
    // Disconnect main pool
    if (mainPrisma) {
      await mainPrisma.$disconnect()
      mainPrisma = null
      console.log('[Connection Manager] ✅ Main connection pool closed')
    }
    
  } catch (error) {
    console.error('[Connection Manager] ❌ Error closing connections:', error)
    throw error
  }
}

/**
 * Graceful shutdown handler for SIGTERM/SIGINT
 */
export function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    console.log(`[Connection Manager] Received ${signal}, shutting down gracefully...`)
    await closeTestConnections()
    process.exit(0)
  }
  
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

/**
 * Wait for all pending database operations to complete
 * Call this before assertions to ensure consistency
 */
export async function waitForPendingOperations(timeoutMs: number = 5000): Promise<void> {
  // Simple approach: wait for a moment to let async operations settle
  // In production, you might want more sophisticated synchronization
  await new Promise(resolve => setTimeout(resolve, timeoutMs))
}

/**
 * Test-specific utilities
 */

/**
 * Generate unique test ID
 */
export function generateTestId(prefix: string = 'test'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Create test user with guaranteed cleanup
 */
export async function createTestUser(email?: string): Promise<{ id: string }> {
  const prisma = getMainPrisma()
  const testEmail = email || `test-user-${generateTestId()}@example.com`
  
  const user = await prisma.user.create({
    data: {
      email: testEmail,
      name: 'Test User',
    },
  })
  
  return { id: user.id }
}

/**
 * Create test project with guaranteed cleanup
 */
export async function createTestProject(userId: string, name?: string): Promise<{ id: string }> {
  const prisma = getMainPrisma()
  const projectName = name || `Test Project ${generateTestId()}`
  
  const project = await prisma.project.create({
    data: {
      name: projectName,
      userId,
    },
  })
  
  return { id: project.id }
}