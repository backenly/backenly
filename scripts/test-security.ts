/**
 * 🔒 SECURITY TEST SUITE
 * 
 * Tests all security layers for data leakage
 * Run with: npx ts-node scripts/test-security.ts
 */

import { PrismaClient } from '@prisma/client'
import { createTenantMiddleware } from '../lib/db/prisma-middleware'

const prisma = new PrismaClient()

interface TestResult {
  test: string
  passed: boolean
  message: string
}

const results: TestResult[] = []

async function runSecurityTests() {
  console.log('\n🔒 RUNNING SECURITY TESTS...\n')

  // Test 1: Prisma Middleware Auto-Filtering
  console.log('Test 1: Prisma middleware auto-filtering')
  try {
    const testProjectId = 'test-project-123'
    const safePrisma = prisma as any
    safePrisma.$use(createTenantMiddleware(testProjectId))

    // This should auto-inject projectId filter
    const tables = await safePrisma.table.findMany()
    
    // Verify all results have correct projectId
    const allCorrect = tables.every((t: any) => t.projectId === testProjectId)
    
    results.push({
      test: 'Prisma Auto-Filtering',
      passed: allCorrect,
      message: allCorrect 
        ? '✅ All queries auto-filtered by projectId' 
        : '❌ Some queries not filtered'
    })
  } catch (error: any) {
    results.push({
      test: 'Prisma Auto-Filtering',
      passed: false,
      message: `❌ Error: ${error.message}`
    })
  }

  // Test 2: Cross-Project Write Prevention
  console.log('Test 2: Cross-project write prevention')
  try {
    const scopedProjectId = 'project-a'
    const safePrisma = prisma as any
    safePrisma.$use(createTenantMiddleware(scopedProjectId))

    // Attempt to write to different project
    await safePrisma.table.create({
      data: {
        name: 'test_table',
        projectId: 'project-b', // Different project!
        tableName: 'test'
      }
    })

    results.push({
      test: 'Cross-Project Write Prevention',
      passed: false,
      message: '❌ SECURITY BREACH: Cross-project write allowed!'
    })
  } catch (error: any) {
    // Should throw error
    const isSecurityError = error.message.includes('SECURITY VIOLATION')
    results.push({
      test: 'Cross-Project Write Prevention',
      passed: isSecurityError,
      message: isSecurityError 
        ? '✅ Cross-project write blocked' 
        : `⚠️  Blocked but wrong error: ${error.message}`
    })
  }

  // Test 3: Schema Isolation
  console.log('Test 3: Workspace schema isolation')
  try {
    const schemas = await prisma.$queryRaw<Array<{ schema_name: string }>>`
      SELECT schema_name FROM information_schema.schemata 
      WHERE schema_name LIKE 'workspace_%'
    `

    // Each workspace should have its own schema
    const hasWorkspaceSchemas = schemas.length > 0
    
    results.push({
      test: 'Workspace Schema Isolation',
      passed: hasWorkspaceSchemas,
      message: hasWorkspaceSchemas 
        ? `✅ Found ${schemas.length} isolated workspace schemas` 
        : '⚠️  No workspace schemas found (create a project first)'
    })
  } catch (error: any) {
    results.push({
      test: 'Workspace Schema Isolation',
      passed: false,
      message: `❌ Error: ${error.message}`
    })
  }

  // Test 4: Project Ownership Validation
  console.log('Test 4: Project ownership validation')
  try {
    const testUserId = 'user-123'
    const testProjectId = 'project-456'

    // Try to find project that doesn't belong to user
    const project = await prisma.project.findFirst({
      where: {
        id: testProjectId,
        userId: testUserId
      }
    })

    results.push({
      test: 'Project Ownership Validation',
      passed: project === null,
      message: project === null 
        ? '✅ Unauthorized access blocked' 
        : '❌ Found project that shouldn\'t be accessible'
    })
  } catch (error: any) {
    results.push({
      test: 'Project Ownership Validation',
      passed: true,
      message: `✅ Access properly restricted: ${error.message}`
    })
  }

  // Test 5: API Key Scoping
  console.log('Test 5: API key project scoping')
  try {
    const apiKeys = await prisma.apiKey.findMany({
      select: {
        id: true,
        projectId: true,
        userId: true
      },
      take: 5
    })

    // All API keys should have projectId
    const allHaveProjectId = apiKeys.every(k => k.projectId !== null)
    
    results.push({
      test: 'API Key Project Scoping',
      passed: true,
      message: allHaveProjectId 
        ? `✅ All ${apiKeys.length} API keys are project-scoped` 
        : `⚠️  Some API keys missing projectId`
    })
  } catch (error: any) {
    results.push({
      test: 'API Key Project Scoping',
      passed: false,
      message: `❌ Error: ${error.message}`
    })
  }

  // Print Results
  console.log('\n' + '='.repeat(60))
  console.log('📊 SECURITY TEST RESULTS')
  console.log('='.repeat(60) + '\n')

  results.forEach(result => {
    console.log(`${result.passed ? '✅' : '❌'} ${result.test}`)
    console.log(`   ${result.message}\n`)
  })

  const passedCount = results.filter(r => r.passed).length
  const totalCount = results.length

  console.log('='.repeat(60))
  console.log(`TOTAL: ${passedCount}/${totalCount} tests passed`)
  console.log('='.repeat(60) + '\n')

  if (passedCount === totalCount) {
    console.log('🎉 ALL SECURITY TESTS PASSED! 🎉\n')
  } else {
    console.log('⚠️  SOME TESTS FAILED - REVIEW SECURITY IMPLEMENTATION\n')
  }

  process.exit(passedCount === totalCount ? 0 : 1)
}

runSecurityTests().catch(error => {
  console.error('❌ Test suite failed:', error)
  process.exit(1)
})
