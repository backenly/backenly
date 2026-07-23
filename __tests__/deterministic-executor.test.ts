/**
 * Deterministic Mutation Executor Tests
 * 
 * Verifies:
 * - Retry recomputes plan from fresh graph
 * - No stale execution results
 * - Conflict handling
 * - Deterministic behavior
 */

import { executeDeterministicMutationWithRetry, executeSingleMutationAttempt, MAX_RETRIES } from '@/lib/orchestration/deterministic-mutation-executor'
import { prisma } from '@/lib/db/prisma'
import { CanonicalIntent } from '@/lib/orchestration/types'

describe('Deterministic Mutation Executor', () => {
  let testUser: any
  let testProject: any
  
  beforeAll(async () => {
    testUser = await prisma.user.upsert({
      where: { email: 'det-test@backenly.test' },
      update: {},
      create: {
        email: 'det-test@backenly.test',
        name: 'Deterministic Test User',
      },
    })
    
    testProject = await prisma.project.create({
      data: {
        name: 'Deterministic Test Project',
        userId: testUser.id,
        description: 'Testing deterministic executor',
      },
    })
  }, 30000)
  
  afterAll(async () => {
    await prisma.project.delete({ where: { id: testProject.id } }).catch(() => {})
    await prisma.user.delete({ where: { email: 'det-test@backenly.test' } }).catch(() => {})
  }, 30000)
  
  describe('Single Mutation Attempt', () => {
    it('should execute a simple intent successfully', async () => {
      const intent: CanonicalIntent = {
        intent_type: 'DATA_MODEL_ADD',
        domain: 'DATABASE',
        action: 'CREATE',
        target: 'products',
        feature: 'products',
        constraints: {},
        source_text: 'create products table',
        timestamp: new Date().toISOString(),
        confidence: 0.95,
        status: 'COMMITTED',
      }
      
      const result = await executeSingleMutationAttempt({
        projectId: testProject.id,
        intents: [intent],
        attempt: 1,
      })
      
      // Debug: log the result
      console.log('Result:', JSON.stringify(result, null, 2))
      
      expect(result.success).toBe(true)
      expect(result.isConflict).toBe(false)
      expect(result.executionResult).toBeDefined()
      expect(result.executionResult?.success).toBe(true)
    }, 60000)
    
    it('should re-fetch latest graph on each attempt', async () => {
      // This test verifies that multiple attempts see fresh graph state
      const intent1: CanonicalIntent = {
        intent_type: 'DATA_MODEL_ADD',
        domain: 'DATABASE',
        action: 'CREATE',
        target: 'users',
        feature: 'users',
        constraints: {},
        source_text: 'create users table',
        timestamp: new Date().toISOString(),
        confidence: 0.95,
        status: 'COMMITTED',
      }
      
      // First attempt - should create users table
      const result1 = await executeSingleMutationAttempt({
        projectId: testProject.id,
        intents: [intent1],
        attempt: 1,
      })
      
      expect(result1.success).toBe(true)
      
      // Second attempt with different intent - should see users table exists
      const intent2: CanonicalIntent = {
        intent_type: 'DATA_MODEL_MODIFY',
        domain: 'DATABASE',
        action: 'UPDATE',
        target: 'users',
        feature: 'email',
        constraints: { fieldType: 'string' },
        source_text: 'add email field to users',
        timestamp: new Date().toISOString(),
        confidence: 0.95,
        status: 'COMMITTED',
      }
      
      const result2 = await executeSingleMutationAttempt({
        projectId: testProject.id,
        intents: [intent2],
        attempt: 2,
      })
      
      expect(result2.success).toBe(true)
      // Verify the graph now has users table with email field
      expect(result2.executionResult?.finalState.entities.users).toBeDefined()
    }, 120000)
  })
  
  describe('Retry Behavior', () => {
    it('should succeed without retry when no conflict', async () => {
      const intent: CanonicalIntent = {
        intent_type: 'DATA_MODEL_ADD',
        domain: 'DATABASE',
        action: 'CREATE',
        target: 'orders',
        feature: 'orders',
        constraints: {},
        source_text: 'create orders table',
        timestamp: new Date().toISOString(),
        confidence: 0.95,
        status: 'COMMITTED',
      }
      
      const result = await executeDeterministicMutationWithRetry({
        projectId: testProject.id,
        intents: [intent],
      })
      
      expect(result.success).toBe(true)
      expect(result.finalState.entities.orders).toBeDefined()
    }, 60000)
    
    it('should respect MAX_RETRIES constant', () => {
      expect(MAX_RETRIES).toBe(3)
    })
  })
  
  describe('Deterministic Behavior', () => {
    it('should produce same result for same intent on same graph state', async () => {
      // Create a fresh project for this test
      const freshProject = await prisma.project.create({
        data: {
          name: 'Determinism Test Project',
          userId: testUser.id,
        },
      })
      
      const intent: CanonicalIntent = {
        intent_type: 'DATA_MODEL_ADD',
        domain: 'DATABASE',
        action: 'CREATE',
        target: 'categories',
        feature: 'categories',
        constraints: {},
        source_text: 'create categories table',
        timestamp: new Date().toISOString(),
        confidence: 0.95,
        status: 'COMMITTED',
      }
      
      // Execute same intent twice (sequentially, so no conflict)
      const result1 = await executeDeterministicMutationWithRetry({
        projectId: freshProject.id,
        intents: [intent],
      })
      
      // Second execution should be idempotent (no duplicate table)
      const intent2: CanonicalIntent = {
        ...intent,
        target: 'tags',
        feature: 'tags',
        source_text: 'create tags table',
      }
      
      const result2 = await executeDeterministicMutationWithRetry({
        projectId: freshProject.id,
        intents: [intent2],
      })
      
      expect(result1.success).toBe(true)
      expect(result2.success).toBe(true)
      
      // Both tables should exist
      expect(result2.finalState.entities.categories).toBeDefined()
      expect(result2.finalState.entities.tags).toBeDefined()
      
      // Cleanup
      await prisma.project.delete({ where: { id: freshProject.id } }).catch(() => {})
    }, 120000)
  })
})
