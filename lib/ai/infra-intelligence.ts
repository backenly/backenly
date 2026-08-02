/**
 * INFRA INTELLIGENCE — AI Infrastructure Architect
 * =================================================
 * Detects real infrastructure pressure from live PostgreSQL system catalogs.
 *
 * Detection surface:
 *   - Hot tables     — high seq_scan rate, low index hit %, dead-tuple bloat
 *   - Index issues   — unused indexes (wasted write overhead) + missing indexes (missed reads)
 *   - Partitioning   — unbounded append tables crossing the 100k-row threshold
 *   - Query cost     — pg_stat_statements top-N slow queries (if extension available)
 *   - Connection sat — active vs max_connections headroom
 *   - WebSocket load — realtime table write rate as a proxy for subscribe pressure
 *
 * Rules:
 *   - All queries target pg_stat_* views — never reads user data
 *   - Every finding includes a concrete SQL fix (safe to auto-apply or queue)
 *   - Never throws — returns partial report on any query failure
 */

import { Pool } from 'pg'

// Warn once per server restart if pg_stat_statements is unavailable.
// Avoids spamming logs on every cron invocation.
let _pgStatStatementsWarned = false

// ── Public types ──────────────────────────────────────────────────────────────

export type InfraPressure = 'none' | 'low' | 'medium' | 'high' | 'critical'

export interface HotTableFinding {
  table: string
  seqScans: number
  idxHitPct: number   // 0-100: percentage of reads served by indexes
  deadTupRatio: number // 0-100: dead tuple bloat ratio
  liveRows: number
  pressure: InfraPressure
  recommendation: string
  suggestedIndex?: string
}

export interface IndexFinding {
  indexName: string
  table: string
  kind: 'unused' | 'fragmented' | 'missing'
  idxScans: number
  sizeBytes: number
  pressure: InfraPressure
  recommendation: string
  sqlFix?: string
}

export interface PartitioningFinding {
  table: string
  liveRows: number
  growthClass: 'high' | 'very_high' | 'critical'
  recommendation: string
  migrationSql: string
}

export interface QueryFinding {
  queryPattern: string  // truncated + anonymized
  avgMs: number
  calls: number
  avgRows: number
  pressure: InfraPressure
  recommendation: string
}

export interface ConnectionFinding {
  total: number
  active: number
  idleInTx: number
  maxConnections: number
  usagePct: number
  pressure: InfraPressure
  recommendation: string
}

export interface WebSocketFinding {
  highWriteTables: string[]
  estimatedSubscriberLoad: 'low' | 'medium' | 'high'
  recommendation: string
}

export interface InfraReport {
  projectId: string
  schemaName: string
  scannedAt: string
  overallPressure: InfraPressure
  hotTables: HotTableFinding[]
  indexIssues: IndexFinding[]
  partitioningCandidates: PartitioningFinding[]
  slowQueries: QueryFinding[]
  connectionPressure: ConnectionFinding | null
  websocketPressure: WebSocketFinding | null
  /** Prioritised actionable recommendations, highest severity first */
  topRecommendations: string[]
  /** SQL fixes safe to auto-apply (no data loss risk) */
  autoApplicableFixes: string[]
  /** SQL that needs user approval before running */
  approvalRequired: string[]
}

// ── Connection helper ─────────────────────────────────────────────────────────

function getPool(): Pool {
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
}

// ── Detection: Hot tables ─────────────────────────────────────────────────────

async function detectHotTables(pool: Pool, schemaName: string): Promise<HotTableFinding[]> {
  try {
    const rows = await pool.query<{
      tablename: string
      seq_scan: string
      idx_scan: string
      n_live_tup: string
      n_dead_tup: string
    }>(
      // `relname AS tablename`, not `tablename`. pg_stat_user_tables exposes
      // (schemaname, relname); `tablename` is a pg_tables column. Selecting it
      // here raised 42703 on EVERY call, the module's "never throws" contract
      // swallowed it, and this detector returned [] — reported as "no hot
      // tables" rather than "the query is wrong". It had never once run.
      `SELECT relname AS tablename, seq_scan, COALESCE(idx_scan, 0) AS idx_scan,
              n_live_tup, n_dead_tup
         FROM pg_stat_user_tables
        WHERE schemaname = $1
          AND (seq_scan > 100 OR n_live_tup > 5000)
        ORDER BY seq_scan DESC
        LIMIT 20`,
      [schemaName],
    )

    // Which of these tables actually HAVE a created_at column.
    //
    // The suggestion below used to be emitted for every hot table unconditionally,
    // so on any table without created_at the generated
    // `CREATE INDEX ... (created_at DESC)` failed 42703 inside _applyAutoFixes,
    // whose catch logs "Auto-fix failed (non-fatal)" and moves on. In production
    // that fired nine times per pass, every pass — an auto-fix that had never
    // once applied, reported only as a warning nobody reads. Same species as the
    // pg_stat_user_tables.tablename bug two functions up: generated SQL that
    // references a column the table does not have, swallowed by a catch.
    //
    // No fallback to "some other timestamp column" on purpose: indexing a column
    // the user did not ask about is a guess, and a wrong index costs write
    // throughput forever. When created_at is absent the textual recommendation
    // still reaches the owner; only the auto-applicable SQL is withheld.
    const tableNames = rows.rows.map(r => r.tablename)
    const withCreatedAt = new Set<string>()
    if (tableNames.length) {
      const cols = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = $1 AND column_name = 'created_at'
            AND table_name = ANY($2::text[])`,
        [schemaName, tableNames],
      )
      for (const c of cols.rows) withCreatedAt.add(c.table_name)
    }

    return rows.rows.map(r => {
      const seqScans = Number(r.seq_scan)
      const idxScans = Number(r.idx_scan)
      const live = Number(r.n_live_tup)
      const dead = Number(r.n_dead_tup)
      const total = seqScans + idxScans
      const idxHitPct = total > 0 ? Math.round((idxScans / total) * 100) : 0
      const deadRatio = live + dead > 0 ? Math.round((dead / (live + dead)) * 100) : 0

      const pressure: InfraPressure =
        (idxHitPct < 20 && seqScans > 10_000) ? 'critical' :
        (idxHitPct < 50 && seqScans > 1_000)  ? 'high' :
        (idxHitPct < 70 && seqScans > 100)     ? 'medium' :
        (deadRatio > 20)                        ? 'low' :
        'none'

      const suggestedIndex = idxHitPct < 50 && withCreatedAt.has(r.tablename)
        ? `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${r.tablename}_created_at ON "${schemaName}"."${r.tablename}" ("created_at" DESC);`
        : undefined

      return {
        table: r.tablename,
        seqScans,
        idxHitPct,
        deadTupRatio: deadRatio,
        liveRows: live,
        pressure,
        recommendation: idxHitPct < 50
          ? `Table "${r.tablename}" is read ${seqScans.toLocaleString()}× with only ${idxHitPct}% index coverage — add indexes on commonly filtered columns.`
          : `Table "${r.tablename}" has ${deadRatio}% dead-tuple bloat — VACUUM ANALYZE will recover space.`,
        suggestedIndex,
      }
    }).filter(f => f.pressure !== 'none')
  } catch {
    return []
  }
}

// ── Detection: Index issues ───────────────────────────────────────────────────

async function detectIndexIssues(pool: Pool, schemaName: string): Promise<IndexFinding[]> {
  const findings: IndexFinding[] = []

  try {
    // Unused non-primary, non-unique indexes (negative ROI: write cost but never read)
    const unused = await pool.query<{
      index_name: string
      table_name: string
      idx_scan: string
      size_bytes: string
    }>(
      `SELECT i.relname AS index_name, t.relname AS table_name,
              COALESCE(s.idx_scan, 0) AS idx_scan,
              pg_relation_size(i.oid) AS size_bytes
         FROM pg_index ix
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
        WHERE t.relkind = 'r'
          AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
          AND ix.indisprimary = false
          AND ix.indisunique = false
          AND COALESCE(s.idx_scan, 0) < 10
          AND pg_relation_size(i.oid) > 8192
        ORDER BY pg_relation_size(i.oid) DESC
        LIMIT 10`,
      [schemaName],
    )

    for (const r of unused.rows) {
      const sizeBytes = Number(r.size_bytes)
      const scans = Number(r.idx_scan)
      findings.push({
        indexName: r.index_name,
        table: r.table_name,
        kind: 'unused',
        idxScans: scans,
        sizeBytes,
        pressure: sizeBytes > 10 * 1024 * 1024 ? 'medium' : 'low',
        recommendation: `Index "${r.index_name}" on "${r.table_name}" has only ${scans} scans and consumes ${fmtBytes(sizeBytes)} — consider dropping it to reduce write overhead.`,
        sqlFix: `DROP INDEX CONCURRENTLY IF EXISTS "${schemaName}"."${r.index_name}";`,
      })
    }
  } catch { /* pg_index not accessible in this context */ }

  return findings
}

// ── Detection: Partitioning candidates ───────────────────────────────────────

const PARTITION_PATTERN_TABLES = [
  'events', 'logs', 'activities', 'notifications', 'audit', 'audit_logs',
  'metrics', 'analytics', 'requests', 'access_log', 'errors',
]

async function detectPartitioningCandidates(
  pool: Pool,
  schemaName: string,
): Promise<PartitioningFinding[]> {
  try {
    const rows = await pool.query<{ tablename: string; n_live_tup: string }>(
      // relname, not tablename — see detectHotTables. Same 42703, same swallow.
      `SELECT relname AS tablename, n_live_tup::int
         FROM pg_stat_user_tables
        WHERE schemaname = $1
          AND n_live_tup > 100000
        ORDER BY n_live_tup DESC
        LIMIT 15`,
      [schemaName],
    )

    return rows.rows
      .filter(r => {
        const name = r.tablename
        const isTimeSeriesPattern = PARTITION_PATTERN_TABLES.some(
          p => name === p || name.startsWith(p + '_') || name.endsWith('_' + p),
        )
        return isTimeSeriesPattern || Number(r.n_live_tup) > 1_000_000
      })
      .map(r => {
        const rows = Number(r.n_live_tup)
        const growthClass: PartitioningFinding['growthClass'] =
          rows > 10_000_000 ? 'critical' : rows > 1_000_000 ? 'very_high' : 'high'

        return {
          table: r.tablename,
          liveRows: rows,
          growthClass,
          recommendation: `Table "${r.tablename}" has ${rows.toLocaleString()} rows and is unbounded — partition by time to keep per-partition size manageable and enable fast archival.`,
          migrationSql: `-- Partition "${r.tablename}" by month (requires downtime or pg_partman)
-- Step 1: rename existing table
ALTER TABLE "${schemaName}"."${r.tablename}" RENAME TO "${r.tablename}_legacy";
-- Step 2: create partitioned table (schema must match)
-- CREATE TABLE "${schemaName}"."${r.tablename}" (...) PARTITION BY RANGE (created_at);
-- Step 3: attach existing data as first partition
-- See: https://www.postgresql.org/docs/current/ddl-partitioning.html`,
        }
      })
  } catch {
    return []
  }
}

// ── Detection: Slow queries (pg_stat_statements) ──────────────────────────────

async function detectSlowQueries(pool: Pool, schemaName: string): Promise<QueryFinding[]> {
  try {
    // Check if pg_stat_statements is available
    const ext = await pool.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements' LIMIT 1`,
    )
    if (ext.rows.length === 0) {
      if (!_pgStatStatementsWarned) {
        _pgStatStatementsWarned = true
        console.warn(
          '[InfraIntelligence] pg_stat_statements extension is not installed. ' +
          'Slow query detection is disabled. ' +
          'Run: CREATE EXTENSION IF NOT EXISTS pg_stat_statements; and restart PostgreSQL.',
        )
      }
      return []
    }

    const rows = await pool.query<{
      query: string
      calls: string
      avg_ms: string
      avg_rows: string
    }>(
      `SELECT LEFT(query, 200) AS query,
              calls,
              ROUND((total_exec_time / NULLIF(calls, 0))::numeric, 2) AS avg_ms,
              ROUND((rows / NULLIF(calls, 0))::numeric, 0) AS avg_rows
         FROM pg_stat_statements
        WHERE query NOT LIKE '%pg_%'
          AND query NOT LIKE '%information_schema%'
          AND (total_exec_time / NULLIF(calls, 0)) > 100
        ORDER BY avg_ms DESC
        LIMIT 8`,
    )

    return rows.rows.map(r => {
      const avgMs = Number(r.avg_ms)
      const calls = Number(r.calls)
      const avgRows = Number(r.avg_rows)
      return {
        queryPattern: r.query.replace(/\$\d+/g, '?').replace(/\s+/g, ' ').trim(),
        avgMs,
        calls,
        avgRows,
        pressure: avgMs > 5000 ? 'critical' : avgMs > 1000 ? 'high' : avgMs > 500 ? 'medium' : 'low',
        recommendation: avgRows > 10000
          ? `Query averaging ${Math.round(avgMs)}ms returns ${avgRows.toLocaleString()} rows on average — add a LIMIT or a covering index to reduce scan scope.`
          : `Query averaging ${Math.round(avgMs)}ms called ${calls.toLocaleString()}× — add an index on the WHERE clause columns.`,
      }
    })
  } catch {
    return []
  }
}

// ── Detection: Connection pressure ───────────────────────────────────────────

async function detectConnectionPressure(pool: Pool): Promise<ConnectionFinding | null> {
  try {
    const rows = await pool.query<{
      total: string
      active: string
      idle_in_tx: string
      max_connections: string
    }>(
      `SELECT COUNT(*)                                            AS total,
              COUNT(*) FILTER (WHERE state = 'active')           AS active,
              COUNT(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx,
              (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections
         FROM pg_stat_activity
        WHERE datname = current_database()`,
    )

    if (rows.rows.length === 0) return null
    const r = rows.rows[0]
    const total = Number(r.total)
    const active = Number(r.active)
    const idleInTx = Number(r.idle_in_tx)
    const maxConn = Number(r.max_connections)
    const usagePct = Math.round((total / maxConn) * 100)

    const pressure: InfraPressure =
      usagePct > 90 ? 'critical' :
      usagePct > 75 ? 'high' :
      idleInTx > 10 ? 'medium' :
      usagePct > 50 ? 'low' : 'none'

    if (pressure === 'none') return null

    return {
      total,
      active,
      idleInTx,
      maxConnections: maxConn,
      usagePct,
      pressure,
      recommendation: idleInTx > 10
        ? `${idleInTx} connections are "idle in transaction" — check for missing transaction commits in application code. These hold locks and starve other connections.`
        : `Connection usage at ${usagePct}% (${total}/${maxConn}). Deploy PgBouncer in transaction mode to multiplex connections.`,
    }
  } catch {
    return null
  }
}

// ── Detection: WebSocket / Realtime pressure ──────────────────────────────────

async function detectWebSocketPressure(
  pool: Pool,
  schemaName: string,
): Promise<WebSocketFinding | null> {
  try {
    // High write tables drive NOTIFY volume, which drives websocket fan-out
    const rows = await pool.query<{ tablename: string; n_tup_ins: string; n_tup_upd: string }>(
      // relname, not tablename — see detectHotTables. Same 42703, same swallow.
      `SELECT relname AS tablename,
              n_tup_ins, n_tup_upd
         FROM pg_stat_user_tables
        WHERE schemaname = $1
          AND (n_tup_ins + n_tup_upd) > 1000
        ORDER BY (n_tup_ins + n_tup_upd) DESC
        LIMIT 5`,
      [schemaName],
    )

    if (rows.rows.length === 0) return null

    const highWriteTables = rows.rows.map(r => r.tablename)
    const totalWrites = rows.rows.reduce(
      (s, r) => s + Number(r.n_tup_ins) + Number(r.n_tup_upd), 0,
    )

    const load: WebSocketFinding['estimatedSubscriberLoad'] =
      totalWrites > 500_000 ? 'high' : totalWrites > 50_000 ? 'medium' : 'low'

    if (load === 'low') return null

    return {
      highWriteTables,
      estimatedSubscriberLoad: load,
      recommendation: load === 'high'
        ? `Tables ${highWriteTables.join(', ')} have very high write volume (${totalWrites.toLocaleString()} mutations). At scale, NOTIFY/LISTEN will saturate. Consider throttling realtime subscriptions to 1-2 second intervals or using a dedicated pub/sub layer.`
        : `Tables ${highWriteTables.join(', ')} generate significant realtime traffic — monitor pg_stat_activity for LISTEN clients exceeding 500.`,
    }
  } catch {
    return null
  }
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Run a full infrastructure intelligence scan for a project's workspace schema.
 * Returns a structured InfraReport — never throws.
 */
export async function runInfraIntelligence(
  projectId: string,
  schemaName?: string,
): Promise<InfraReport> {
  const schema = schemaName ?? `workspace_${projectId}`
  const scannedAt = new Date().toISOString()

  const pool = getPool()
  try {
    const [hotTables, indexIssues, partitionCandidates, slowQueries, connPressure, wsPressure] =
      await Promise.allSettled([
        detectHotTables(pool, schema),
        detectIndexIssues(pool, schema),
        detectPartitioningCandidates(pool, schema),
        detectSlowQueries(pool, schema),
        detectConnectionPressure(pool),
        detectWebSocketPressure(pool, schema),
      ])

    const report: InfraReport = {
      projectId,
      schemaName: schema,
      scannedAt,
      overallPressure: 'none',
      hotTables: hotTables.status === 'fulfilled' ? hotTables.value : [],
      indexIssues: indexIssues.status === 'fulfilled' ? indexIssues.value : [],
      partitioningCandidates: partitionCandidates.status === 'fulfilled' ? partitionCandidates.value : [],
      slowQueries: slowQueries.status === 'fulfilled' ? slowQueries.value : [],
      connectionPressure: connPressure.status === 'fulfilled' ? connPressure.value : null,
      websocketPressure: wsPressure.status === 'fulfilled' ? wsPressure.value : null,
      topRecommendations: [],
      autoApplicableFixes: [],
      approvalRequired: [],
    }

    // Compute overall pressure (highest severity across all findings)
    const pressureRank: Record<InfraPressure, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }
    const allPressures: InfraPressure[] = [
      ...report.hotTables.map(f => f.pressure),
      ...report.indexIssues.map(f => f.pressure),
      ...report.partitioningCandidates.map(f =>
        f.growthClass === 'critical' ? 'critical' : f.growthClass === 'very_high' ? 'high' : 'medium',
      ),
      ...report.slowQueries.map(f => f.pressure),
      ...(report.connectionPressure ? [report.connectionPressure.pressure] : []),
    ]
    const maxPressure = allPressures.reduce<InfraPressure>(
      (best, p) => pressureRank[p] > pressureRank[best] ? p : best,
      'none',
    )
    report.overallPressure = maxPressure

    // Top recommendations (critical + high first, max 6)
    const recs: Array<{ priority: number; text: string }> = []
    for (const f of report.hotTables.filter(f => f.pressure === 'critical' || f.pressure === 'high')) {
      recs.push({ priority: pressureRank[f.pressure], text: f.recommendation })
    }
    for (const f of report.indexIssues.filter(f => f.pressure === 'critical' || f.pressure === 'high')) {
      recs.push({ priority: pressureRank[f.pressure], text: f.recommendation })
    }
    for (const f of report.partitioningCandidates) {
      recs.push({ priority: 2, text: f.recommendation })
    }
    for (const f of report.slowQueries.filter(f => f.pressure === 'critical' || f.pressure === 'high')) {
      recs.push({ priority: pressureRank[f.pressure], text: f.recommendation })
    }
    if (report.connectionPressure) {
      recs.push({ priority: pressureRank[report.connectionPressure.pressure], text: report.connectionPressure.recommendation })
    }
    report.topRecommendations = recs
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 6)
      .map(r => r.text)

    // Auto-applicable fixes (safe: index creation, VACUUM hints — no drops)
    for (const f of report.hotTables) {
      if (f.suggestedIndex && (f.pressure === 'critical' || f.pressure === 'high')) {
        report.autoApplicableFixes.push(f.suggestedIndex)
      }
    }
    // Unused index removal requires approval (could break unknown application code)
    for (const f of report.indexIssues.filter(f => f.kind === 'unused' && f.sqlFix)) {
      report.approvalRequired.push(f.sqlFix!)
    }
    // Partitioning always requires approval (structural change)
    for (const f of report.partitioningCandidates) {
      report.approvalRequired.push(f.migrationSql)
    }

    return report
  } finally {
    await pool.end().catch(() => {})
  }
}

/**
 * Run infra intelligence and store findings as HealthFinding rows.
 * Fire-and-forget — never throws.
 */
export async function runAndStoreInfraIntelligence(
  projectId: string,
  userId: string,
): Promise<void> {
  try {
    const report = await runInfraIntelligence(projectId)
    if (report.overallPressure === 'none') return

    const { prisma } = await import('@/lib/db/prisma')

    // Deduplicate against open findings
    const existing = await prisma.healthFinding.findMany({
      where: { projectId, status: 'open', type: { startsWith: 'infra_' } },
      select: { type: true },
    }).catch(() => [])
    const existingTypes = new Set(existing.map(e => e.type))

    type PrismaFindingCreate = {
      projectId: string
      type: string
      severity: string
      details: object
      status: string
      autoFixed: boolean
    }

    const toCreate: PrismaFindingCreate[] = []

    // Hot tables → HealthFinding
    for (const f of report.hotTables) {
      const type = `infra_hot_table_${f.table}`
      if (!existingTypes.has(type)) {
        toCreate.push({
          projectId,
          type,
          severity: mapPressureToSeverity(f.pressure),
          details: {
            title: `Hot table: ${f.table}`,
            description: f.recommendation,
            source: 'infra_intelligence',
            table: f.table,
            idxHitPct: f.idxHitPct,
            seqScans: f.seqScans,
            fix: f.suggestedIndex ?? null,
            requiresApproval: false,
            detectedAt: report.scannedAt,
          },
          status: 'open',
          autoFixed: false,
        })
      }
    }

    // Partitioning candidates → HealthFinding (approval required)
    for (const f of report.partitioningCandidates) {
      const type = `infra_partition_${f.table}`
      if (!existingTypes.has(type)) {
        toCreate.push({
          projectId,
          type,
          severity: f.growthClass === 'critical' ? 'critical' : 'warning',
          details: {
            title: `Partitioning candidate: ${f.table}`,
            description: f.recommendation,
            source: 'infra_intelligence',
            table: f.table,
            liveRows: f.liveRows,
            migrationSql: f.migrationSql,
            requiresApproval: true,
            detectedAt: report.scannedAt,
          },
          status: 'open',
          autoFixed: false,
        })
      }
    }

    // Connection pressure → HealthFinding
    if (report.connectionPressure && report.connectionPressure.pressure !== 'low') {
      const type = 'infra_connection_pressure'
      if (!existingTypes.has(type)) {
        toCreate.push({
          projectId,
          type,
          severity: mapPressureToSeverity(report.connectionPressure.pressure),
          details: {
            title: 'Connection pool pressure',
            description: report.connectionPressure.recommendation,
            source: 'infra_intelligence',
            usagePct: report.connectionPressure.usagePct,
            idleInTx: report.connectionPressure.idleInTx,
            requiresApproval: false,
            detectedAt: report.scannedAt,
          },
          status: 'open',
          autoFixed: false,
        })
      }
    }

    if (toCreate.length > 0) {
      await prisma.healthFinding.createMany({ data: toCreate as any, skipDuplicates: true }).catch(() => {})

      // Auto-apply safe index additions — MUST go through the build lock so cron
      // fixes never race with an active user build on the same project.
      if (report.autoApplicableFixes.length > 0) {
        const { withBuildLock } = await import('@/lib/ai/build-runtime/build-lock')
        const lockResult = await withBuildLock(projectId, 'modify', async () => {
          await _applyAutoFixes(projectId, report.autoApplicableFixes)
        })
        if (lockResult.error) {
          console.log(`[InfraIntelligence] Skipping auto-fixes for ${projectId} — ${lockResult.error}`)
        }
      }

      // Notify
      await prisma.platformNotification.create({
        data: {
          userId,
          projectId,
          type: 'infra_intelligence',
          title: `Infrastructure pressure detected (${report.overallPressure})`,
          body: report.topRecommendations[0] ?? 'Review infra findings in your project dashboard.',
          metadata: {
            overallPressure: report.overallPressure,
            findingCount: toCreate.length,
            autoFixed: report.autoApplicableFixes.length,
            source: 'infra_intelligence',
          },
          read: false,
        } as any,
      }).catch(() => {})
    }

    console.log(`[InfraIntelligence] project=${projectId} pressure=${report.overallPressure} findings=${toCreate.length} autoFixes=${report.autoApplicableFixes.length}`)
  } catch (err: any) {
    console.warn(`[InfraIntelligence] Failed for project ${projectId}:`, err?.message)
  }
}

// ── Safe auto-fix execution ───────────────────────────────────────────────────

async function _applyAutoFixes(projectId: string, sqls: string[]): Promise<void> {
  const pool = getPool()
  try {
    for (const sql of sqls) {
      try {
        await pool.query(sql)
        console.log(`[InfraIntelligence] Auto-applied: ${sql.slice(0, 80)}`)
      } catch (e: any) {
        console.warn(`[InfraIntelligence] Auto-fix failed (non-fatal): ${e?.message}`)
      }
    }
  } finally {
    await pool.end().catch(() => {})
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapPressureToSeverity(p: InfraPressure): string {
  switch (p) {
    case 'critical': return 'critical'
    case 'high':     return 'error'
    case 'medium':   return 'warning'
    default:         return 'info'
  }
}

function fmtBytes(b: number): string {
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  if (b > 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${b} B`
}
