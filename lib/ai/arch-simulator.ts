// lib/ai/arch-simulator.ts
/**
 * ARCH SIMULATOR — Predictive Infrastructure Modeling
 * =====================================================
 * "If this app hits 100k users, your order table becomes bottlenecked."
 *
 * Flow:
 *   1. Load project memory for table list
 *   2. Query live row counts from workspace schema via pg_stat_user_tables
 *   3. Parse scenarioInput into a SimulationScenario
 *   4. Run heuristic bottleneck detection (no LLM — fast path)
 *   5. Call OpenAI for deeper SQL-level analysis
 *   6. Merge + deduplicate bottlenecks from both sources
 *   7. Compute overallRiskScore, return SimulationResult
 *
 * Never throws — all errors are caught and surfaced in result.summary.
 */

import OpenAI from 'openai'
import { Pool } from 'pg'
import { loadProjectMemory } from '@/lib/ai/project-memory'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'

// ── Public types ─────────────────────────────────────────────────────────────

export interface SimulationScenario {
  type: 'user_scale' | 'traffic_spike' | 'data_growth' | 'feature_expansion'
  label: string
  multiplier: number
  timeframeMonths: number
}

export interface Bottleneck {
  table: string
  type:
    | 'table_size'
    | 'query_throughput'
    | 'connection_pool'
    | 'lock_contention'
    | 'index_scan'
    | 'join_explosion'
  severity: 'critical' | 'high' | 'medium'
  currentEstimate: string
  projectedAt: string
  recommendation: string
  sqlFix?: string
}

export interface SimulationResult {
  projectId: string
  scenario: SimulationScenario
  simulatedAt: string
  bottlenecks: Bottleneck[]
  overallRiskScore: number
  infrastructureRecommendations: string[]
  estimatedCostImpact: string
  migrationPath: string[]
  summary: string
}

// ── Preset scenarios ─────────────────────────────────────────────────────────

export function getPresetScenarios(): SimulationScenario[] {
  return [
    {
      type: 'user_scale',
      label: '100k users',
      multiplier: 100,
      timeframeMonths: 12,
    },
    {
      type: 'traffic_spike',
      label: '10x traffic spike',
      multiplier: 10,
      timeframeMonths: 1,
    },
    {
      type: 'data_growth',
      label: 'Viral growth — 1M rows',
      multiplier: 50,
      timeframeMonths: 3,
    },
    {
      type: 'user_scale',
      label: 'Enterprise scale',
      multiplier: 500,
      timeframeMonths: 24,
    },
  ]
}

// ── Scenario parser ───────────────────────────────────────────────────────────

function parseScenario(input: string): SimulationScenario {
  const lower = input.toLowerCase().trim()

  if (/100k|100,000|hundred.?thousand/.test(lower)) {
    return { type: 'user_scale', label: '100k users', multiplier: 100, timeframeMonths: 12 }
  }
  if (/viral|black.?friday/.test(lower)) {
    return { type: 'traffic_spike', label: 'Viral / Black Friday spike', multiplier: 50, timeframeMonths: 1 }
  }
  if (/1m|1 million|million rows|1,000,000/.test(lower)) {
    return { type: 'data_growth', label: 'Viral growth — 1M rows', multiplier: 20, timeframeMonths: 12 }
  }
  if (/enterprise|500x/.test(lower)) {
    return { type: 'user_scale', label: 'Enterprise scale', multiplier: 500, timeframeMonths: 24 }
  }
  // Generic "Nx" multiplier
  const nxMatch = lower.match(/(\d+)x/)
  if (nxMatch) {
    const multiplier = parseInt(nxMatch[1], 10)
    return {
      type: 'traffic_spike',
      label: `${multiplier}x traffic`,
      multiplier,
      timeframeMonths: 6,
    }
  }
  if (/1 year|12 month/.test(lower)) {
    return { type: 'data_growth', label: '1-year data growth', multiplier: 20, timeframeMonths: 12 }
  }
  // Default
  return { type: 'traffic_spike', label: '10x traffic spike', multiplier: 10, timeframeMonths: 6 }
}

// ── Row count query ───────────────────────────────────────────────────────────

interface TableStat {
  tablename: string
  n_live_tup: number
}

async function fetchTableStats(schemaName: string): Promise<TableStat[]> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
  try {
    const result = await pool.query<TableStat>(
      `SELECT tablename, n_live_tup::int
         FROM pg_stat_user_tables
        WHERE schemaname = $1`,
      [schemaName],
    )
    return result.rows
  } finally {
    await pool.end()
  }
}

// ── Heuristic bottleneck detection ───────────────────────────────────────────

const PARTITION_TABLES = ['events', 'logs', 'activities', 'notifications', 'audit_logs', 'audit', 'metrics']
const HIGH_WRITE_TABLES = ['orders', 'payments', 'transactions', 'invoices', 'charges']

function heuristicBottlenecks(stats: TableStat[], scenario: SimulationScenario): Bottleneck[] {
  const results: Bottleneck[] = []
  const { multiplier } = scenario

  for (const row of stats) {
    const { tablename, n_live_tup } = row
    const projected = n_live_tup * multiplier

    // Large tables under high-scale scenarios
    if (n_live_tup > 10_000 && multiplier > 10) {
      results.push({
        table: tablename,
        type: 'table_size',
        severity: projected > 50_000_000 ? 'critical' : projected > 5_000_000 ? 'high' : 'medium',
        currentEstimate: `~${fmtNum(n_live_tup)} rows today`,
        projectedAt: `~${fmtNum(projected)} rows at ${multiplier}x scale`,
        recommendation: `Add composite indexes and consider table partitioning for ${tablename}.`,
        sqlFix: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tablename}_created
  ON "${tablename}" (created_at DESC);`,
      })
    }

    // Junction / join tables (name contains underscore, commonly pivot tables)
    if (tablename.includes('_') && !tablename.startsWith('_') && multiplier > 5) {
      results.push({
        table: tablename,
        type: 'join_explosion',
        severity: 'medium',
        currentEstimate: `~${fmtNum(n_live_tup)} rows`,
        projectedAt: `~${fmtNum(projected)} rows — joins become expensive`,
        recommendation: `Materialised views or denormalisation may be needed on ${tablename} under heavy join load.`,
      })
    }

    // Event/log tables — always flag for partitioning regardless of count
    if (PARTITION_TABLES.some(name => tablename === name || tablename.startsWith(name + '_'))) {
      const alreadyAdded = results.find(b => b.table === tablename && b.type === 'table_size')
      if (!alreadyAdded) {
        results.push({
          table: tablename,
          type: 'table_size',
          severity: 'high',
          currentEstimate: `~${fmtNum(n_live_tup)} rows — unbounded append table`,
          projectedAt: `~${fmtNum(projected)} rows — without partitioning, sequential scans will dominate`,
          recommendation: `Partition ${tablename} by time (e.g. monthly) to keep per-partition size bounded.`,
          sqlFix: `-- Partition ${tablename} by created_at (PostgreSQL 10+)
CREATE TABLE "${tablename}_y2024_m01" PARTITION OF "${tablename}"
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');`,
        })
      }
    }
  }

  // Connection pool exhaustion
  if (multiplier > 20) {
    results.push({
      table: '(global)',
      type: 'connection_pool',
      severity: 'medium',
      currentEstimate: 'Current pool likely sized for dev/small traffic',
      projectedAt: `At ${multiplier}x concurrent users, default pool (10 conns) will exhaust`,
      recommendation:
        'Configure PgBouncer connection pooler. Target: max_connections / (num_app_instances * pool_size) headroom.',
    })
  }

  // Lock contention on high-write tables
  if (multiplier > 50) {
    for (const row of stats) {
      if (HIGH_WRITE_TABLES.some(n => row.tablename === n || row.tablename.startsWith(n + 's'))) {
        results.push({
          table: row.tablename,
          type: 'lock_contention',
          severity: 'critical',
          currentEstimate: `~${fmtNum(row.n_live_tup)} rows, moderate write volume now`,
          projectedAt: `At ${multiplier}x, row-level locks on ${row.tablename} will cascade into deadlocks`,
          recommendation: `Use SELECT FOR UPDATE SKIP LOCKED for queue-style operations. Consider partitioning by status or date.`,
          sqlFix: `-- Queue-safe pattern
SELECT * FROM "${row.tablename}"
  WHERE status = 'pending'
  ORDER BY created_at
  LIMIT 10
  FOR UPDATE SKIP LOCKED;`,
        })
      }
    }
  }

  return results
}

// ── OpenAI deep analysis ──────────────────────────────────────────────────────

interface LLMBottleneck {
  table: string
  type: string
  severity: string
  currentEstimate: string
  projectedAt: string
  recommendation: string
  sqlFix?: string
}

interface LLMAnalysis {
  bottlenecks: LLMBottleneck[]
  infrastructureRecommendations: string[]
  estimatedCostImpact: string
  migrationPath: string[]
  summary: string
}

async function llmAnalysis(
  tableStats: TableStat[],
  scenario: SimulationScenario,
): Promise<LLMAnalysis> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'

  const tableList = tableStats
    .map(t => `${t.tablename} (${fmtNum(t.n_live_tup)} rows)`)
    .join(', ')

  const systemPrompt = `You are a senior database architect specialising in PostgreSQL performance at scale.
Analyse the provided schema under the given load scenario.
Return ONLY valid JSON with this exact shape:
{
  "bottlenecks": [
    {
      "table": "<table name or (global)>",
      "type": "<table_size|query_throughput|connection_pool|lock_contention|index_scan|join_explosion>",
      "severity": "<critical|high|medium>",
      "currentEstimate": "<short estimate string>",
      "projectedAt": "<projection at scale>",
      "recommendation": "<concrete action>",
      "sqlFix": "<optional SQL snippet>"
    }
  ],
  "infrastructureRecommendations": ["<string>"],
  "estimatedCostImpact": "<e.g. 2-3x current DB cost>",
  "migrationPath": ["<ordered step>"],
  "summary": "<2-3 sentences for the CTO brief>"
}`

  const userPrompt = `Schema tables: ${tableList || '(no tables yet)'}.
Scenario: ${scenario.label} (${scenario.multiplier}x scale, ${scenario.timeframeMonths} months).
Identify the top performance bottlenecks and provide concrete SQL fixes where applicable.
Focus on the most impactful issues only.`

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 1500,
    temperature: 0.2,
    response_format: { type: 'json_object' },
  })

  const raw = response.choices[0]?.message?.content ?? '{}'
  return JSON.parse(raw) as LLMAnalysis
}

// ── Merge + deduplicate bottlenecks ──────────────────────────────────────────

function mergeBottlenecks(heuristic: Bottleneck[], llm: Bottleneck[]): Bottleneck[] {
  const seen = new Set<string>()
  const merged: Bottleneck[] = []

  for (const b of [...heuristic, ...llm]) {
    const key = `${b.table}:${b.type}`
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(b)
    }
  }

  // Sort: critical first, then high, then medium
  const order = { critical: 0, high: 1, medium: 2 }
  merged.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))

  return merged
}

// ── Risk score ────────────────────────────────────────────────────────────────

function computeRiskScore(bottlenecks: Bottleneck[]): number {
  let score = 0
  for (const b of bottlenecks) {
    if (b.severity === 'critical') score += 25
    else if (b.severity === 'high') score += 15
    else score += 8
  }
  return Math.min(score, 100)
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function simulateScenario(
  projectId: string,
  scenarioInput: string,
): Promise<SimulationResult> {
  const simulatedAt = new Date().toISOString()
  const scenario = parseScenario(scenarioInput || '10x traffic')

  try {
    // 1. Load project memory for table context
    const memory = await loadProjectMemory(projectId)
    const knownTables = memory.builtSoFar ?? []

    // 2. Query live row counts
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    let tableStats: TableStat[] = []
    try {
      tableStats = await fetchTableStats(postgresSchema)
    } catch (dbErr: any) {
      console.warn('[ArchSimulator] Could not fetch table stats:', dbErr?.message)
      // Fall back to synthetic stats from memory
      tableStats = knownTables.map(t => ({ tablename: t, n_live_tup: 0 }))
    }

    // 3. Heuristic bottleneck detection (fast, no LLM)
    const heuristic = heuristicBottlenecks(tableStats, scenario)

    // 4. LLM deep analysis
    let llmResult: LLMAnalysis = {
      bottlenecks: [],
      infrastructureRecommendations: [],
      estimatedCostImpact: 'Unknown',
      migrationPath: [],
      summary: '',
    }
    try {
      llmResult = await llmAnalysis(tableStats, scenario)
    } catch (llmErr: any) {
      console.warn('[ArchSimulator] LLM analysis failed (using heuristics only):', llmErr?.message)
    }

    // 5. Normalise LLM bottlenecks to Bottleneck shape
    const llmBottlenecks: Bottleneck[] = (llmResult.bottlenecks ?? []).map(b => ({
      table: String(b.table ?? '(global)'),
      type: isValidBottleneckType(b.type) ? b.type : 'query_throughput',
      severity: isValidSeverity(b.severity) ? b.severity : 'medium',
      currentEstimate: String(b.currentEstimate ?? ''),
      projectedAt: String(b.projectedAt ?? ''),
      recommendation: String(b.recommendation ?? ''),
      sqlFix: b.sqlFix ? String(b.sqlFix) : undefined,
    }))

    // 6. Merge
    const bottlenecks = mergeBottlenecks(heuristic, llmBottlenecks)

    // 7. Assemble result
    const overallRiskScore = computeRiskScore(bottlenecks)

    const infrastructureRecommendations =
      llmResult.infrastructureRecommendations?.length
        ? llmResult.infrastructureRecommendations
        : defaultRecommendations(scenario)

    const migrationPath =
      llmResult.migrationPath?.length
        ? llmResult.migrationPath
        : defaultMigrationPath(scenario)

    const estimatedCostImpact =
      llmResult.estimatedCostImpact || estimateCost(scenario.multiplier)

    const summary =
      llmResult.summary ||
      `At ${scenario.multiplier}x scale your backend will face ${bottlenecks.filter(b => b.severity === 'critical').length} critical bottlenecks. ` +
      `Overall infrastructure risk is scored at ${overallRiskScore}/100. ` +
      `Follow the migration path to prepare before growth occurs.`

    return {
      projectId,
      scenario,
      simulatedAt,
      bottlenecks,
      overallRiskScore,
      infrastructureRecommendations,
      estimatedCostImpact,
      migrationPath,
      summary,
    }
  } catch (err: any) {
    console.error('[ArchSimulator] Unexpected error:', err?.message)
    return {
      projectId,
      scenario,
      simulatedAt,
      bottlenecks: [],
      overallRiskScore: 0,
      infrastructureRecommendations: [],
      estimatedCostImpact: 'Unable to estimate',
      migrationPath: [],
      summary: `Simulation failed: ${err?.message ?? 'unknown error'}. Please retry.`,
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function isValidBottleneckType(t: any): t is Bottleneck['type'] {
  return [
    'table_size', 'query_throughput', 'connection_pool',
    'lock_contention', 'index_scan', 'join_explosion',
  ].includes(t)
}

function isValidSeverity(s: any): s is Bottleneck['severity'] {
  return ['critical', 'high', 'medium'].includes(s)
}

function defaultRecommendations(scenario: SimulationScenario): string[] {
  const recs = [
    'Add read replicas to offload SELECT-heavy workloads.',
    'Enable connection pooling with PgBouncer (target: transaction mode).',
    'Review EXPLAIN ANALYZE output for sequential scans on large tables.',
  ]
  if (scenario.multiplier >= 50) {
    recs.push('Consider horizontal sharding for the highest-write tables.')
    recs.push('Move time-series / append-only data to TimescaleDB or a dedicated event store.')
  }
  return recs
}

function defaultMigrationPath(scenario: SimulationScenario): string[] {
  return [
    'Step 1: Add indexes on foreign keys and commonly-filtered columns.',
    'Step 2: Enable autovacuum tuning (vacuum_cost_delay, autovacuum_vacuum_scale_factor).',
    'Step 3: Deploy PgBouncer in front of the primary.',
    ...(scenario.multiplier >= 20
      ? ['Step 4: Add a read replica and route analytics queries there.']
      : []),
    ...(scenario.multiplier >= 50
      ? ['Step 5: Partition high-growth tables by date range.']
      : []),
    ...(scenario.multiplier >= 100
      ? ['Step 6: Evaluate Citus or Aurora Postgres for multi-node horizontal scale.']
      : []),
  ]
}

function estimateCost(multiplier: number): string {
  if (multiplier >= 500) return '10-20x current DB cost'
  if (multiplier >= 100) return '5-10x current DB cost'
  if (multiplier >= 50) return '3-5x current DB cost'
  if (multiplier >= 10) return '2-3x current DB cost'
  return '1.5-2x current DB cost'
}
