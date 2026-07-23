/**
 * 5 PRODUCTION-GRADE PROMPTS TO MAKE BACKENLY 100% PERFECT
 * 
 * Tests the 5 critical invariant enforcement systems:
 * 1. Uniqueness Constraints (DB-level)
 * 2. Quota Enforcement (Runtime)
 * 3. Ownership Enforcement (Write Protection)
 * 4. Read Isolation (Privacy Critical)
 * 5. Soft-Delete + Anonymization (User Exit Safety)
 */

import { PrismaClient } from '@prisma/client'
import { orchestrateBackendChange } from '../lib/orchestration'

const prisma = new PrismaClient()

const PROMPTS = [
  {
    id: 1,
    name: 'Uniqueness Constraint (Voting App)',
    prompt: `I want to build a voting app where users can vote on ideas.

A user can vote on the same idea only once, no matter how many times they try.

If the same user tries to vote again, the request should be blocked.

Vote counts should always be accurate.

Everything should work safely without me handling duplicates.`,
    expectedInvariants: ['@@unique([idea_id, user_id])'],
  },
  {
    id: 2,
    name: 'Quota Enforcement (Idea Board)',
    prompt: `I want to build an idea board where free users can create only 3 ideas.

Paid users can create unlimited ideas.

If a free user tries to create a 4th idea, the request should be blocked immediately and explain why.

The limit should not depend on frontend logic.`,
    expectedInvariants: ['quota: { tier: free, limit: 3 }'],
  },
  {
    id: 3,
    name: 'Ownership Enforcement (Posts)',
    prompt: `I want users to create posts.

Users should be able to edit or delete only their own posts.

If someone tries to edit another user's post, it should always be blocked.

This should work even if someone manually calls the API.`,
    expectedInvariants: ['ownership: { writeProtection: true }'],
  },
  {
    id: 4,
    name: 'Read Isolation (Private Notes)',
    prompt: `I want to build a private notes app.

Each user should see only their own notes.

No user should ever be able to see another user's notes.

I don't want to configure filters or permissions myself.`,
    expectedInvariants: ['readIsolation: { enabled: true }'],
  },
  {
    id: 5,
    name: 'Soft-Delete + Anonymization (Comments)',
    prompt: `I want users to create comments on posts.

If a user deletes their account, their comments should remain.

But their name should be replaced with "Deleted User" everywhere.

No content should disappear.`,
    expectedInvariants: ['softDelete: { anonymizeFields: [name] }'],
  },
]

interface TestResult {
  promptId: number
  name: string
  success: boolean
  invariantsDetected: string[]
  errors: string[]
  executionTime: number
}

async function runTest(prompt: typeof PROMPTS[0], userId: string): Promise<TestResult> {
  const result: TestResult = {
    promptId: prompt.id,
    name: prompt.name,
    success: false,
    invariantsDetected: [],
    errors: [],
    executionTime: 0,
  }

  const startTime = Date.now()

  console.log('\n' + '='.repeat(80))
  console.log(`TEST ${prompt.id}: ${prompt.name}`)
  console.log('='.repeat(80))
  console.log(`\nPrompt: "${prompt.prompt.substring(0, 200)}..."\n`)

  try {
    // Create project for this test
    const project = await prisma.project.create({
      data: {
        name: `Test ${prompt.id}: ${prompt.name}`,
        description: prompt.prompt,
        userId,
      },
    })

    console.log(`✅ Created project: ${project.id}`)

    // Execute prompt through orchestration
    await orchestrateBackendChange(prompt.prompt, project.id)

    // Check what invariants were detected
    const metadata = await prisma.projectMetadata.findUnique({
      where: { projectId: project.id },
    })

    if (metadata && metadata.backendStateGraph) {
      const graph = metadata.backendStateGraph as any
      
      // Check for uniqueness constraints
      Object.values(graph.entities || {}).forEach((entity: any) => {
        if (entity.uniqueConstraints?.length > 0) {
          result.invariantsDetected.push('uniqueness_constraint')
        }
        if (entity.quotas?.length > 0) {
          result.invariantsDetected.push('quota_enforcement')
        }
        if (entity.ownership?.enabled) {
          result.invariantsDetected.push('ownership_enforcement')
        }
        if (entity.readIsolation?.enabled) {
          result.invariantsDetected.push('read_isolation')
        }
        if (entity.softDelete?.enabled) {
          result.invariantsDetected.push('soft_delete')
        }
      })
    }

    result.success = result.invariantsDetected.length > 0
    
    console.log(`\n📊 RESULTS:`)
    console.log(`  Invariants Detected: ${result.invariantsDetected.join(', ')}`)
    console.log(`  Expected: ${prompt.expectedInvariants.join(', ')}`)
    console.log(`  Status: ${result.success ? '✅ PASS' : '❌ FAIL'}`)

  } catch (error: any) {
    result.errors.push(error.message || 'Unknown error')
    console.error(`\n❌ ERROR: ${error.message}`)
  }

  result.executionTime = Date.now() - startTime
  return result
}

async function main() {
  console.log('\n🚀 BACKENLY 100% PRODUCTION-GRADE TEST SUITE')
  console.log('Testing 5 critical invariant enforcement systems...\n')

  // Get or create test user
  let testUser = await prisma.user.findFirst({
    where: { email: 'test-production@backenly.com' },
  })

  if (!testUser) {
    testUser = await prisma.user.create({
      data: {
        email: 'test-production@backenly.com',
        name: 'Test User (Production)',
      },
    })
  }

  console.log(`Using test user: ${testUser.id}\n`)

  const results: TestResult[] = []

  for (const prompt of PROMPTS) {
    const result = await runTest(prompt, testUser.id)
    results.push(result)
    
    // Wait 2 seconds between tests
    await new Promise(resolve => setTimeout(resolve, 2000))
  }

  // Print summary
  console.log('\n' + '='.repeat(80))
  console.log('FINAL SUMMARY')
  console.log('='.repeat(80))

  const passed = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length

  console.log(`\n✓ PASSED: ${passed}/5`)
  console.log(`✗ FAILED: ${failed}/5`)

  console.log('\n📋 DETAILED RESULTS:')
  results.forEach(r => {
    const status = r.success ? '✅' : '❌'
    console.log(`${status} Test ${r.promptId}: ${r.name}`)
    console.log(`   Invariants: ${r.invariantsDetected.join(', ') || 'NONE'}`)
    console.log(`   Time: ${r.executionTime}ms`)
    if (r.errors.length > 0) {
      console.log(`   Errors: ${r.errors.join('; ')}`)
    }
  })

  console.log('\n' + '='.repeat(80))
  console.log(`PRODUCTION-GRADE TEST: ${passed === 5 ? '✅ PASSED' : '❌ NEEDS WORK'}`)
  console.log('='.repeat(80))
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
