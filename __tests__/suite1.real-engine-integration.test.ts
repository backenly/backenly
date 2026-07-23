/**
 * SUITE 1: Real Engine Integration Test
 * 
 * TRUE deterministic validation of Backenly engine behavior.
 * 
 * NO MOCKS
 * NO FAKES  
 * NO SIMULATIONS
 * 
 * Real Prisma
 * Real orchestration
 * Real graph mutations
 * Real timeline persistence
 * Real undo/restore
 * Real database state assertions
 * 
 * RUNTIME TEST MODE: Requires ENGINE_MODE=runtime
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { PrismaClient } from '@prisma/client'
import { v4 as uuidv4 } from 'uuid'
import jwt from 'jsonwebtoken'

// Import REAL orchestration functions
import { orchestrateBackendChange } from '@/lib/orchestration'
import { getActiveGraph } from '@/lib/orchestration/graph-pointer'
import { undoToGraph, getPreviousGraphId } from '@/lib/orchestration/graph-pointer'

// Skip if not in runtime mode
if (process.env.ENGINE_MODE !== 'runtime') {
  describe.skip('SUITE 1: Real Engine Integration - Deterministic Backend Cognition (SKIPPED - requires ENGINE_MODE=runtime)', () => {
    it('placeholder', () => {})
  })
} else {

describe('SUITE 1: Real Engine Integration - Deterministic Backend Cognition', () => {
  let prisma: PrismaClient
  let testProjectId: string
  let testUserId: string
  let authToken: string
  
  // Setup real database connection
  beforeAll(async () => {
    prisma = new PrismaClient()
    
    // Create isolated test user
    const user = await prisma.user.create({
      data: {
        email: `test-${uuidv4()}@backenly.com`,
        name: 'Integration Test User',
        provider: 'test',
      },
    })
    
    testUserId = user.id
    
    // Create test project
    const project = await prisma.project.create({
      data: {
        name: 'Suite1-Integration-Test',
        slug: `suite1-integration-${uuidv4()}`,
        userId: testUserId,
      },
    })
    
    testProjectId = project.id
    
    // Create auth token
    authToken = jwt.sign(
      {
        userId: testUserId,
        email: user.email,
        name: user.name,
        projectId: testProjectId,
      },
      process.env.JWT_SECRET || 'your-secret-key-change-in-production',
      { expiresIn: '1h' }
    )
    
    // Create auth session
    await prisma.session.create({
      data: {
        userId: testUserId,
        token: authToken,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    
    console.log('🧪 Real Engine Integration Test Environment Ready')
    console.log('Project ID:', testProjectId)
    console.log('User ID:', testUserId)
  })
  
  // Cleanup after all tests
  afterAll(async () => {
    if (prisma) {
      // Clean up test data
      await prisma.session.deleteMany({
        where: { userId: testUserId }
      })
      
      await prisma.project.delete({
        where: { id: testProjectId }
      })
      
      await prisma.user.delete({
        where: { id: testUserId }
      })
      
      await prisma.$disconnect()
    }
  })
  
  // Clear graph history between tests for clean state
  beforeEach(async () => {
    // Delete all backend graphs for this project to ensure clean state
    await prisma.backendGraph.deleteMany({
      where: { projectId: testProjectId }
    })
    
    // Reset project activeGraphId
    await prisma.project.update({
      where: { id: testProjectId },
      data: { activeGraphId: null }
    })
  })

  /**
   * STEP 1: Create products table with name, price, description
   * Tests real field extraction, entity inference, and graph mutation
   */
  it('STEP 1: Create products table with real engine execution', async () => {
    console.log('\n🔄 STEP 1: Creating products table...')
    
    // Execute real orchestration
    const result = await orchestrateBackendChange(
      'Create a products table with name, price, description.',
      testProjectId
    )
    
    // Assert successful execution
    expect(result.success).toBe(true)
    expect(result.executionState).toBe('EXECUTED')
    
    // Get real graph state
    const activeGraph = await getActiveGraph(testProjectId)
    
    // Assert graph exists and has correct structure
    expect(activeGraph).toBeDefined()
    expect(activeGraph.version).toBeDefined()
    expect(activeGraph.sequenceNumber).toBe(1)
    
    // Assert products entity exists with correct fields
    expect(activeGraph.entities.products).toBeDefined()
    expect(activeGraph.entities.products.name).toBe('products')
    
    const productFields = Object.keys(activeGraph.entities.products.fields)
    expect(productFields).toEqual(
      expect.arrayContaining(['id', 'createdAt', 'updatedAt', 'name', 'price', 'description'])
    )
    
    // Assert field types and constraints
    const fields = activeGraph.entities.products.fields
    expect(fields.id.type).toBe('String')
    expect(fields.id.isPrimaryKey).toBe(true)
    expect(fields.createdAt.type).toBe('DateTime')
    expect(fields.updatedAt.type).toBe('DateTime')
    expect(fields.name.type).toBe('String')
    expect(fields.name.required).toBe(true)
    expect(fields.price.type).toBe('Float')
    expect(fields.price.required).toBe(true)
    expect(fields.description.type).toBe('String')
    expect(fields.description.required).toBe(false)
    
    // Assert default APIs created
    const apiKeys = Object.keys(activeGraph.apis)
    expect(apiKeys).toHaveLength(3)
    expect(activeGraph.apis['GET /api/products']).toBeDefined()
    expect(activeGraph.apis['GET /api/products/{id}']).toBeDefined()
    expect(activeGraph.apis['POST /api/products']).toBeDefined()
    
    // Verify in database
    const dbGraph = await prisma.backendGraph.findFirst({
      where: { 
        projectId: testProjectId,
        sequenceNumber: 1
      }
    })
    
    expect(dbGraph).toBeDefined()
    expect(dbGraph.sequenceNumber).toBe(1)
    
    console.log('✅ STEP 1 PASS: Real products table created with correct schema')
    console.log('   Fields:', productFields.join(', '))
    console.log('   APIs:', apiKeys.join(', '))
  })

  /**
   * STEP 2: Add stock and category fields
   * Tests incremental schema evolution
   */
  it('STEP 2: Add stock and category fields to products', async () => {
    console.log('\n🔄 STEP 2: Adding stock and category fields...')
    
    const result = await orchestrateBackendChange(
      'Add stock and category to products.',
      testProjectId
    )
    
    expect(result.success).toBe(true)
    
    const activeGraph = await getActiveGraph(testProjectId)
    expect(activeGraph.sequenceNumber).toBe(2)
    
    // Assert new fields exist
    const fields = activeGraph.entities.products.fields
    expect(fields.stock).toBeDefined()
    expect(fields.stock.type).toBe('Int')
    expect(fields.stock.required).toBe(true)
    
    expect(fields.category).toBeDefined()
    expect(fields.category.type).toBe('String')
    expect(fields.category.required).toBe(true)
    
    // Assert existing fields unchanged
    expect(fields.name).toBeDefined()
    expect(fields.price).toBeDefined()
    expect(fields.description).toBeDefined()
    
    // Total field count should be 8 (original 6 + 2 new)
    expect(Object.keys(fields)).toHaveLength(8)
    
    // APIs should remain unchanged
    expect(Object.keys(activeGraph.apis)).toHaveLength(3)
    
    console.log('✅ STEP 2 PASS: Stock and category fields added successfully')
    console.log('   Total fields:', Object.keys(fields).length)
  })

  /**
   * STEP 3: Undo last change
   * Tests real undo functionality and graph pointer manipulation
   */
  it('STEP 3: Undo last change - remove stock and category', async () => {
    console.log('\n🔄 STEP 3: Undoing last change...')
    
    // Get previous graph ID for undo
    const previousGraphId = await getPreviousGraphId(testProjectId)
    expect(previousGraphId).toBeDefined()
    
    // Execute real undo
    await undoToGraph(testProjectId, previousGraphId!)
    
    const activeGraph = await getActiveGraph(testProjectId)
    expect(activeGraph.sequenceNumber).toBe(1) // Back to version 1
    
    // Assert fields reverted
    const fields = activeGraph.entities.products.fields
    expect(fields.stock).toBeUndefined()
    expect(fields.category).toBeUndefined()
    
    // Assert original fields still present
    expect(fields.name).toBeDefined()
    expect(fields.price).toBeDefined()
    expect(fields.description).toBeDefined()
    
    // Total should be back to 6 fields
    expect(Object.keys(fields)).toHaveLength(6)
    
    console.log('✅ STEP 3 PASS: Undo successful - reverted to version 1')
    console.log('   Fields after undo:', Object.keys(fields).join(', '))
  })

  /**
   * STEP 4: Restore previous version
   * Tests version restoration and graph state recovery
   */
  it('STEP 4: Restore version 2 - bring back stock and category', async () => {
    console.log('\n🔄 STEP 4: Restoring version 2...')
    
    // First, we need to get to version 2 again
    await orchestrateBackendChange(
      'Add stock and category to products.',
      testProjectId
    )
    
    // Now undo to version 1
    const previousGraphId = await getPreviousGraphId(testProjectId)
    await undoToGraph(testProjectId, previousGraphId!)
    
    // Now restore to version 2 by finding the graph with sequence 2
    const version2Graph = await prisma.backendGraph.findFirst({
      where: {
        projectId: testProjectId,
        sequenceNumber: 2
      }
    })
    
    expect(version2Graph).toBeDefined()
    
    // Restore to version 2
    await undoToGraph(testProjectId, version2Graph!.id)
    
    const activeGraph = await getActiveGraph(testProjectId)
    expect(activeGraph.sequenceNumber).toBe(2)
    
    // Assert restored state
    const fields = activeGraph.entities.products.fields
    expect(fields.stock).toBeDefined()
    expect(fields.category).toBeDefined()
    expect(Object.keys(fields)).toHaveLength(8)
    
    console.log('✅ STEP 4 PASS: Version 2 restored successfully')
    console.log('   Fields restored:', Object.keys(fields).join(', '))
  })

  /**
   * STEPS 5-10: Advanced lifecycle with real engine
   */
  it('STEPS 5-10: Advanced lifecycle operations', async () => {
    console.log('\n🔄 STEPS 5-10: Advanced operations...')
    
    // Step 5: Add discount field
    await orchestrateBackendChange('Add discount field to products.', testProjectId)
    let activeGraph = await getActiveGraph(testProjectId)
    expect(activeGraph.entities.products.fields.discount).toBeDefined()
    expect(activeGraph.sequenceNumber).toBe(3)
    console.log('✅ STEP 5 PASS: Discount field added')
    
    // Step 6: Remove description field
    await orchestrateBackendChange('Remove description field from products.', testProjectId)
    activeGraph = await getActiveGraph(testProjectId)
    expect(activeGraph.entities.products.fields.description).toBeUndefined()
    expect(activeGraph.sequenceNumber).toBe(4)
    console.log('✅ STEP 6 PASS: Description field removed')
    
    // Step 7: Rename price to unitPrice
    await orchestrateBackendChange('Rename price field to unitPrice in products.', testProjectId)
    activeGraph = await getActiveGraph(testProjectId)
    expect(activeGraph.entities.products.fields.price).toBeUndefined()
    expect(activeGraph.entities.products.fields.unitPrice).toBeDefined()
    expect(activeGraph.sequenceNumber).toBe(5)
    console.log('✅ STEP 7 PASS: Price renamed to unitPrice')
    
    // Step 8: Undo twice
    let previousId = await getPreviousGraphId(testProjectId)
    await undoToGraph(testProjectId, previousId!)
    
    previousId = await getPreviousGraphId(testProjectId)
    await undoToGraph(testProjectId, previousId!)
    
    activeGraph = await getActiveGraph(testProjectId)
    expect(activeGraph.entities.products.fields.description).toBeDefined()
    expect(activeGraph.entities.products.fields.price).toBeDefined()
    expect(activeGraph.entities.products.fields.unitPrice).toBeUndefined()
    expect(activeGraph.sequenceNumber).toBe(3)
    console.log('✅ STEP 8 PASS: Double undo successful')
    
    // Step 9: Restore to version 2
    const version2Graph = await prisma.backendGraph.findFirst({
      where: {
        projectId: testProjectId,
        sequenceNumber: 2
      }
    })
    
    await undoToGraph(testProjectId, version2Graph!.id)
    
    activeGraph = await getActiveGraph(testProjectId)
    expect(activeGraph.sequenceNumber).toBe(2)
    expect(activeGraph.entities.products.fields.stock).toBeDefined()
    expect(activeGraph.entities.products.fields.category).toBeDefined()
    console.log('✅ STEP 9 PASS: Restored to version 2')
    
    // Step 10: Final consistency check
    const finalGraph = await getActiveGraph(testProjectId)
    
    // Get timeline from database
    const timelineEntries = await prisma.backendGraph.findMany({
      where: { projectId: testProjectId },
      orderBy: { sequenceNumber: 'asc' }
    })
    
    // Assert graph consistency
    expect(finalGraph.version).toBeDefined()
    expect(Object.keys(finalGraph.entities).length).toBeGreaterThan(0)
    expect(finalGraph.sequenceNumber).toBe(2)
    
    // Assert timeline consistency
    expect(timelineEntries.length).toBe(2)
    expect(timelineEntries[0].sequenceNumber).toBe(1)
    expect(timelineEntries[1].sequenceNumber).toBe(2)
    
    console.log('✅ STEP 10 PASS: Final consistency verified')
    console.log('   Timeline entries:', timelineEntries.length)
    console.log('   Current sequence:', finalGraph.sequenceNumber)
    console.log('🎉 SUITE 1 COMPLETE: All real engine tests passed')
  })

  /**
   * Immutability verification
   * Tests that previous graph versions are truly immutable
   */
  it('IMMUTABILITY: Previous snapshots remain unchanged', async () => {
    console.log('\n🔄 VERIFYING IMMUTABILITY...')
    
    // Get all graph versions
    const allVersions = await prisma.backendGraph.findMany({
      where: { projectId: testProjectId },
      orderBy: { sequenceNumber: 'asc' }
    })
    
    expect(allVersions.length).toBeGreaterThanOrEqual(2)
    
    // Verify each version maintains its integrity
    for (let i = 0; i < allVersions.length; i++) {
      const version = allVersions[i]
      
      // Parse graph data
      const graphData = version.graphData as any
      
      // Verify structural integrity
      expect(graphData.version).toBeDefined()
      expect(graphData.entities).toBeDefined()
      
      if (version.sequenceNumber === 1) {
        // Version 1 should have original 6 fields
        const productFields = Object.keys(graphData.entities.products.fields)
        expect(productFields).toHaveLength(6)
        expect(productFields).toEqual(
          expect.arrayContaining(['id', 'createdAt', 'updatedAt', 'name', 'price', 'description'])
        )
      } else if (version.sequenceNumber === 2) {
        // Version 2 should have 8 fields (original + stock + category)
        const productFields = Object.keys(graphData.entities.products.fields)
        expect(productFields).toHaveLength(8)
        expect(productFields).toEqual(
          expect.arrayContaining(['id', 'createdAt', 'updatedAt', 'name', 'price', 'description', 'stock', 'category'])
        )
      }
    }
    
    console.log('✅ IMMUTABILITY VERIFIED: All snapshots maintain integrity')
    console.log('   Total versions:', allVersions.length)
  })
})

} // End runtime mode check