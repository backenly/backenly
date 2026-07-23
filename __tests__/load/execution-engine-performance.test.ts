/**
 * Execution Engine Performance Test
 * 
 * PURPOSE: Test ONLY the execution engine performance, NOT AI planning
 * 
 * CRITICAL DISTINCTION:
 * - This test measures execution engine latency (target: <500ms)
 * - Uses ENGINE_MODE=integration to bypass LLM calls
 * - Different from full pipeline tests which include AI planning (~20s+)
 * 
 * Tests:
 * - 50 concurrent mutations on same project
 * - 100 concurrent mutations across projects
 * - Verifies <500ms execution latency
 */

import { orchestrateBackendChange, getActiveGraph } from '@/lib/orchestration'
import { prisma } from '@/lib/db/prisma'

// Set integration mode to bypass LLM/AI planning
process.env.ENGINE_MODE = 'integration'

const CONFIG = {
  sameProjectConcurrency: 50,
  crossProjectConcurrency: 100,
  maxAcceptableLatencyMs: 500, // Target for execution engine only
  maxErrorRate: 0.05, // 5%
}

interface PerformanceResult {
  name: string
  totalRequests: number
  successful: number
  failed: number
  avgLatencyMs: number
  p95LatencyMs: number
  p99LatencyMs: number
  maxLatencyMs: number
  errorRate: number
  durationMs: number
}

describe('Execution Engine Performance Tests', () => {
  let testProjectIds: string[] = []
  let testUserId: string

  beforeAll(async () => {
    console.log('\n[Execution Performance] Setting up test environment...')
    
    // Create test user
    const testUser = await prisma.user.upsert({
      where: { email: 'execution-perf@backenly.test' },
      update: {},
      create: {
        email: 'execution-perf@backenly.test',
        name: 'Execution Performance Test User',
      },
    })
    testUserId = testUser.id
    
    // Create test projects
    for (let i = 0; i < 10; i++) {
      const project = await prisma.project.create({
        data: {
          name: `ExecPerfProject_${i}_${Date.now()}`,
          userId: testUserId,
          description: 'Execution performance testing',
        },
      })
      testProjectIds.push(project.id)
    }
    
    console.log(`[Execution Performance] Created ${testProjectIds.length} test projects`)
  })

  afterAll(async () => {
    console.log('\n[Execution Performance] Cleaning up...')
    for (const projectId of testProjectIds) {
      await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
    }
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {})
  })

  /**
   * TEST 1: Same Project Concurrency - Execution Engine Only
   * 
   * Measures how fast the execution engine can process mutations
   * WITHOUT AI planning overhead
   */
  it('TEST 1: 50 concurrent mutations on same project (execution engine only)', async () => {
    console.log('\n[TEST 1] Testing same-project concurrency (execution engine)...')
    
    const projectId = testProjectIds[0]
    const startTime = Date.now()
    const latencies: number[] = []
    let successful = 0
    let failed = 0
    
    // Create base table first
    await orchestrateBackendChange(
      'Create users table with email and name',
      projectId,
      { forceCommit: true }
    )
    
    // Create concurrent mutations
    const mutations = Array.from({ length: CONFIG.sameProjectConcurrency }, (_, i) => 
      (async () => {
        const mutationStart = Date.now()
        try {
          const result = await orchestrateBackendChange(
            `Add field exec_test_${i} to users table`,
            projectId,
            { forceCommit: true }
          )
          
          const latency = Date.now() - mutationStart
          latencies.push(latency)
          
          if (result.success) {
            successful++
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
    const avgLatencyMs = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    const p95Index = Math.floor(sortedLatencies.length * 0.95)
    const p99Index = Math.floor(sortedLatencies.length * 0.99)
    const maxLatencyMs = sortedLatencies[sortedLatencies.length - 1] || 0
    
    const result: PerformanceResult = {
      name: 'Same Project - Execution Engine',
      totalRequests: CONFIG.sameProjectConcurrency,
      successful,
      failed,
      avgLatencyMs,
      p95LatencyMs: sortedLatencies[p95Index] || 0,
      p99LatencyMs: sortedLatencies[p99Index] || 0,
      maxLatencyMs,
      errorRate: failed / CONFIG.sameProjectConcurrency,
      durationMs,
    }
    
    // Print results
    console.log('\n[TEST 1] Results:')
    console.log(`  Total Requests: ${result.totalRequests}`)
    console.log(`  Successful: ${result.successful}`)
    console.log(`  Failed: ${result.failed}`)
    console.log(`  Avg Latency: ${result.avgLatencyMs}ms`)
    console.log(`  P95 Latency: ${result.p95LatencyMs}ms`)
    console.log(`  P99 Latency: ${result.p99LatencyMs}ms`)
    console.log(`  Max Latency: ${result.maxLatencyMs}ms`)
    console.log(`  Error Rate: ${(result.errorRate * 100).toFixed(2)}%`)
    console.log(`  Duration: ${result.durationMs}ms`)
    
    // Assertions for execution engine performance
    expect(result.successful).toBeGreaterThan(0)
    expect(result.errorRate).toBeLessThan(CONFIG.maxErrorRate)
    
    // CRITICAL: Execution engine should be fast (<500ms avg)
    // NOTE: This measures EXECUTION ONLY, not AI planning
    expect(result.avgLatencyMs).toBeLessThan(CONFIG.maxAcceptableLatencyMs)
    expect(result.p95LatencyMs).toBeLessThan(CONFIG.maxAcceptableLatencyMs * 2)
    
    console.log('\n✅ TEST 1 PASS: Execution engine performance verified')
  }, 120000) // 2 minute timeout

  /**
   * TEST 2: Cross-Project Concurrency - Execution Engine Only
   * 
   * Measures execution engine performance across multiple projects
   */
  it('TEST 2: 100 concurrent mutations across projects (execution engine only)', async () => {
    console.log('\n[TEST 2] Testing cross-project concurrency (execution engine)...')
    
    const startTime = Date.now()
    const latencies: number[] = []
    let successful = 0
    let failed = 0
    
    // Setup: Create base table in each project
    for (const projectId of testProjectIds) {
      await orchestrateBackendChange(
        'Create products table with name and price',
        projectId,
        { forceCommit: true }
      )
    }
    
    // Create concurrent mutations across projects
    const mutations = Array.from({ length: CONFIG.crossProjectConcurrency }, (_, i) => 
      (async () => {
        const projectId = testProjectIds[i % testProjectIds.length]
        const mutationStart = Date.now()
        
        try {
          const result = await orchestrateBackendChange(
            `Add field cross_test_${i} to products table`,
            projectId,
            { forceCommit: true }
          )
          
          const latency = Date.now() - mutationStart
          latencies.push(latency)
          
          if (result.success) {
            successful++
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
    const avgLatencyMs = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    const p95Index = Math.floor(sortedLatencies.length * 0.95)
    const p99Index = Math.floor(sortedLatencies.length * 0.99)
    const maxLatencyMs = sortedLatencies[sortedLatencies.length - 1] || 0
    
    const result: PerformanceResult = {
      name: 'Cross Project - Execution Engine',
      totalRequests: CONFIG.crossProjectConcurrency,
      successful,
      failed,
      avgLatencyMs,
      p95LatencyMs: sortedLatencies[p95Index] || 0,
      p99LatencyMs: sortedLatencies[p99Index] || 0,
      maxLatencyMs,
      errorRate: failed / CONFIG.crossProjectConcurrency,
      durationMs,
    }
    
    // Print results
    console.log('\n[TEST 2] Results:')
    console.log(`  Total Requests: ${result.totalRequests}`)
    console.log(`  Successful: ${result.successful}`)
    console.log(`  Failed: ${result.failed}`)
    console.log(`  Avg Latency: ${result.avgLatencyMs}ms`)
    console.log(`  P95 Latency: ${result.p95LatencyMs}ms`)
    console.log(`  P99 Latency: ${result.p99LatencyMs}ms`)
    console.log(`  Max Latency: ${result.maxLatencyMs}ms`)
    console.log(`  Error Rate: ${(result.errorRate * 100).toFixed(2)}%`)
    console.log(`  Duration: ${result.durationMs}ms`)
    
    // Assertions for execution engine performance
    expect(result.successful).toBeGreaterThan(0)
    expect(result.errorRate).toBeLessThan(CONFIG.maxErrorRate)
    
    // CRITICAL: Execution engine should be fast (<500ms avg)
    expect(result.avgLatencyMs).toBeLessThan(CONFIG.maxAcceptableLatencyMs)
    expect(result.p95LatencyMs).toBeLessThan(CONFIG.maxAcceptableLatencyMs * 2)
    
    console.log('\n✅ TEST 2 PASS: Cross-project execution engine performance verified')
  }, 180000) // 3 minute timeout

  /**
   * TEST 3: Verify Integration Mode is Active
   * 
   * Sanity check that we're actually bypassing AI planning
   */
  it('TEST 3: Verify integration mode bypasses AI planning', async () => {
    console.log('\n[TEST 3] Verifying integration mode...')
    
    const projectId = testProjectIds[2]
    const startTime = Date.now()
    
    const result = await orchestrateBackendChange(
      'Create orders table with status and total',
      projectId,
      { forceCommit: true }
    )
    
    const latency = Date.now() - startTime
    
    console.log(`  Single mutation latency: ${latency}ms`)
    console.log(`  Success: ${result.success}`)
    
    // In integration mode, single mutation should be very fast (<2s)
    expect(latency).toBeLessThan(2000)
    expect(result.success).toBe(true)
    
    // Verify table was created
    const graph = await getActiveGraph(projectId)
    expect(graph?.entities.orders).toBeDefined()
    
    console.log('\n✅ TEST 3 PASS: Integration mode is active and bypassing AI')
  }, 30000)
})
