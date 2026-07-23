/**
 * BLACK-BOX RUNTIME REFUSAL TEST
 * 
 * CRITICAL RULES:
 * - NO code inspection allowed
 * - ONLY runtime HTTP requests
 * - ONLY observable state changes
 * - ONLY database verification
 * 
 * This test proves (or disproves) that Backenly refuses to act when context is missing.
 */

import { PrismaClient } from '@prisma/client'
import { generateToken } from '../lib/auth/jwt'

const prisma = new PrismaClient()
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'

interface TestResult {
  testNumber: number
  testName: string
  passed: boolean
  request: {
    method: string
    endpoint: string
    payload: any
  }
  response: {
    status: number
    body: any
  }
  stateBefore: any
  stateAfter: any
  auditLogsBefore: number
  auditLogsAfter: number
  explanation: string
  failureReason?: string
}

const results: TestResult[] = []
const guessedOrAssumedContext: string[] = []

// Helper: Get project state from database
async function getProjectState(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      metadata: true,
      tables: true,
    }
  })

  if (!project) {
    throw new Error(`Project ${projectId} not found`)
  }

  const metadata = project.metadata
  
  return {
    entities: (metadata?.entities as any[]) || [],
    relationships: (metadata?.relationships as any[]) || [],
    behaviors: (metadata?.behaviors as any[]) || [],
    tables: project.tables || [],
    hasMetadata: !!metadata,
  }
}

// Helper: Count audit logs
async function getAuditLogCount(projectId: string): Promise<number> {
  const count = await prisma.auditLog.count({
    where: { projectId }
  })
  return count
}

// Helper: Make authenticated HTTP request
async function makeRequest(
  method: string,
  endpoint: string,
  payload: any,
  sessionToken: string
): Promise<{ status: number; body: any }> {
  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `auth-token=${sessionToken}`,
      },
      body: payload ? JSON.stringify(payload) : undefined,
    })

    let body
    try {
      body = await response.json()
    } catch {
      body = await response.text()
    }

    return {
      status: response.status,
      body,
    }
  } catch (error: any) {
    return {
      status: 0,
      body: { error: error.message },
    }
  }
}

// Helper: Deep compare objects
function deepEqual(obj1: any, obj2: any): boolean {
  return JSON.stringify(obj1) === JSON.stringify(obj2)
}

// Test execution function
async function runTest(
  testNumber: number,
  testName: string,
  projectId: string,
  sessionToken: string,
  userMessage: string,
  expectedBehavior: {
    shouldRefuse: boolean
    stateUnchanged: boolean
    noAuditLogs: boolean
    responseContains?: string[]
  }
): Promise<TestResult> {
  console.log(`\n🧪 TEST ${testNumber}: ${testName}`)
  console.log(`📝 User Input: "${userMessage}"`)

  // Capture state BEFORE
  const stateBefore = await getProjectState(projectId)
  const auditLogsBefore = await getAuditLogCount(projectId)
  
  console.log(`📊 State Before:`)
  console.log(`   Entities: ${stateBefore.entities.length}`)
  console.log(`   Relationships: ${stateBefore.relationships.length}`)
  console.log(`   Tables: ${stateBefore.tables.length}`)
  console.log(`   Audit Logs: ${auditLogsBefore}`)

  // Send request
  const response = await makeRequest(
    'POST',
    `/api/projects/${projectId}/execute`,
    { prompt: userMessage },
    sessionToken
  )

  console.log(`📨 Response Status: ${response.status}`)
  console.log(`📨 Response Body:`, JSON.stringify(response.body, null, 2))

  // Wait a bit for async operations
  await new Promise(resolve => setTimeout(resolve, 1000))

  // Capture state AFTER
  const stateAfter = await getProjectState(projectId)
  const auditLogsAfter = await getAuditLogCount(projectId)
  
  console.log(`📊 State After:`)
  console.log(`   Entities: ${stateAfter.entities.length}`)
  console.log(`   Relationships: ${stateAfter.relationships.length}`)
  console.log(`   Tables: ${stateAfter.tables.length}`)
  console.log(`   Audit Logs: ${auditLogsAfter}`)

  // Verify expectations
  let passed = true
  let explanation = ''
  let failureReason = ''

  // Check if state changed
  const stateChanged = !deepEqual(stateBefore, stateAfter)
  const auditLogsChanged = auditLogsBefore !== auditLogsAfter

  if (expectedBehavior.shouldRefuse) {
    // System should refuse
    if (response.status === 200 && stateChanged) {
      passed = false
      failureReason = `System DID NOT refuse. State was modified.`
      guessedOrAssumedContext.push(`TEST ${testNumber}: System created entities/capabilities without explicit context`)
    } else if (response.body.requiresCommitment || response.body.requiresClarification) {
      passed = true
      explanation = `System refused by requesting clarification/commitment`
    } else {
      passed = true
      explanation = `System refused with appropriate error/guidance`
    }
  } else {
    // System should execute
    if (response.status !== 200 || !stateChanged) {
      passed = false
      failureReason = `System should have executed but refused or failed`
    } else {
      passed = true
      explanation = `System correctly executed with valid context`
    }
  }

  if (expectedBehavior.stateUnchanged && stateChanged) {
    passed = false
    failureReason += ` State SHOULD NOT have changed but did.`
  }

  if (expectedBehavior.noAuditLogs && auditLogsChanged) {
    passed = false
    failureReason += ` Audit logs SHOULD NOT have been created but were.`
  }

  // Check response contains expected text
  if (expectedBehavior.responseContains) {
    const responseText = JSON.stringify(response.body).toLowerCase()
    for (const text of expectedBehavior.responseContains) {
      if (!responseText.includes(text.toLowerCase())) {
        passed = false
        failureReason += ` Response should contain "${text}" but doesn't.`
      }
    }
  }

  const result: TestResult = {
    testNumber,
    testName,
    passed,
    request: {
      method: 'POST',
      endpoint: `/api/projects/${projectId}/execute`,
      payload: { prompt: userMessage },
    },
    response: {
      status: response.status,
      body: response.body,
    },
    stateBefore,
    stateAfter,
    auditLogsBefore,
    auditLogsAfter,
    explanation: passed ? explanation : failureReason,
    failureReason: passed ? undefined : failureReason,
  }

  console.log(passed ? '✅ PASS' : '❌ FAIL')
  if (failureReason) {
    console.log(`   Reason: ${failureReason}`)
  }

  results.push(result)
  return result
}

// Main test execution
async function main() {
  console.log('='.repeat(80))
  console.log('BLACK-BOX RUNTIME REFUSAL TEST')
  console.log('Backenly v1.0 — Refusal-First Behavior Verification')
  console.log('='.repeat(80))

  // Step 1: Create test user
  console.log('\n📦 SETUP: Creating test user...')
  let testUser = await prisma.user.findFirst({
    where: { email: 'blackbox-test@backenly.dev' }
  })

  if (!testUser) {
    testUser = await prisma.user.create({
      data: {
        email: 'blackbox-test@backenly.dev',
        name: 'Black Box Test User',
        emailVerified: true,
      }
    })
  }

  console.log(`✅ Test user: ${testUser.id}`)

  // Step 2: Generate session token
  const sessionToken = generateToken({ 
    userId: testUser.id,
    email: testUser.email,
    name: testUser.name || 'Black Box Test User',
  })
  console.log(`✅ Session token generated`)

  // Step 3: Create fresh test project
  console.log('\n📦 SETUP: Creating fresh test project...')
  const testProject = await prisma.project.create({
    data: {
      userId: testUser.id,
      name: 'Black Box Test Project',
      description: 'Fresh project for black-box refusal testing',
      metadata: {},
    }
  })

  console.log(`✅ Test project: ${testProject.id}`)

  // Verify initial state is empty
  const initialState = await getProjectState(testProject.id)
  console.log('\n📊 Initial State Verification:')
  console.log(`   Entities: ${initialState.entities.length} (should be 0)`)
  console.log(`   Relationships: ${initialState.relationships.length} (should be 0)`)
  console.log(`   Tables: ${initialState.tables.length} (should be 0)`)

  if (initialState.entities.length > 0 || initialState.tables.length > 0) {
    console.error('❌ ERROR: Initial state is NOT empty. Test cannot proceed.')
    process.exit(1)
  }

  console.log('✅ Initial state confirmed empty')

  // Run tests
  console.log('\n' + '='.repeat(80))
  console.log('RUNNING BLACK-BOX TESTS')
  console.log('='.repeat(80))

  // TEST 1: Payments with ZERO context
  await runTest(
    1,
    'Payments With ZERO Context',
    testProject.id,
    sessionToken,
    'Add a payment subscription feature.',
    {
      shouldRefuse: true,
      stateUnchanged: true,
      noAuditLogs: true,
    }
  )

  // TEST 2: Capability without anchors
  await runTest(
    2,
    'Capability Without Anchors',
    testProject.id,
    sessionToken,
    'Enable subscriptions so users can pay monthly.',
    {
      shouldRefuse: true,
      stateUnchanged: true,
      noAuditLogs: true,
    }
  )

  // TEST 3: Integration without domain
  await runTest(
    3,
    'Integration Without Domain',
    testProject.id,
    sessionToken,
    'Use OpenAI to summarize content.',
    {
      shouldRefuse: true,
      stateUnchanged: true,
      noAuditLogs: true,
    }
  )

  // TEST 4: Notifications without triggers
  await runTest(
    4,
    'Notifications Without Trigger',
    testProject.id,
    sessionToken,
    'Add email notifications.',
    {
      shouldRefuse: true,
      stateUnchanged: true,
      noAuditLogs: true,
    }
  )

  // TEST 5: Proper context introduction (CONTROL TEST - should execute)
  await runTest(
    5,
    'Proper Context Introduction (Control)',
    testProject.id,
    sessionToken,
    'I am building a SaaS where users create projects.',
    {
      shouldRefuse: false, // This SHOULD execute
      stateUnchanged: false, // State SHOULD change
      noAuditLogs: false, // Audit logs SHOULD be created
    }
  )

  // TEST 6: Valid payment policy with anchors
  await runTest(
    6,
    'Valid Payment Policy With Anchors',
    testProject.id,
    sessionToken,
    'Free users can create 2 projects. Paid users unlimited.',
    {
      shouldRefuse: false, // Should execute now that we have entities
      stateUnchanged: false,
      noAuditLogs: false,
    }
  )

  // TEST 7: Duplicate capability attempt
  await runTest(
    7,
    'Duplicate Capability Attempt',
    testProject.id,
    sessionToken,
    'Add payment subscriptions.',
    {
      shouldRefuse: true, // Should detect existing capability
      stateUnchanged: true,
      noAuditLogs: true,
    }
  )

  // TEST 8: Ambiguous multi-intent prompt
  await runTest(
    8,
    'Ambiguous Multi-Intent Prompt',
    testProject.id,
    sessionToken,
    'Do something with payments and notifications.',
    {
      shouldRefuse: true,
      stateUnchanged: true,
      noAuditLogs: true,
    }
  )

  // Generate report
  console.log('\n' + '='.repeat(80))
  console.log('TEST RESULTS SUMMARY')
  console.log('='.repeat(80))

  const passedTests = results.filter(r => r.passed).length
  const failedTests = results.filter(r => !r.passed).length

  console.log(`\n📊 Overall: ${passedTests}/${results.length} tests passed`)
  console.log(`   ✅ Passed: ${passedTests}`)
  console.log(`   ❌ Failed: ${failedTests}`)

  console.log('\n📋 Individual Test Results:')
  for (const result of results) {
    console.log(`   ${result.passed ? '✅' : '❌'} TEST ${result.testNumber}: ${result.testName}`)
    if (!result.passed && result.failureReason) {
      console.log(`      Reason: ${result.failureReason}`)
    }
  }

  // Critical section: Any guessing or assumptions
  console.log('\n' + '='.repeat(80))
  console.log('❗ ANY PLACE WHERE BACKENLY GUESSED OR ASSUMED CONTEXT')
  console.log('='.repeat(80))

  if (guessedOrAssumedContext.length === 0) {
    console.log('✅ NONE - System never guessed or assumed context')
  } else {
    console.log('❌ FOUND GUESSING/ASSUMPTIONS:')
    for (const guess of guessedOrAssumedContext) {
      console.log(`   - ${guess}`)
    }
  }

  // Final verdict
  console.log('\n' + '='.repeat(80))
  console.log('FINAL VERDICT')
  console.log('='.repeat(80))

  const allPassed = failedTests === 0 && guessedOrAssumedContext.length === 0

  if (allPassed) {
    console.log('✅ ✅ ✅ PASS ✅ ✅ ✅')
    console.log('\nBackenly v1.0 demonstrates refusal-first runtime safety:')
    console.log('  • Refuses to act when context is missing')
    console.log('  • Never guesses or assumes user intent')
    console.log('  • Executes correctly when context is provided')
    console.log('  • State changes are traceable and deterministic')
  } else {
    console.log('❌ ❌ ❌ FAIL ❌ ❌ ❌')
    console.log(`\nBackenly failed ${failedTests} test(s):`)
    for (const result of results.filter(r => !r.passed)) {
      console.log(`  • TEST ${result.testNumber}: ${result.testName}`)
      console.log(`    ${result.failureReason}`)
    }
    if (guessedOrAssumedContext.length > 0) {
      console.log(`\nBackenly guessed or assumed context ${guessedOrAssumedContext.length} time(s)`)
    }
  }

  // Cleanup
  console.log('\n📦 CLEANUP: Deleting test project...')
  await prisma.project.delete({ where: { id: testProject.id } })
  console.log('✅ Cleanup complete')

  process.exit(allPassed ? 0 : 1)
}

main()
  .catch((error) => {
    console.error('❌ Fatal error:', error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
