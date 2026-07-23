#!/usr/bin/env ts-node
/**
 * Standalone Load Test Script
 * 
 * Run: npx ts-node scripts/load-test.ts
 * 
 * This script runs load tests outside of Jest for:
 * - Longer duration tests
 * - Custom concurrency levels
 * - Production-like scenarios
 */

import { orchestrateBackendChange, getActiveGraph } from '../lib/orchestration'
import { generateSuggestions } from '../lib/suggestions/suggestion-engine'
import { prisma } from '../lib/db/prisma'

interface LoadTestConfig {
  sameProjectConcurrency: number
  crossProjectConcurrency: number
  advisoryRequests: number
  maxAcceptableLatencyMs: number
  maxErrorRate: number
}

const DEFAULT_CONFIG: LoadTestConfig = {
  sameProjectConcurrency: 50,
  crossProjectConcurrency: 100,
  advisoryRequests: 200,
  maxAcceptableLatencyMs: 500,
  maxErrorRate: 0.05,
}

interface TestResult {
  name: string
  total: number
  success: number
  failed: number
  refused: number
  avgLatency: number
  p95Latency: number
  p99Latency: number
  duration: number
  errorRate: number
}

async function runLoadTest(config: LoadTestConfig = DEFAULT_CONFIG) {
  console.log('\n' + '='.repeat(80))
  console.log('BACKENLY LOAD TEST')
  console.log('='.repeat(80))
  console.log(`Configuration:`)
  console.log(`  Same Project Concurrency: ${config.sameProjectConcurrency}`)
  console.log(`  Cross Project Concurrency: ${config.crossProjectConcurrency}`)
  console.log(`  Advisory Requests: ${config.advisoryRequests}`)
  console.log(`  Max Acceptable Latency: ${config.maxAcceptableLatencyMs}ms`)
  console.log(`  Max Error Rate: ${config.maxErrorRate * 100}%`)
  console.log('='.repeat(80) + '\n')

  // Create test projects
  console.log('[Setup] Creating test projects...')
  const projectIds: string[] = []
  for (let i = 0; i < 10; i++) {
    const project = await prisma.project.create({
      data: {
        name: `LoadTest_${Date.now()}_${i}`,
        userId: 'load-test-user',
        description: 'Load testing project',
      },
    })
    projectIds.push(project.id)
  }
  console.log(`[Setup] Created ${projectIds.length} projects\n`)

  const results: TestResult[] = []

  // Test 1: Same project concurrency
  console.log(`[Test 1] ${config.sameProjectConcurrency} concurrent mutations on same project...`)
  const test1Start = Date.now()
  const test1Latencies: number[] = []
  let test1Success = 0, test1Failed = 0, test1Refused = 0

  const test1Promises = Array.from({ length: config.sameProjectConcurrency }, (_, i) =>
    (async () => {
      const start = Date.now()
      try {
        const result = await orchestrateBackendChange(
          `Add field test_${i} to users`,
          projectIds[0],
          { forceCommit: true }
        )
        const latency = Date.now() - start
        test1Latencies.push(latency)
        if (result.success) test1Success++
        else if (result.refusalReason) test1Refused++
        else test1Failed++
      } catch (error) {
        test1Latencies.push(Date.now() - start)
        test1Failed++
      }
    })()
  )

  await Promise.allSettled(test1Promises)
  
  const test1Sorted = test1Latencies.sort((a, b) => a - b)
  results.push({
    name: 'Same Project Concurrency',
    total: config.sameProjectConcurrency,
    success: test1Success,
    failed: test1Failed,
    refused: test1Refused,
    avgLatency: Math.round(test1Latencies.reduce((a, b) => a + b, 0) / test1Latencies.length),
    p95Latency: test1Sorted[Math.floor(test1Sorted.length * 0.95)],
    p99Latency: test1Sorted[Math.floor(test1Sorted.length * 0.99)],
    duration: Date.now() - test1Start,
    errorRate: test1Failed / config.sameProjectConcurrency,
  })

  // Test 2: Cross project concurrency
  console.log(`[Test 2] ${config.crossProjectConcurrency} concurrent mutations across projects...`)
  const test2Start = Date.now()
  const test2Latencies: number[] = []
  let test2Success = 0, test2Failed = 0, test2Refused = 0

  const test2Promises = Array.from({ length: config.crossProjectConcurrency }, (_, i) =>
    (async () => {
      const start = Date.now()
      try {
        const result = await orchestrateBackendChange(
          `Create table test_table_${i}`,
          projectIds[i % projectIds.length],
          { forceCommit: true }
        )
        const latency = Date.now() - start
        test2Latencies.push(latency)
        if (result.success) test2Success++
        else if (result.refusalReason) test2Refused++
        else test2Failed++
      } catch (error) {
        test2Latencies.push(Date.now() - start)
        test2Failed++
      }
    })()
  )

  await Promise.allSettled(test2Promises)
  
  const test2Sorted = test2Latencies.sort((a, b) => a - b)
  results.push({
    name: 'Cross Project Concurrency',
    total: config.crossProjectConcurrency,
    success: test2Success,
    failed: test2Failed,
    refused: test2Refused,
    avgLatency: Math.round(test2Latencies.reduce((a, b) => a + b, 0) / test2Latencies.length),
    p95Latency: test2Sorted[Math.floor(test2Sorted.length * 0.95)],
    p99Latency: test2Sorted[Math.floor(test2Sorted.length * 0.99)],
    duration: Date.now() - test2Start,
    errorRate: test2Failed / config.crossProjectConcurrency,
  })

  // Test 3: Advisory load
  console.log(`[Test 3] ${config.advisoryRequests} advisory requests...`)
  
  // Seed data for suggestions
  for (const pid of projectIds.slice(0, 3)) {
    await orchestrateBackendChange('Create users table with email', pid, { forceCommit: true })
  }
  
  const test3Start = Date.now()
  const test3Latencies: number[] = []
  let test3Success = 0, test3Failed = 0

  const test3Promises = Array.from({ length: config.advisoryRequests }, (_, i) =>
    (async () => {
      const start = Date.now()
      try {
        const graph = await getActiveGraph(projectIds[i % projectIds.length])
        if (graph) await generateSuggestions(projectIds[i % projectIds.length], graph)
        test3Latencies.push(Date.now() - start)
        test3Success++
      } catch (error) {
        test3Latencies.push(Date.now() - start)
        test3Failed++
      }
    })()
  )

  await Promise.allSettled(test3Promises)
  
  const test3Sorted = test3Latencies.sort((a, b) => a - b)
  results.push({
    name: 'Advisory Load',
    total: config.advisoryRequests,
    success: test3Success,
    failed: test3Failed,
    refused: 0,
    avgLatency: Math.round(test3Latencies.reduce((a, b) => a + b, 0) / test3Latencies.length),
    p95Latency: test3Sorted[Math.floor(test3Sorted.length * 0.95)],
    p99Latency: test3Sorted[Math.floor(test3Sorted.length * 0.99)],
    duration: Date.now() - test3Start,
    errorRate: test3Failed / config.advisoryRequests,
  })

  // Print results
  console.log('\n' + '='.repeat(80))
  console.log('RESULTS')
  console.log('='.repeat(80) + '\n')

  let allPassed = true
  for (const r of results) {
    console.log(`${r.name}:`)
    console.log(`  Success: ${r.success}/${r.total} (${((r.success/r.total)*100).toFixed(1)}%)`)
    console.log(`  Failed: ${r.failed}/${r.total} (${((r.failed/r.total)*100).toFixed(1)}%)`)
    console.log(`  Refused: ${r.refused}/${r.total} (${((r.refused/r.total)*100).toFixed(1)}%)`)
    console.log(`  Avg Latency: ${r.avgLatency}ms`)
    console.log(`  P95 Latency: ${r.p95Latency}ms`)
    console.log(`  P99 Latency: ${r.p99Latency}ms`)
    console.log(`  Duration: ${r.duration}ms`)
    
    const latencyPass = r.p95Latency < config.maxAcceptableLatencyMs
    const errorPass = r.errorRate < config.maxErrorRate
    const passed = latencyPass && errorPass
    
    console.log(`  Status: ${passed ? '✅ PASS' : '❌ FAIL'}`)
    if (!latencyPass) console.log(`    - P95 latency exceeds ${config.maxAcceptableLatencyMs}ms`)
    if (!errorPass) console.log(`    - Error rate exceeds ${config.maxErrorRate * 100}%`)
    console.log()
    
    if (!passed) allPassed = false
  }

  // Cleanup
  console.log('[Cleanup] Removing test projects...')
  for (const pid of projectIds) {
    await prisma.project.delete({ where: { id: pid } }).catch(() => {})
  }

  console.log('='.repeat(80))
  console.log(`OVERALL: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`)
  console.log('='.repeat(80) + '\n')

  process.exit(allPassed ? 0 : 1)
}

// Run if called directly
if (require.main === module) {
  runLoadTest().catch(error => {
    console.error('Load test failed:', error)
    process.exit(1)
  })
}

export { runLoadTest }
