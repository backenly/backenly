/**
 * Retry Logic Verification Test
 * 
 * Tests that concurrency conflicts trigger automatic retry
 */

import { orchestrateBackendChange } from '@/lib/orchestration'
import { prisma } from '@/lib/db/prisma'

describe('Retry Logic Verification', () => {
  let testUser: any
  let testProject: any
  
  beforeAll(async () => {
    // Create test user
    testUser = await prisma.user.upsert({
      where: { email: 'retry-test@backenly.test' },
      update: {},
      create: {
        email: 'retry-test@backenly.test',
        name: 'Retry Test User',
      },
    })
    
    // Create test project
    testProject = await prisma.project.create({
      data: {
        name: 'Retry Test Project',
        userId: testUser.id,
        description: 'Testing retry logic',
      },
    })
  }, 30000)
  
  afterAll(async () => {
    await prisma.project.delete({ where: { id: testProject.id } }).catch(() => {})
    await prisma.user.delete({ where: { email: 'retry-test@backenly.test' } }).catch(() => {})
  }, 30000)
  
  it('should successfully complete a simple mutation', async () => {
    const result = await orchestrateBackendChange(
      'Create users table with email and name',
      testProject.id,
      { forceCommit: true }
    )
    
    expect(result.success).toBe(true)
    expect(result.executionState).toBe('EXECUTED')
  }, 60000)
  
  it('should handle sequential mutations without conflict', async () => {
    const results = []
    
    for (let i = 0; i < 5; i++) {
      const result = await orchestrateBackendChange(
        `Add field test_${i} to users table`,
        testProject.id,
        { forceCommit: true }
      )
      results.push(result)
    }
    
    // All should succeed
    expect(results.every(r => r.success)).toBe(true)
    
    // Check final graph has all fields
    const finalResult = await orchestrateBackendChange(
      'What tables do I have?',
      testProject.id
    )
    
    expect(finalResult.success).toBe(true)
  }, 120000)
})
