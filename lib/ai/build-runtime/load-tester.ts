/**
 * PERFORMANCE BENCHMARKER
 * =======================
 * Internal DB/query benchmarks. Replaces the former self-HTTP load tester.
 *
 * The old implementation sent 100 concurrent HTTP requests back to the same
 * server — a textbook self-DoS. This version measures the same thing (backend
 * responsiveness) using internal pg queries with zero network amplification.
 *
 * Measurements:
 *   1. DB connection latency    — time to open a connection + run SELECT 1
 *   2. Query throughput         — timed SELECT on each workspace table (N samples)
 *   3. Concurrent DB access     — run N queries in parallel, measure p50/p95/p99
 *   4. Regression detection     — compare against previous baseline
 *
 * Never makes outbound HTTP requests. Never creates test users.
 */

import { prisma } from '@/lib/db/prisma'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import type { VerificationCheck, VerificationReport } from './verifier'

// ── Config ─────────────────────────────────────────────────────────────────────

const BENCH_CONCURRENCY     = 10   // parallel DB connections (was: 100 HTTP requests)
const SAMPLES_PER_TABLE     = 5    // timing samples per table
const CONN_LATENCY_SAMPLES  = 10   // SELECT 1 samples for connection baseline

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LatencyStats {
  p50: number
  p95: number
  p99: number
  min: number
  max: number
  mean: number
}

export interface EndpointLoadResult {
  /** Query path — e.g. "workspace_abc.users SELECT" — kept for interface compat */
  endpoint: string
  requestCount: number
  successCount: number
  failureCount: number
  failureRate: number
  latency: LatencyStats
  regressionWarning?: string
}

export interface LoadTestBaseline {
  projectId: string
  capturedAt: string
  buildVersion?: string
  endpoints: EndpointLoadResult[]
  overallP95: number
  overallFailureRate: number
}

export interface LoadTestReport extends VerificationReport {
  baseline: LoadTestBaseline
  previousBaseline?: LoadTestBaseline
  regressionDetected: boolean
  regressions: string[]
  endpointResults: EndpointLoadResult[]
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runLoadTestBaseline(
  projectId: string,
  nodeId: string,
  options: { concurrency?: number; requestsPerEndpoint?: number } = {},
): Promise<LoadTestReport> {
  const concurrency    = options.concurrency        ?? BENCH_CONCURRENCY
  const samplesPerObj  = options.requestsPerEndpoint ?? SAMPLES_PER_TABLE

  const schemaName = getWorkspaceDatabaseNames(projectId).postgresSchema
  const tables     = await getProjectTableNames(projectId)
  const results: EndpointLoadResult[] = []

  // 1. Connection latency baseline (SELECT 1 — pure connection timing)
  results.push(await benchConnLatency(CONN_LATENCY_SAMPLES, concurrency))

  // 2. Per-table query timing
  for (const table of tables.slice(0, 5)) {
    results.push(await benchTableQuery(schemaName, table, samplesPerObj, concurrency))
  }

  // 3. Aggregate
  const allP95 = results.filter(r => r.requestCount > 0).map(r => r.latency.p95)
  const overallP95 = allP95.length > 0 ? Math.max(...allP95) : 0
  const overallFailureRate = results.length > 0
    ? results.reduce((s, r) => s + r.failureRate, 0) / results.length
    : 0

  const baseline: LoadTestBaseline = {
    projectId,
    capturedAt: new Date().toISOString(),
    endpoints: results,
    overallP95,
    overallFailureRate,
  }

  // 4. Regression detection
  const previousBaseline = await loadPreviousBaseline(projectId)
  const regressions: string[] = []

  if (previousBaseline) {
    for (const current of results) {
      const prev = previousBaseline.endpoints.find(e => e.endpoint === current.endpoint)
      if (!prev || prev.latency.p95 === 0) continue

      const ratio = current.latency.p95 / prev.latency.p95
      if (ratio > 2.0) {
        current.regressionWarning = `p95 ${current.latency.p95}ms vs prev ${prev.latency.p95}ms (${(ratio * 100).toFixed(0)}%)`
        regressions.push(`${current.endpoint}: ${current.regressionWarning}`)
      }
      if (current.failureRate > prev.failureRate + 0.05) {
        const w = `failure rate ${(current.failureRate * 100).toFixed(1)}% vs prev ${(prev.failureRate * 100).toFixed(1)}%`
        regressions.push(`${current.endpoint}: ${w}`)
      }
    }
  }

  await saveBaseline(projectId, baseline)

  // 5. Checks
  const checks: VerificationCheck[] = [
    {
      label: 'DB connection latency acceptable (< 200ms p95)',
      status: overallP95 < 200 ? 'pass' : overallP95 < 500 ? 'warn' : 'fail',
      detail: `p95 DB latency: ${overallP95}ms across ${results.length} benchmark(s)`,
    },
    {
      label: 'Query execution stable (< 5% failure rate)',
      status: overallFailureRate < 0.05 ? 'pass' : overallFailureRate < 0.15 ? 'warn' : 'fail',
      detail: `Failure rate: ${(overallFailureRate * 100).toFixed(1)}%`,
    },
  ]

  if (previousBaseline) {
    checks.push({
      label: 'No DB performance regression vs previous baseline',
      status: regressions.length === 0 ? 'pass' : 'warn',
      detail: regressions.length === 0
        ? `All queries within 2× of baseline (p95: ${overallP95}ms vs prev ${previousBaseline.overallP95}ms)`
        : regressions.join('; '),
    })
  } else {
    checks.push({
      label: 'Baseline established',
      status: 'pass',
      detail: `First benchmark captured: p95=${overallP95}ms, failure rate=${(overallFailureRate * 100).toFixed(1)}%`,
    })
  }

  const passed = overallFailureRate < 0.15

  return {
    nodeId,
    passed,
    checks,
    summary: passed
      ? `DB bench passed: p95=${overallP95}ms, ${results.length} queries benchmarked, failure rate=${(overallFailureRate * 100).toFixed(1)}%`
      : `DB bench: high failure rate ${(overallFailureRate * 100).toFixed(1)}% — check DB connectivity`,
    baseline,
    previousBaseline: previousBaseline ?? undefined,
    regressionDetected: regressions.length > 0,
    regressions,
    endpointResults: results,
  }
}

/** No-op — kept for interface compatibility (previously cleared HTTP token cache). */
export function clearLoadTestCache(): void {}

// ── Internal benchmarks ───────────────────────────────────────────────────────

/**
 * Benchmark raw DB connection latency by running SELECT 1 N times concurrently.
 */
async function benchConnLatency(
  totalSamples: number,
  concurrency: number,
): Promise<EndpointLoadResult> {
  const latencies: number[] = []
  let failureCount = 0

  for (let sent = 0; sent < totalSamples; sent += concurrency) {
    const batch = Array.from({ length: Math.min(concurrency, totalSamples - sent) }, async () => {
      const start = Date.now()
      try {
        await prisma.$queryRaw`SELECT 1 AS ok`
        latencies.push(Date.now() - start)
      } catch {
        latencies.push(Date.now() - start)
        failureCount++
      }
    })
    await Promise.all(batch)
  }

  const successCount = latencies.length - failureCount
  return {
    endpoint: 'db.connection_latency',
    requestCount: latencies.length,
    successCount,
    failureCount,
    failureRate: latencies.length > 0 ? failureCount / latencies.length : 0,
    latency: computeStats(latencies),
  }
}

/**
 * Benchmark SELECT query timing on a workspace table.
 * Uses EXPLAIN ANALYZE instead of full SELECT to avoid loading real data.
 */
async function benchTableQuery(
  schema: string,
  table: string,
  samples: number,
  concurrency: number,
): Promise<EndpointLoadResult> {
  const latencies: number[] = []
  let failureCount = 0

  for (let sent = 0; sent < samples; sent += concurrency) {
    const batch = Array.from({ length: Math.min(concurrency, samples - sent) }, async () => {
      const start = Date.now()
      try {
        // COUNT(*) is the lightest meaningful query — forces a full table scan
        // measurement without returning actual row data to the application.
        await prisma.$queryRawUnsafe(
          `SELECT COUNT(*) FROM "${schema}"."${table}" LIMIT 1`,
        )
        latencies.push(Date.now() - start)
      } catch {
        latencies.push(Date.now() - start)
        failureCount++
      }
    })
    await Promise.all(batch)
  }

  const successCount = latencies.length - failureCount
  return {
    endpoint: `${schema}.${table} SELECT`,
    requestCount: latencies.length,
    successCount,
    failureCount,
    failureRate: latencies.length > 0 ? failureCount / latencies.length : 0,
    latency: computeStats(latencies),
  }
}

// ── Stats ──────────────────────────────────────────────────────────────────────

function computeStats(latencies: number[]): LatencyStats {
  if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 }

  const sorted = [...latencies].sort((a, b) => a - b)
  const len    = sorted.length
  const pct    = (p: number) => sorted[Math.floor((p / 100) * len)] ?? sorted[len - 1]

  return {
    p50:  pct(50),
    p95:  pct(95),
    p99:  pct(99),
    min:  sorted[0],
    max:  sorted[len - 1],
    mean: Math.round(sorted.reduce((s, v) => s + v, 0) / len),
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────

const BASELINE_KEY = 'perf_bench_baseline'

async function saveBaseline(projectId: string, baseline: LoadTestBaseline): Promise<void> {
  try {
    const existing = await prisma.aiConfiguration.findUnique({
      where: { projectId },
      select: { config: true },
    })
    const cfg = (existing?.config as Record<string, unknown> | null) ?? {}
    await prisma.aiConfiguration.upsert({
      where: { projectId },
      update: { config: { ...cfg, [BASELINE_KEY]: baseline } as any },
      create: { projectId, config: { [BASELINE_KEY]: baseline } as any },
    })
  } catch { /* non-fatal — baseline is best-effort */ }
}

async function loadPreviousBaseline(projectId: string): Promise<LoadTestBaseline | null> {
  try {
    const config = await prisma.aiConfiguration.findUnique({
      where: { projectId },
      select: { config: true },
    })
    return ((config?.config as any)?.[BASELINE_KEY] as LoadTestBaseline) ?? null
  } catch {
    return null
  }
}

async function getProjectTableNames(projectId: string): Promise<string[]> {
  try {
    const tables = await prisma.table.findMany({
      where: { projectId },
      select: { name: true },
      orderBy: { createdAt: 'asc' },
    })
    return tables.map(t => t.name)
  } catch {
    return []
  }
}
