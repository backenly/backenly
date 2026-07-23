// lib/ai/agents/performance-agent.ts
/** Performance specialist agent: detects missing FK indexes, unbounded pagination, and N+1 join risks. */

import { Pool } from 'pg'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import type { AgentInput, AgentResult, AgentFinding } from './types'

function makeId(): string {
  return `finding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * A junction table is only flagged for N+1 risk once it holds enough live rows
 * that per-row lookups actually multiply into real latency. Below this, the
 * "risk" is speculation about a backend that has no usage yet.
 */
const N_PLUS_ONE_MIN_ROWS = 1_000

/**
 * Detects junction tables: name contains '_' and both halves match
 * something in the known table list (e.g. 'user_roles' when 'users' and 'roles' exist).
 */
function detectJunctionTables(tables: string[]): string[] {
  const tableSet = new Set(tables.map(t => t.toLowerCase()))
  const junctions: string[] = []

  for (const tbl of tables) {
    if (!tbl.includes('_')) continue
    const parts = tbl.split('_')
    // Check every split point (handles names like order_line_items)
    for (let i = 1; i < parts.length; i++) {
      const left = parts.slice(0, i).join('_')
      const right = parts.slice(i).join('_')
      // Try singular/plural heuristics
      const leftMatch =
        tableSet.has(left) ||
        tableSet.has(`${left}s`) ||
        tableSet.has(left.replace(/s$/, ''))
      const rightMatch =
        tableSet.has(right) ||
        tableSet.has(`${right}s`) ||
        tableSet.has(right.replace(/s$/, ''))
      if (leftMatch && rightMatch) {
        junctions.push(tbl)
        break
      }
    }
  }
  return junctions
}

export async function runPerformanceAgent(input: AgentInput): Promise<AgentResult> {
  const start = Date.now()
  const findings: AgentFinding[] = []
  const autoFixed: string[] = []

  const { projectId, tables } = input

  if (tables.length === 0) {
    return { agentType: 'performance', durationMs: Date.now() - start, findings, autoFixed, skipped: true }
  }

  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    // ── 1. Find FK columns that lack an index ─────────────────────────────
    try {
      const res = await pool.query<{ table_name: string; column_name: string }>(
        `SELECT kcu.table_name, kcu.column_name
         FROM information_schema.key_column_usage kcu
         JOIN information_schema.table_constraints tc
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema    = kcu.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND kcu.table_schema   = $1
           AND NOT EXISTS (
             SELECT 1 FROM pg_indexes pi
             WHERE pi.schemaname = $1
               AND pi.tablename  = kcu.table_name
               AND pi.indexdef  LIKE '%' || kcu.column_name || '%'
           )`,
        [postgresSchema],
      )

      for (const row of res.rows) {
        const { table_name: tbl, column_name: col } = row
        findings.push({
          id: makeId(),
          agentType: 'performance',
          category: 'missing_index',
          severity: 'high',
          title: `Missing index on FK column "${tbl}.${col}"`,
          description: `Foreign-key column "${col}" on table "${tbl}" has no index. JOIN and filter queries on this column will trigger full-table scans at scale.`,
          location: tbl,
          fix: {
            description: `Create a concurrent B-tree index on ${tbl}(${col}).`,
            sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tbl}_${col} ON ${postgresSchema}.${tbl}(${col});`,
            executorAction: 'CREATE_INDEX',
            executorParams: { tableName: tbl, columnName: col, schema: postgresSchema },
            reversible: true,
            requiresApproval: false,
          },
        })
      }
    } catch {
      // Non-fatal — DB may not be accessible
    }

    // ── 2. Unbounded pagination — intentionally NOT a check ──────────────
    // Every generated list endpoint is hard-capped by the runtime executor
    // (PAGINATION_DEFAULT_LIMIT=20 / PAGINATION_MAX_LIMIT=100 in
    // lib/services/runtimeApiExecutor.ts, enforced regardless of API config),
    // so "no LIMIT enforcement" is impossible by construction. The old
    // heuristic here fired on `tables.length > 4` — a false defect reported
    // against every 5+-table backend the platform itself had just built.

    // ── 3. N+1 / cross-join risk on junction tables ───────────────────────
    // Name shape alone proves nothing on an empty backend: a junction table
    // only produces measurable N+1 pain once per-row lookups multiply over
    // real rows. Gate on live row count so fresh builds are never flagged
    // for load they don't have yet.
    const junctions = detectJunctionTables(tables)
    if (junctions.length > 0) {
      let liveRows = new Map<string, number>()
      try {
        const stats = await pool.query<{ tablename: string; n_live_tup: string }>(
          `SELECT relname AS tablename, n_live_tup::int
             FROM pg_stat_user_tables
            WHERE schemaname = $1 AND relname = ANY($2)`,
          [postgresSchema, junctions],
        )
        liveRows = new Map(stats.rows.map(r => [r.tablename, Number(r.n_live_tup)]))
      } catch {
        // Stats unavailable — treat as zero rows and stay silent rather than speculate
      }

      for (const jt of junctions) {
        const rows = liveRows.get(jt) ?? 0
        if (rows < N_PLUS_ONE_MIN_ROWS) continue
        findings.push({
          id: makeId(),
          agentType: 'performance',
          category: 'n_plus_one_risk',
          severity: 'medium',
          title: `Potential N+1 query risk on junction table "${jt}"`,
          description: `Table "${jt}" is a junction/pivot table with ${rows.toLocaleString()} rows. Client code that iterates its rows and issues per-row lookups into the related tables will produce N+1 queries. Consider a JOIN view or a batched endpoint.`,
          location: jt,
          fix: {
            description: `Create a database view that pre-joins "${jt}" with its related entities, reducing round-trips.`,
            reversible: true,
            requiresApproval: true,
          },
        })
      }
    }
  } catch {
    // Top-level guard — never throw
  } finally {
    try { await pool.end() } catch { /* ignore */ }
  }

  return {
    agentType: 'performance',
    durationMs: Date.now() - start,
    findings,
    autoFixed,
    skipped: false,
  }
}
