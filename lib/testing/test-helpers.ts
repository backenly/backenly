/**
 * EXAMPLE TEST SUITE WITH PROPER CONNECTION LIFECYCLE
 * 
 * Demonstrates correct usage of connection-manager.ts
 * 
 * Usage pattern:
 * 
 * describe('My Integration Tests', () => {
 *   beforeAll(async () => {
 *     await initializeTestConnections()
 *   })
 *   
 *   afterAll(async () => {
 *     await closeTestConnections()
 *   })
 *   
 *   beforeEach(async () => {
 *     await cleanupTestData()
 *   })
 *   
 *   test('should do something', async () => {
 *     const prisma = getMainPrisma()
 *     // ... test code
 *   })
 * })
 */

import { 
  initializeTestConnections, 
  closeTestConnections, 
  cleanupTestData,
  getMainPrisma,
  getTestPrisma,
  createTestUser,
  createTestProject,
  waitForPendingOperations
} from './connection-manager'

/**
 * Example test suite demonstrating proper lifecycle management
 */
export function createProperTestSuite(suiteName: string, tests: () => void) {
  describe(suiteName, () => {
    // Setup connection pools once for entire suite
    beforeAll(async () => {
      console.log(`\n🧪 Setting up test suite: ${suiteName}`)
      await initializeTestConnections()
    })
    
    // Cleanup connection pools after suite completes
    afterAll(async () => {
      console.log(`\n🧹 Cleaning up test suite: ${suiteName}`)
      await closeTestConnections()
    })
    
    // Clean up test data before each test
    beforeEach(async () => {
      await cleanupTestData()
      // Give a small delay for any async cleanup to complete
      await waitForPendingOperations(100)
    })
    
    // Run the actual tests
    tests()
  })
}

/**
 * Wrapper for individual tests with proper error handling
 */
export function testWithLifecycle(testName: string, testFn: () => Promise<void>) {
  test(testName, async () => {
    try {
      await testFn()
    } catch (error) {
      // Log error but re-throw to fail the test
      console.error(`\n❌ Test "${testName}" failed:`, error)
      throw error
    } finally {
      // Ensure cleanup even if test fails
      await waitForPendingOperations(50)
    }
  })
}

/**
 * Example of how to convert existing tests to use proper lifecycle
 */
export async function exampleConvertedTest() {
  // Get connection pool
  const prisma = getMainPrisma()
  
  // Create test data
  const user = await createTestUser()
  const project = await createTestProject(user.id)
  
  // Perform test operations
  const result = await prisma.project.findUnique({
    where: { id: project.id }
  })
  
  // Assertions
  expect(result).toBeTruthy()
  expect(result?.name).toContain('Test Project')
  
  // Cleanup happens automatically in afterEach via cleanupTestData()
}

/**
 * Utility to create isolated test environments
 */
export async function withTestEnvironment<T>(
  testFn: (context: { 
    prisma: typeof getMainPrisma,
    createTestUser: typeof createTestUser,
    createTestProject: typeof createTestProject
  }) => Promise<T>
): Promise<T> {
  // Get isolated connection
  const prisma = getTestPrisma()
  
  return await testFn({
    prisma: () => prisma,
    createTestUser,
    createTestProject
  })
}