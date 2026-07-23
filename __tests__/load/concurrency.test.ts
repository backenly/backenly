/**
 * Full Pipeline Load Testing & Concurrency Validation Suite
 * 
 * IMPORTANT: This test measures the FULL AI PIPELINE including LLM calls
 * Expected latency: ~20-30 seconds per mutation (AI planning + execution)
 * 
 * For EXECUTION ENGINE ONLY performance (target: <500ms):
 * See: __tests__/load/execution-engine-performance.test.ts
 * 
 * PHASE 5: Prove stability under stress
 * 
 * Tests:
 * - 50 concurrent mutations on same project (FULL PIPELINE)
 * - 100 concurrent mutations across projects (FULL PIPELINE)
 * - 200 advisory-only requests
 * - Measures: latency, error rate, memory, DB pool
 * - This is intentionally slow due to AI planning overhead
 */

import { orchestrateBackendChange, getActiveGraph } from '@/lib/orchestration'
import { generateSuggestions } from '@/lib/suggestions/suggestion-engine'
import { prisma } from '@/lib/db/prisma'
import { execSync } from 'child_process'

// Test configuration
const CONFIG = {
  sameProjectConcurrency: 50,
  crossProjectConcurrency: 100,
  advisoryRequests: 200,
  maxAcceptableLatencyMs: 35000, // Increased: includes AI planning (~20-30s)
  maxErrorRate: 0.05, // 5%
}

interface LoadTestResult {
  name: string
  totalRequests: number
  successful: number
  failed: number
  refused: number
  avgLatencyMs: number
  p95LatencyMs: number
  p99LatencyMs: number
  errorRate: number
  durationMs: number
}

interface TestContext {
  projectIds: string[]
  cleanup: () => Promise<void>
}

/**
 * Setup test environment
 */
async function setupTestEnvironment(): Promise<TestContext> {
  console.log('[Load Test] Setting up test environment...')
  
  // Create test user first (required for foreign key)
  const testUser = await prisma.user.upsert({
    where: { email: 'load-test@backenly.test' },
    update: {},
    create: {
      email: 'load-test@backenly.test',
      name: 'Load Test User',
    },
  })
  
  // Create test projects
  const projectIds: string[] = []
  
  for (let i = 0; i < 10; i++) {
    const project = await prisma.project.create({
      data: {
        name: `LoadTestProject_${i}_${Date.now()}`,
        userId: testUser.id,
        description: 'Load testing project',
      },
    })
    projectIds.push(project.id)
  }
  
  console.log(`[Load Test] Created ${projectIds.length} test projects`)
  
  return {
    projectIds,
    cleanup: async () => {
      console.log('[Load Test] Cleaning up...')
      for (const projectId of projectIds) {
        await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
      }
      // Clean up test user
      await prisma.user.delete({ where: { email: 'load-test@backenly.test' } }).catch(() => {})
    },
  }
}

/**
 * Run concurrent mutations on same project
 */
async function testSameProjectConcurrency(projectId: string): Promise<LoadTestResult> {
  console.log(`[Load Test] Testing ${CONFIG.sameProjectConcurrency} concurrent mutations on same project...`)
  
  const startTime = Date.now()
  const latencies: number[] = []
  let successful = 0
  let failed = 0
  let refused = 0
  
  // Create promises for concurrent mutations
  const mutations = Array.from({ length: CONFIG.sameProjectConcurrency }, (_, i) => 
    (async () => {
      const mutationStart = Date.now()
      try {
        const result = await orchestrateBackendChange(
          `Add field load_test_${i} to users table`,
          projectId,
          { forceCommit: true }
        )
        
        const latency = Date.now() - mutationStart
        latencies.push(latency)
        
        if (result.success) {
          successful++
        } else if (result.refusalReason) {
          refused++
        } else {
          failed++
        }
        
        return result
      } catch (error) {
        const latency = Date.now() - mutationStart
        latencies.push(latency)
        failed++
        throw error
      }
    })()
  )
  
  // Run all mutations concurrently
  await Promise.allSettled(mutations)
  
  const durationMs = Date.now() - startTime
  
  // Calculate statistics
  const sortedLatencies = latencies.sort((a, b) => a - b)
  const avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length
  const p95Index = Math.floor(sortedLatencies.length * 0.95)
  const p99Index = Math.floor(sortedLatencies.length * 0.99)
  
  const result: LoadTestResult = {
    name: 'Same Project Concurrency',
    totalRequests: CONFIG.sameProjectConcurrency,
    successful,
    failed,
    refused,
    avgLatencyMs: Math.round(avgLatencyMs),
    p95LatencyMs: sortedLatencies[p95Index] || 0,
    p99LatencyMs: sortedLatencies[p99Index] || 0,
    errorRate: failed / CONFIG.sameProjectConcurrency,
    durationMs,
  }
  
  return result
}

/**
 * Run concurrent mutations across multiple projects
 */
async function testCrossProjectConcurrency(projectIds: string[]): Promise<LoadTestResult> {
  console.log(`[Load Test] Testing ${CONFIG.crossProjectConcurrency} concurrent mutations across projects...`)
  
  const startTime = Date.now()
  const latencies: number[] = []
  let successful = 0
  let failed = 0
  let refused = 0
  
  // Create promises for concurrent mutations across different projects
  const mutations = Array.from({ length: CONFIG.crossProjectConcurrency }, (_, i) => 
    (async () => {
      const projectId = projectIds[i % projectIds.length]
      const mutationStart = Date.now()
      
      try {
        const result = await orchestrateBackendChange(
          `Create table load_test_table_${i}`,
          projectId,
          { forceCommit: true }
        )
        
        const latency = Date.now() - mutationStart
        latencies.push(latency)
        
        if (result.success) {
          successful++
        } else if (result.refusalReason) {
          refused++
        } else {
          failed++
        }
        
        return result
      } catch (error) {
        const latency = Date.now() - mutationStart
        latencies.push(latency)
        failed++
        throw error
      }
    })()
  )
  
  // Run all mutations concurrently
  await Promise.allSettled(mutations)
  
  const durationMs = Date.now() - startTime
  
  // Calculate statistics
  const sortedLatencies = latencies.sort((a, b) => a - b)
  const avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length
  const p95Index = Math.floor(sortedLatencies.length * 0.95)
  const p99Index = Math.floor(sortedLatencies.length * 0.99)
  
  const result: LoadTestResult = {
    name: 'Cross Project Concurrency',
    totalRequests: CONFIG.crossProjectConcurrency,
    successful,
    failed,
    refused,
    avgLatencyMs: Math.round(avgLatencyMs),
    p95LatencyMs: sortedLatencies[p95Index] || 0,
    p99LatencyMs: sortedLatencies[p99Index] || 0,
    errorRate: failed / CONFIG.crossProjectConcurrency,
    durationMs,
  }
  
  return result
}

/**
 * Test advisory-only request load
 */
async function testAdvisoryLoad(projectIds: string[]): Promise<LoadTestResult> {
  console.log(`[Load Test] Testing ${CONFIG.advisoryRequests} advisory requests...`)
  
  const startTime = Date.now()
  const latencies: number[] = []
  let successful = 0
  let failed = 0
  
  // Ensure projects have some data for suggestions
  for (const projectId of projectIds.slice(0, 3)) {
    await orchestrateBackendChange(
      'Create users table with email and name',
      projectId,
      { forceCommit: true }
    )
  }
  
  // Create promises for advisory requests
  const advisoryRequests = Array.from({ length: CONFIG.advisoryRequests }, (_, i) => 
    (async () => {
      const projectId = projectIds[i % projectIds.length]
      const requestStart = Date.now()
      
      try {
        const graph = await getActiveGraph(projectId)
        if (graph) {
          await generateSuggestions(projectId, graph)
        }
        
        const latency = Date.now() - requestStart
        latencies.push(latency)
        successful++
      } catch (error) {
        const latency = Date.now() - requestStart
        latencies.push(latency)
        failed++
      }
    })()
  )
  
  // Run all requests concurrently
  await Promise.allSettled(advisoryRequests)
  
  const durationMs = Date.now() - startTime
  
  // Calculate statistics
  const sortedLatencies = latencies.sort((a, b) => a - b)
  const avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length
  const p95Index = Math.floor(sortedLatencies.length * 0.95)
  const p99Index = Math.floor(sortedLatencies.length * 0.99)
  
  const result: LoadTestResult = {
    name: 'Advisory Load',
    totalRequests: CONFIG.advisoryRequests,
    successful,
    failed,
    refused: 0,
    avgLatencyMs: Math.round(avgLatencyMs),
    p95LatencyMs: sortedLatencies[p95Index] || 0,
    p99LatencyMs: sortedLatencies[p99Index] || 0,
    errorRate: failed / CONFIG.advisoryRequests,
    durationMs,
  }
  
  return result
}

/**
 * Check database connection pool status
 */
async function checkDatabasePool(): Promise<{
  activeConnections: number
  idleConnections: number
  maxConnections: number
}> {
  try {
    // Query PostgreSQL for connection info
    const result = await prisma.$queryRaw<Array<{
      state: string
      count: bigint
    }>>`
      SELECT state, COUNT(*) as count
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY state
    `
    
    const active = result.find(r => r.state === 'active')?.count || 0n
    const idle = result.find(r => r.state === 'idle')?.count || 0n
    
    // Get max connections
    const maxResult = await prisma.$queryRaw<[{ max_connections: bigint }]>`
      SHOW max_connections
    `
    
    return {
      activeConnections: Number(active),
      idleConnections: Number(idle),
      maxConnections: Number(maxResult[0].max_connections),
    }
  } catch (error) {
    console.error('[Load Test] Failed to check DB pool:', error)
    return {
      activeConnections: -1,
      idleConnections: -1,
      maxConnections: -1,
    }
  }
}

/**
 * Print load test results
 */
function printResults(results: LoadTestResult[], dbPool: ReturnType<typeof checkDatabasePool> extends Promise<infer T> ? T : never) {
  console.log('\n' + '='.repeat(80))
  console.log('LOAD TEST RESULTS')
  console.log('='.repeat(80) + '\n')
  
  for (const result of results) {
    console.log(`${result.name}:`)
    console.log(`  Total Requests: ${result.totalRequests}`)
    console.log(`  Successful: ${result.successful} (${((result.successful / result.totalRequests) * 100).toFixed(1)}%)`)
    console.log(`  Failed: ${result.failed} (${((result.failed / result.totalRequests) * 100).toFixed(1)}%)`)
    console.log(`  Refused: ${result.refused} (${((result.refused / result.totalRequests) * 100).toFixed(1)}%)`)
    console.log(`  Error Rate: ${(result.errorRate * 100).toFixed(2)}%`)
    console.log(`  Avg Latency: ${result.avgLatencyMs}ms`)
    console.log(`  P95 Latency: ${result.p95LatencyMs}ms`)
    console.log(`  P99 Latency: ${result.p99LatencyMs}ms`)
    console.log(`  Total Duration: ${result.durationMs}ms`)
    console.log()
  }
  
  console.log('Database Connection Pool:')
  console.log(`  Active: ${dbPool.activeConnections}`)
  console.log(`  Idle: ${dbPool.idleConnections}`)
  console.log(`  Max: ${dbPool.maxConnections}`)
  console.log()
  
  // Pass/fail summary
  console.log('='.repeat(80))
  console.log('PASS/FAIL SUMMARY')
  console.log('='.repeat(80))
  
  let allPassed = true
  
  for (const result of results) {
    const latencyPass = result.p95LatencyMs < CONFIG.maxAcceptableLatencyMs
    const errorRatePass = result.errorRate < CONFIG.maxErrorRate
    const passed = latencyPass && errorRatePass
    
    console.log(`${result.name}: ${passed ? '✅ PASS' : '❌ FAIL'}`)
    if (!latencyPass) {
      console.log(`  - P95 latency ${result.p95LatencyMs}ms exceeds ${CONFIG.maxAcceptableLatencyMs}ms`)
      allPassed = false
    }
    if (!errorRatePass) {
      console.log(`  - Error rate ${(result.errorRate * 100).toFixed(2)}% exceeds ${CONFIG.maxErrorRate * 100}%`)
      allPassed = false
    }
  }
  
  console.log()
  console.log(`Overall: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`)
  console.log('='.repeat(80) + '\n')
  
  return allPassed
}

/**
 * Main load test runner
 */
describe('PHASE 5: Load Testing & Concurrency Validation', () => {
  let context: TestContext
  let results: LoadTestResult[] = []
  let dbPoolInfo: Awaited<ReturnType<typeof checkDatabasePool>>
  
  beforeAll(async () => {
    // Check if we're in integration mode
    if (process.env.ENGINE_MODE !== 'integration') {
      console.log('[Load Test] Skipping load tests - not in integration mode')
      return
    }
    
    context = await setupTestEnvironment()
  }, 60000)
  
  afterAll(async () => {
    if (context?.cleanup) {
      await context.cleanup()
    }
  }, 60000)
  
  it('should handle 50 concurrent mutations on same project', async () => {
    if (process.env.ENGINE_MODE !== 'integration') {
      return
    }
    
    const result = await testSameProjectConcurrency(context.projectIds[0])
    results.push(result)
    
    expect(result.errorRate).toBeLessThan(CONFIG.maxErrorRate)
    expect(result.p95LatencyMs).toBeLessThan(CONFIG.maxAcceptableLatencyMs)
  }, 120000)
  
  it('should handle 100 concurrent mutations across projects', async () => {
    if (process.env.ENGINE_MODE !== 'integration') {
      return
    }
    
    const result = await testCrossProjectConcurrency(context.projectIds)
    results.push(result)
    
    expect(result.errorRate).toBeLessThan(CONFIG.maxErrorRate)
    expect(result.p95LatencyMs).toBeLessThan(CONFIG.maxAcceptableLatencyMs)
  }, 120000)
  
  it('should handle 200 concurrent advisory requests', async () => {
    if (process.env.ENGINE_MODE !== 'integration') {
      return
    }
    
    const result = await testAdvisoryLoad(context.projectIds)
    results.push(result)
    
    expect(result.errorRate).toBeLessThan(CONFIG.maxErrorRate)
    expect(result.p95LatencyMs).toBeLessThan(CONFIG.maxAcceptableLatencyMs)
  }, 120000)
  
  it('should not saturate database connection pool', async () => {
    if (process.env.ENGINE_MODE !== 'integration') {
      return
    }
    
    dbPoolInfo = await checkDatabasePool()
    
    // Should not use more than 80% of max connections
    const usagePercent = dbPoolInfo.activeConnections / dbPoolInfo.maxConnections
    expect(usagePercent).toBeLessThan(0.8)
  })
  
  afterAll(async () => {
    if (results.length > 0) {
      printResults(results, dbPoolInfo)
    }
  })
})
