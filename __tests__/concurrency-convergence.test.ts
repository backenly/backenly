/**
 * Concurrency Convergence Test
 * 
 * PROVES: State converges correctly under real contention
 * 
 * Requirements:
 * - Runs against real database (not integration mode)
 * - Forces actual optimistic locking conflicts
 * - Verifies no mutations are lost
 * - Measures retry behavior
 */

// Needs a REAL database, not integration mode.
//
// This used to hardcode postgresql://postgres:pass@localhost:5432/nexa and
// overwrite DATABASE_URL with it. `nexa` is the pre-rename database name, so
// the suite asked for a database that exists in no environment and failed with
// PrismaClientInitializationError everywhere, which read as "needs a database"
// when it actually needed one specific dead one (#7). It now uses whatever
// TEST_DATABASE_URL points at, like every other database-backed suite.
process.env.ENGINE_MODE = 'production'

import { executeDeterministicMutationWithRetry } from '@/lib/orchestration/deterministic-mutation-executor'
import { getActiveGraph } from '@/lib/orchestration/graph-pointer'
import { PrismaClient } from '@prisma/client'
import { CanonicalIntent } from '@/lib/orchestration/types'

const TEST_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
if (!TEST_DB_URL) {
  throw new Error('concurrency-convergence needs TEST_DATABASE_URL or DATABASE_URL')
}

const prisma = new PrismaClient({
  datasources: { db: { url: TEST_DB_URL } },
})

// Test configuration
const CONCURRENT_MUTATIONS = 10
const TEST_PROJECT_PREFIX = 'concurrency-test-'

interface ConcurrencyMetrics {
  totalAttempts: number
  totalConflicts: number
  totalRetries: number
  maxRetryDepth: number
  finalFieldCount: number
  expectedFieldCount: number
  convergenceSuccess: boolean
}

describe('CONCURRENCY CONVERGENCE TEST', () => {
  // Skip if in integration mode (needs real DB)
  const isIntegrationMode = process.env.ENGINE_MODE === 'integration'
  
  // eslint-disable-next-line jest/no-disabled-tests
  const describeOrSkip = isIntegrationMode ? describe.skip : describe
  
  describeOrSkip('Real Database Concurrency', () => {
    let testUser: any
    let testProject: any
    let metrics: ConcurrencyMetrics
    
    beforeAll(async () => {
      // Create test user
      testUser = await prisma.user.upsert({
        where: { email: 'convergence-test@backenly.test' },
        update: {},
        create: {
          email: 'convergence-test@backenly.test',
          name: 'Concurrency Test User',
        },
      })
      
      // Create test project
      testProject = await prisma.project.create({
        data: {
          name: `${TEST_PROJECT_PREFIX}${Date.now()}`,
          userId: testUser.id,
          description: 'Testing concurrent field additions',
        },
      })
      
      // Initialize empty graph
      const { createEmptyGraph } = await import('@/lib/orchestration/backend-state-graph')
      const { createInitialGraph, getActiveGraph } = await import('@/lib/orchestration/graph-pointer')
      
      const emptyGraph = createEmptyGraph(testProject.id)
      await createInitialGraph(testProject.id, emptyGraph)
      
      // Verify initial state
      const initialGraph = await getActiveGraph(testProject.id)
      expect(initialGraph).toBeDefined()
      expect(Object.keys(initialGraph!.entities)).toHaveLength(0)
      
      metrics = {
        totalAttempts: 0,
        totalConflicts: 0,
        totalRetries: 0,
        maxRetryDepth: 0,
        finalFieldCount: 0,
        expectedFieldCount: CONCURRENT_MUTATIONS,
        convergenceSuccess: false,
      }
    }, 60000)
    
    afterAll(async () => {
      // Cleanup
      if (testProject) {
        await prisma.project.delete({ where: { id: testProject.id } }).catch(() => {})
      }
      await prisma.user.delete({ where: { email: 'convergence-test@backenly.test' } }).catch(() => {})
    }, 60000)
    
    it('should converge to correct state under concurrent field additions', async () => {
      // Create intents for concurrent field additions
      const intents: CanonicalIntent[] = Array.from({ length: CONCURRENT_MUTATIONS }, (_, i) => ({
        intent_type: 'DATA_MODEL_ADD',
        domain: 'DATABASE',
        action: 'CREATE',
        target: 'users',
        feature: 'users',
        constraints: {
          fields: [
            { name: `field_${i}`, type: 'string' }
          ]
        },
        source_text: `create users table with field_${i}`,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
        status: 'COMMITTED' as const,
      }))
      
      console.log(`\n[Concurrency Test] Starting ${CONCURRENT_MUTATIONS} concurrent mutations...`)
      
      // Execute all mutations concurrently
      const startTime = Date.now()
      
      const results = await Promise.allSettled(
        intents.map((intent, index) => 
          executeDeterministicMutationWithRetry({
            projectId: testProject.id,
            intents: [intent],
          }).then(result => {
            console.log(`[Mutation ${index}] Completed: ${result.success}`)
            return { index, result, success: true }
          }).catch(error => {
            console.log(`[Mutation ${index}] Failed: ${error.message}`)
            return { index, error: error.message, success: false }
          })
        )
      )
      
      const duration = Date.now() - startTime
      
      // Analyze results
      const successful = results.filter(r => r.status === 'fulfilled' && (r.value as any).success)
      const failed = results.filter(r => r.status === 'rejected' || !(r.value as any).success)
      
      console.log(`\n[Concurrency Test] Results:`)
      console.log(`  Duration: ${duration}ms`)
      console.log(`  Successful: ${successful.length}/${CONCURRENT_MUTATIONS}`)
      console.log(`  Failed: ${failed.length}/${CONCURRENT_MUTATIONS}`)
      
      // All mutations should succeed (retry handles conflicts)
      expect(successful.length).toBe(CONCURRENT_MUTATIONS)
      expect(failed.length).toBe(0)
      
      // Verify final graph state
      const finalGraph = await getActiveGraph(testProject.id)
      expect(finalGraph).toBeDefined()
      
      console.log(`\n[Concurrency Test] Final graph state:`)
      console.log(`  Entities: ${Object.keys(finalGraph!.entities).join(', ')}`)
      
      // Check users table exists
      expect(finalGraph!.entities.users).toBeDefined()
      
      // Check all fields exist
      const usersFields = Object.keys(finalGraph!.entities.users.fields || {})
      console.log(`  Users fields: ${usersFields.join(', ')}`)
      
      // Verify all concurrent fields are present
      for (let i = 0; i < CONCURRENT_MUTATIONS; i++) {
        const fieldName = `field_${i}`
        expect(usersFields).toContain(fieldName)
      }
      
      // Verify no duplicate fields
      const uniqueFields = new Set(usersFields)
      expect(uniqueFields.size).toBe(usersFields.length)
      
      metrics.finalFieldCount = usersFields.length
      metrics.convergenceSuccess = true
      
      console.log(`\n[Concurrency Test] ✅ CONVERGENCE VERIFIED`)
      console.log(`  Expected fields: ${CONCURRENT_MUTATIONS}`)
      console.log(`  Actual fields: ${usersFields.length}`)
      console.log(`  All fields present: ${metrics.convergenceSuccess}`)
      
    }, 300000) // 5 minute timeout
    
    it('should handle idempotent mutations correctly', async () => {
      // Create a fresh project
      const idempotentProject = await prisma.project.create({
        data: {
          name: `${TEST_PROJECT_PREFIX}idempotent-${Date.now()}`,
          userId: testUser.id,
        },
      })
      
      // Initialize graph
      const { createEmptyGraph } = await import('@/lib/orchestration/backend-state-graph')
      const { createInitialGraph } = await import('@/lib/orchestration/graph-pointer')
      const emptyGraph = createEmptyGraph(idempotentProject.id)
      await createInitialGraph(idempotentProject.id, emptyGraph)
      
      // Same intent executed multiple times concurrently
      const intent: CanonicalIntent = {
        intent_type: 'DATA_MODEL_ADD',
        domain: 'DATABASE',
        action: 'CREATE',
        target: 'products',
        feature: 'products',
        constraints: {
          fields: [
            { name: 'name', type: 'string' },
            { name: 'price', type: 'number' }
          ]
        },
        source_text: 'create products table with name and price',
        timestamp: new Date().toISOString(),
        confidence: 0.95,
        status: 'COMMITTED' as const,
      }
      
      // Execute same intent 5 times concurrently
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          executeDeterministicMutationWithRetry({
            projectId: idempotentProject.id,
            intents: [intent],
          })
        )
      )
      
      // All should succeed (idempotent behavior)
      const successful = results.filter(r => r.status === 'fulfilled')
      expect(successful.length).toBe(5)
      
      // Verify final state has exactly one products table with correct fields
      const finalGraph = await getActiveGraph(idempotentProject.id)
      expect(finalGraph!.entities.products).toBeDefined()
      
      const productFields = Object.keys(finalGraph!.entities.products.fields || {})
      expect(productFields).toContain('name')
      expect(productFields).toContain('price')
      
      // No duplicate fields
      const uniqueFields = new Set(productFields)
      expect(uniqueFields.size).toBe(productFields.length)
      
      // Cleanup
      await prisma.project.delete({ where: { id: idempotentProject.id } }).catch(() => {})
      
    }, 120000)
  })
  
  describe('Integration Mode Concurrency (Smoke Test)', () => {
    // This runs in integration mode to verify basic functionality
    // Note: Integration mode uses in-memory store, so conflicts won't happen
    // This is just a smoke test that the executor works
    
    it('should execute mutations in integration mode', async () => {
      if (!isIntegrationMode) {
        console.log('[Skip] Not in integration mode')
        return
      }
      
      const testUser = await prisma.user.upsert({
        where: { email: 'integration-concurrency@backenly.test' },
        update: {},
        create: {
          email: 'integration-concurrency@backenly.test',
          name: 'Integration Test User',
        },
      })
      
      const testProject = await prisma.project.create({
        data: {
          name: 'integration-concurrency-test',
          userId: testUser.id,
        },
      })
      
      const intent: CanonicalIntent = {
        intent_type: 'DATA_MODEL_ADD',
        domain: 'DATABASE',
        action: 'CREATE',
        target: 'test_table',
        feature: 'test_table',
        constraints: {},
        source_text: 'create test table',
        timestamp: new Date().toISOString(),
        confidence: 0.95,
        status: 'COMMITTED' as const,
      }
      
      const result = await executeDeterministicMutationWithRetry({
        projectId: testProject.id,
        intents: [intent],
      })
      
      expect(result.success).toBe(true)
      
      // Cleanup
      await prisma.project.delete({ where: { id: testProject.id } }).catch(() => {})
      await prisma.user.delete({ where: { email: 'integration-concurrency@backenly.test' } }).catch(() => {})
      
    }, 60000)
  })
})
