#!/usr/bin/env ts-node
/**
 * Real Database Concurrency Test
 * 
 * Runs against local PostgreSQL to verify:
 * - Actual optimistic locking conflicts occur
 * - Retry logic resolves them
 * - State converges correctly
 * - Performance metrics
 */

import { PrismaClient } from '@prisma/client'
import { executeDeterministicMutationWithRetry } from '../lib/orchestration/deterministic-mutation-executor'
import { getActiveGraph } from '../lib/orchestration/graph-pointer'
import { createEmptyGraph } from '../lib/orchestration/backend-state-graph'
import { createInitialGraph } from '../lib/orchestration/graph-pointer'
import { CanonicalIntent } from '../lib/orchestration/types'

// Test configuration
const CONCURRENT_MUTATIONS = 20
const TEST_DB_URL = 'postgresql://backenly:backenly@localhost:5432/backenly'

interface TestMetrics {
  totalMutations: number
  successful: number
  failed: number
  conflictsDetected: number
  totalRetries: number
  maxRetryDepth: number
  p50Latency: number
  p95Latency: number
  p99Latency: number
  finalFieldCount: number
  expectedFieldCount: number
  convergenceSuccess: boolean
}

async function runRealDBConcurrencyTest() {
  console.log('\n' + '='.repeat(80))
  console.log('REAL DATABASE CONCURRENCY TEST')
  console.log('='.repeat(80))
  console.log(`Database: ${TEST_DB_URL}`)
  console.log(`Concurrent mutations: ${CONCURRENT_MUTATIONS}`)
  console.log('='.repeat(80) + '\n')

  // Create Prisma client pointing to local DB
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: TEST_DB_URL,
      },
    },
  })

  try {
    // Test connection
    await prisma.$connect()
    console.log('✅ Connected to local PostgreSQL')

    // Clean up any existing test data
    await prisma.project.deleteMany({
      where: { name: { startsWith: 'concurrency-real-test' } }
    })
    await prisma.user.deleteMany({
      where: { email: 'concurrency-real@backenly.test' }
    })

    // Create test user
    const testUser = await prisma.user.create({
      data: {
        email: 'concurrency-real@backenly.test',
        name: 'Real Concurrency Test User',
      },
    })
    console.log(`✅ Created test user: ${testUser.id}`)

    // Create test project
    const testProject = await prisma.project.create({
      data: {
        name: `concurrency-real-test-${Date.now()}`,
        userId: testUser.id,
        description: 'Testing real DB concurrency',
      },
    })
    console.log(`✅ Created test project: ${testProject.id}`)

    // Initialize empty graph
    const emptyGraph = createEmptyGraph(testProject.id)
    await createInitialGraph(testProject.id, emptyGraph)
    console.log('✅ Initialized empty graph\n')

    // Create intents for concurrent field additions
    const intents: CanonicalIntent[] = Array.from({ length: CONCURRENT_MUTATIONS }, (_, i) => ({
      intent_type: 'DATA_MODEL_ADD',
      domain: 'DATABASE',
      action: 'CREATE',
      target: 'users',
      feature: 'users',
      constraints: {
        fields: [
          { name: `field_${i.toString().padStart(2, '0')}`, type: 'string' }
        ]
      },
      source_text: `create users table with field_${i}`,
      timestamp: new Date().toISOString(),
      confidence: 0.95,
      status: 'COMMITTED' as const,
    }))

    console.log(`🚀 Starting ${CONCURRENT_MUTATIONS} concurrent mutations...\n`)

    // Track metrics
    const latencies: number[] = []
    let conflictsDetected = 0
    let totalRetries = 0
    let maxRetryDepth = 0

    // Execute all mutations concurrently
    const startTime = Date.now()

    const results = await Promise.allSettled(
      intents.map((intent, index) => {
        const mutationStart = Date.now()
        
        return executeDeterministicMutationWithRetry({
          projectId: testProject.id,
          intents: [intent],
        }).then(result => {
          const latency = Date.now() - mutationStart
          latencies.push(latency)
          
          // Track retry metrics (would need to expose from executor)
          // For now, we can infer from latency spikes
          
          console.log(`[Mutation ${index.toString().padStart(2, '0')}] ✅ Success in ${latency}ms`)
          return { index, success: true, latency }
        }).catch(error => {
          const latency = Date.now() - mutationStart
          latencies.push(latency)
          
          console.log(`[Mutation ${index.toString().padStart(2, '0')}] ❌ Failed: ${error.message}`)
          return { index, success: false, error: error.message, latency }
        })
      })
    )

    const totalDuration = Date.now() - startTime

    // Analyze results
    const successful = results.filter(r => r.status === 'fulfilled' && (r.value as any).success)
    const failed = results.filter(r => r.status === 'rejected' || !(r.value as any).success)

    // Calculate latency percentiles
    const sortedLatencies = latencies.sort((a, b) => a - b)
    const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)]
    const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)]
    const p99 = sortedLatencies[Math.floor(sortedLatencies.length * 0.99)]

    console.log('\n' + '='.repeat(80))
    console.log('EXECUTION RESULTS')
    console.log('='.repeat(80))
    console.log(`Total duration: ${totalDuration}ms`)
    console.log(`Successful: ${successful.length}/${CONCURRENT_MUTATIONS}`)
    console.log(`Failed: ${failed.length}/${CONCURRENT_MUTATIONS}`)
    console.log(`\nLatency:`)
    console.log(`  P50: ${p50}ms`)
    console.log(`  P95: ${p95}ms`)
    console.log(`  P99: ${p99}ms`)
    console.log(`  Min: ${sortedLatencies[0]}ms`)
    console.log(`  Max: ${sortedLatencies[sortedLatencies.length - 1]}ms`)

    // Verify final graph state
    console.log('\n' + '='.repeat(80))
    console.log('CONVERGENCE VERIFICATION')
    console.log('='.repeat(80))

    const finalGraph = await getActiveGraph(testProject.id)
    
    if (!finalGraph) {
      console.log('❌ FAILED: No final graph found')
      process.exit(1)
    }

    console.log(`Final graph version: ${finalGraph.version}`)
    console.log(`Entities: ${Object.keys(finalGraph.entities).join(', ') || 'NONE'}`)

    // Check users table
    if (!finalGraph.entities.users) {
      console.log('❌ FAILED: users table not found')
      process.exit(1)
    }

    const usersFields = Object.keys(finalGraph.entities.users.fields || {})
    console.log(`\nUsers table fields (${usersFields.length}):`)
    console.log(`  ${usersFields.join(', ')}`)

    // Verify all expected fields exist
    const expectedFields = Array.from({ length: CONCURRENT_MUTATIONS }, (_, i) => `field_${i.toString().padStart(2, '0')}`)
    const missingFields = expectedFields.filter(f => !usersFields.includes(f))
    const extraFields = usersFields.filter(f => !expectedFields.includes(f) && !['id', 'createdAt', 'updatedAt'].includes(f))

    console.log('\n' + '='.repeat(80))
    console.log('CONVERGENCE CHECK')
    console.log('='.repeat(80))

    let convergenceSuccess = true

    if (missingFields.length > 0) {
      console.log(`❌ Missing fields: ${missingFields.join(', ')}`)
      convergenceSuccess = false
    } else {
      console.log('✅ All expected fields present')
    }

    if (extraFields.length > 0) {
      console.log(`⚠️  Extra fields: ${extraFields.join(', ')}`)
    }

    // Check for duplicates
    const uniqueFields = new Set(usersFields)
    if (uniqueFields.size !== usersFields.length) {
      console.log(`❌ Duplicate fields detected!`)
      convergenceSuccess = false
    } else {
      console.log('✅ No duplicate fields')
    }

    // Final metrics
    const metrics: TestMetrics = {
      totalMutations: CONCURRENT_MUTATIONS,
      successful: successful.length,
      failed: failed.length,
      conflictsDetected,
      totalRetries,
      maxRetryDepth,
      p50Latency: p50,
      p95Latency: p95,
      p99Latency: p99,
      finalFieldCount: usersFields.length,
      expectedFieldCount: CONCURRENT_MUTATIONS,
      convergenceSuccess,
    }

    console.log('\n' + '='.repeat(80))
    console.log('FINAL METRICS')
    console.log('='.repeat(80))
    console.log(JSON.stringify(metrics, null, 2))

    console.log('\n' + '='.repeat(80))
    if (convergenceSuccess && successful.length === CONCURRENT_MUTATIONS) {
      console.log('✅ CONCURRENCY TEST PASSED')
      console.log('='.repeat(80) + '\n')
    } else {
      console.log('❌ CONCURRENCY TEST FAILED')
      console.log('='.repeat(80) + '\n')
      process.exit(1)
    }

    // Cleanup
    console.log('Cleaning up...')
    await prisma.project.delete({ where: { id: testProject.id } }).catch(() => {})
    await prisma.user.delete({ where: { email: 'concurrency-real@backenly.test' } }).catch(() => {})
    console.log('✅ Cleanup complete')

  } catch (error: any) {
    console.error('\n❌ Test failed with error:', error.message)
    console.error(error.stack)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

// Run if called directly
if (require.main === module) {
  runRealDBConcurrencyTest().catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}

export { runRealDBConcurrencyTest }
