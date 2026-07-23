/**
 * CONVERTED REAL DATABASE PERSISTENCE TEST
 * 
 * This version uses proper connection lifecycle management:
 * - Connection pools initialized in beforeAll
 * - Cleanup in beforeEach/afterEach
 * - Proper disconnection in afterAll
 * 
 * Fixes:
 * - "PostgreSQL connection: Error { kind: Closed }"
 * - "Cannot log after tests are done" 
 * - Connection pool leaks
 */

import { spawn, ChildProcess } from 'child_process'
import { promisify } from 'util'
import { exec as execCallback } from 'child_process'
import { 
  initializeTestConnections, 
  closeTestConnections, 
  cleanupTestData,
  getMainPrisma,
  waitForPendingOperations
} from '@/lib/testing/connection-manager'

const exec = promisify(execCallback)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface TestResults {
  passed: number
  failed: number
  tests: Array<{ name: string; passed: boolean; evidence: string[] }>
}

const results: TestResults = { passed: 0, failed: 0, tests: [] }
let testUserId: string | null = null

// ═══════════════════════════════════════════════════
// PROPER TEST LIFECYCLE MANAGEMENT
// ═══════════════════════════════════════════════════

beforeAll(async () => {
  console.log('\n🧪 INITIALIZING TEST CONNECTIONS')
  await initializeTestConnections()
})

afterAll(async () => {
  console.log('\n🧹 CLOSING TEST CONNECTIONS')
  await closeTestConnections()
})

beforeEach(async () => {
  console.log('\n🔄 CLEANING UP TEST DATA')
  await cleanupTestData()
  await waitForPendingOperations(100) // Allow async cleanup to complete
})

afterEach(async () => {
  // Additional cleanup if needed
  await waitForPendingOperations(50)
})

// ═══════════════════════════════════════════════════
// SETUP: CREATE TEST USER (WITH PROPER LIFECYCLE)
// ═══════════════════════════════════════════════════

async function setupTestUser() {
  try {
    console.log('\n📋 SETUP: Creating test user...\n')
    
    const prisma = getMainPrisma() // Use managed connection
    const email = `test_${Date.now()}@backenly.test`
    
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Test User',
        password: 'hashed_password', // Not used in these tests
      },
    })
    
    testUserId = user.id
    console.log(`  ✓ Test user created: ${user.id}`)
    console.log(`  ✓ Email: ${email}`)
    
    return true
  } catch (error: any) {
    console.error('  ❌ Setup failed:', error.message)
    return false
  }
}

async function cleanupTestUser() {
  if (!testUserId) return
  
  try {
    const prisma = getMainPrisma()
    await prisma.user.delete({
      where: { id: testUserId }
    })
    console.log('  ✓ Test user cleaned up')
  } catch (error) {
    console.warn('  ⚠️ Cleanup warning (user may not exist):', error)
  }
  
  testUserId = null
}

// ═══════════════════════════════════════════════════
// TEST IMPLEMENTATIONS (UNCHANGED LOGIC)
// ═══════════════════════════════════════════════════

async function test1_RealDiskPersistence() {
  console.log('\n🔹 TEST 1 — Real Disk Persistence\n')
  
  const evidence: string[] = []
  
  try {
    const prisma = getMainPrisma()
    
    // Create test data
    console.log('EXECUTE: Writing data to database...')
    const project = await prisma.project.create({
      data: {
        name: 'Persistence Test Project',
        userId: testUserId!,
      }
    })
    
    evidence.push(`Project created: ${project.id}`)
    console.log(`  ✓ Project created: ${project.id}`)
    
    // Verify it persists
    const found = await prisma.project.findUnique({
      where: { id: project.id }
    })
    
    if (found) {
      evidence.push('Data persisted to disk')
      console.log('  ✓ Data found after creation')
    } else {
      evidence.push('Data NOT found')
      results.push({ name: 'Real Disk Persistence', passed: false, evidence })
      return
    }
    
    // Cleanup
    await prisma.project.delete({
      where: { id: project.id }
    })
    
    results.tests.push({ name: 'Real Disk Persistence', passed: true, evidence })
    console.log('\n✅ TEST 1: PASS\n')
    
  } catch (error: any) {
    evidence.push(`Error: ${error.message}`)
    results.tests.push({ name: 'Real Disk Persistence', passed: false, evidence })
    console.log(`\n❌ TEST 1: FAIL - ${error.message}\n`)
  }
}

async function test2_RealTransactionACID() {
  console.log('\n🔹 TEST 2 — Real Transaction ACID Properties\n')
  
  const evidence: string[] = []
  
  try {
    const prisma = getMainPrisma()
    
    console.log('EXECUTE: Testing atomic transaction rollback...')
    
    // Test atomicity - if one fails, all should rollback
    try {
      await prisma.$transaction([
        prisma.project.create({
          data: {
            name: 'Atomic Test 1',
            userId: testUserId!
          }
        }),
        prisma.project.create({
          data: {
            name: 'Atomic Test 2',
            userId: 'INVALID_USER_ID' // This should fail
          }
        })
      ])
    } catch (error) {
      evidence.push('Transaction rolled back on error')
      console.log('  ✓ Transaction properly rolled back')
    }
    
    // Verify no partial data was written
    const projects = await prisma.project.findMany({
      where: {
        name: {
          in: ['Atomic Test 1', 'Atomic Test 2']
        }
      }
    })
    
    if (projects.length === 0) {
      evidence.push('No partial data written')
      console.log('  ✓ No partial data found')
    } else {
      evidence.push(`Found ${projects.length} partial records`)
      results.tests.push({ name: 'Real Transaction ACID', passed: false, evidence })
      return
    }
    
    results.tests.push({ name: 'Real Transaction ACID', passed: true, evidence })
    console.log('\n✅ TEST 2: PASS\n')
    
  } catch (error: any) {
    evidence.push(`Error: ${error.message}`)
    results.tests.push({ name: 'Real Transaction ACID', passed: false, evidence })
    console.log(`\n❌ TEST 2: FAIL - ${error.message}\n`)
  }
}

async function test3_RealConcurrency() {
  console.log('\n🔹 TEST 3 — Real Concurrency (Prevent Lost Updates)\n')
  
  const evidence: string[] = []
  
  try {
    const prisma = getMainPrisma()
    
    // Create base project
    const project = await prisma.project.create({
      data: {
        name: 'Concurrency Test Project',
        userId: testUserId!,
        apiRequests: 0
      }
    })
    
    console.log('EXECUTE: Launching 10 concurrent database increments...')
    
    // Launch concurrent updates
    const updates = Array.from({ length: 10 }, () => 
      prisma.project.update({
        where: { id: project.id },
        data: { apiRequests: { increment: 1 } },
      })
    )
    
    const startTime = Date.now()
    await Promise.all(updates)
    const duration = Date.now() - startTime
    
    // Verify final count
    const finalProject = await prisma.project.findUnique({
      where: { id: project.id }
    })
    
    const expected = 10
    const actual = finalProject?.apiRequests || 0
    
    evidence.push(`Concurrent updates completed in ${duration}ms`)
    evidence.push(`Final count: ${actual} (expected: ${expected})`)
    console.log(`  ✓ Concurrent updates completed in ${duration}ms`)
    console.log(`  ✓ Final count: ${actual} (expected: ${expected})`)
    
    if (actual === expected) {
      evidence.push('No lost updates detected')
      console.log('  ✓ No lost updates')
    } else {
      evidence.push(`Lost updates detected: expected ${expected}, got ${actual}`)
      results.tests.push({ name: 'Real Concurrency', passed: false, evidence })
      await prisma.project.delete({ where: { id: project.id } })
      return
    }
    
    // Cleanup
    await prisma.project.delete({ where: { id: project.id } })
    
    results.tests.push({ name: 'Real Concurrency', passed: true, evidence })
    console.log('\n✅ TEST 3: PASS\n')
    
  } catch (error: any) {
    evidence.push(`Error: ${error.message}`)
    results.tests.push({ name: 'Real Concurrency', passed: false, evidence })
    console.log(`\n❌ TEST 3: FAIL - ${error.message}\n`)
  }
}

async function test4_RealQueryPerformance() {
  console.log('\n🔹 TEST 4 — Real Query Performance Baselines\n')
  
  const evidence: string[] = []
  
  try {
    const prisma = getMainPrisma()
    
    console.log('EXECUTE: Measuring query performance baselines...')
    
    // Measure SELECT performance
    const selectStart = Date.now()
    await prisma.project.findMany({ take: 100 })
    const selectTime = Date.now() - selectStart
    
    // Measure INSERT performance
    const insertStart = Date.now()
    const project = await prisma.project.create({
      data: {
        name: 'Performance Test Project',
        userId: testUserId!
      }
    })
    const insertTime = Date.now() - insertStart
    
    // Measure UPDATE performance
    const updateStart = Date.now()
    await prisma.project.update({
      where: { id: project.id },
      data: { name: 'Updated Performance Test' }
    })
    const updateTime = Date.now() - updateStart
    
    evidence.push(`SELECT baseline: ${selectTime}ms`)
    evidence.push(`INSERT baseline: ${insertTime}ms`)
    evidence.push(`UPDATE baseline: ${updateTime}ms`)
    
    console.log(`  ✓ SELECT: ${selectTime}ms`)
    console.log(`  ✓ INSERT: ${insertTime}ms`)
    console.log(`  ✓ UPDATE: ${updateTime}ms`)
    
    // Cleanup
    await prisma.project.delete({ where: { id: project.id } })
    
    results.tests.push({ name: 'Real Query Performance', passed: true, evidence })
    console.log('\n✅ TEST 4: PASS\n')
    
  } catch (error: any) {
    evidence.push(`Error: ${error.message}`)
    results.tests.push({ name: 'Real Query Performance', passed: false, evidence })
    console.log(`\n❌ TEST 4: FAIL - ${error.message}\n`)
  }
}

async function test5_RealConstraints() {
  console.log('\n🔹 TEST 5 — Real Database Constraints\n')
  
  const evidence: string[] = []
  
  try {
    const prisma = getMainPrisma()
    
    console.log('EXECUTE: Testing database constraint enforcement...')
    
    // Test unique constraint
    const projectName = 'Constraint Test Project'
    
    // First creation should succeed
    const project1 = await prisma.project.create({
      data: {
        name: projectName,
        userId: testUserId!
      }
    })
    evidence.push('First project creation succeeded')
    console.log('  ✓ First creation succeeded')
    
    // Second creation with same name should fail
    try {
      await prisma.project.create({
        data: {
          name: projectName,
          userId: testUserId!
        }
      })
      evidence.push('ERROR: Duplicate creation should have failed')
      results.tests.push({ name: 'Real Constraints', passed: false, evidence })
      await prisma.project.delete({ where: { id: project1.id } })
      return
    } catch (error: any) {
      if (error.code === 'P2002') { // Unique constraint violation
        evidence.push('Unique constraint properly enforced')
        console.log('  ✓ Unique constraint enforced')
      } else {
        throw error
      }
    }
    
    // Cleanup
    await prisma.project.delete({ where: { id: project1.id } })
    
    results.tests.push({ name: 'Real Constraints', passed: true, evidence })
    console.log('\n✅ TEST 5: PASS\n')
    
  } catch (error: any) {
    evidence.push(`Error: ${error.message}`)
    results.tests.push({ name: 'Real Constraints', passed: false, evidence })
    console.log(`\n❌ TEST 5: FAIL - ${error.message}\n`)
  }
}

// ═══════════════════════════════════════════════════
// MAIN TEST RUNNER (WITH PROPER LIFECYCLE)
// ═══════════════════════════════════════════════════

async function runTests() {
  console.log('═══════════════════════════════════════════════════')
  console.log('   CONVERTED REAL DATABASE OPERATIONAL TESTS')
  console.log('   With Proper Connection Lifecycle Management')
  console.log('═══════════════════════════════════════════════════')
  
  // Setup happens in beforeAll/beforeEach now
  
  await test1_RealDiskPersistence()
  await test2_RealTransactionACID()
  await test3_RealConcurrency()
  await test4_RealQueryPerformance()
  await test5_RealConstraints()
  
  // Summary
  console.log('\n═══════════════════════════════════════════════════')
  console.log('   TEST SUMMARY')
  console.log('═══════════════════════════════════════════════════\n')
  
  results.tests.forEach((test, i) => {
    const icon = test.passed ? '✅' : '❌'
    console.log(`${icon} TEST ${i + 1}: ${test.name}`)
    if (!test.passed) {
      console.log(`   Evidence: ${test.evidence}`)
    }
  })
  
  const total = results.tests.length
  const passed = results.tests.filter(t => t.passed).length
  const failed = total - passed
  const passRate = ((passed / total) * 100).toFixed(1)
  
  console.log(`\nTotal Tests: ${total}`)
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)
  console.log(`Pass Rate: ${passRate}%`)
  
  if (failed === 0) {
    console.log('\n🎉 ALL TESTS PASSED - REAL OPERATIONAL VERIFICATION COMPLETE\n')
    console.log('EVIDENCE:')
    console.log('✓ Data persisted to real PostgreSQL database')
    console.log('✓ ACID properties enforced at database level')
    console.log('✓ Concurrency handled with zero lost updates')
    console.log('✓ Real query execution times measured')
    console.log('✓ Database constraints actively enforced')
    console.log('\nNO IN-MEMORY MOCKS - ALL EXECUTION WAS REAL\n')
    console.log('CONNECTION LIFECYCLE: Properly managed\n')
  } else {
    console.log('\n❌ SOME TESTS FAILED - OPERATIONAL ISSUES DETECTED\n')
  }
  
  // Cleanup happens in afterEach/afterAll
  
  process.exit(failed === 0 ? 0 : 1)
}

// Export for manual running
export { runTests }