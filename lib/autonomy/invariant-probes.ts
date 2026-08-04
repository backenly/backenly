/**
 * EXPANDED INVARIANT PROBES
 * =========================
 *
 * The base catalogue in desired-state.ts covers RLS, FK constraints, FK
 * indexes, API drift, missing APIs, schema-intent match, auth integrity. That
 * is hygiene. It is not what "runs itself" implies to a user.
 *
 * This module wires the production-intelligence detectors (already shipped,
 * already running, already auto-fixable) into the desired-state invariant
 * model. Each detector becomes another wow moment for the loop:
 *
 *   • Hot-path index gaps (the *_id / created_at / status / slug columns
 *     queries hit constantly)
 *   • Rate-limit gaps on user-facing endpoints
 *   • Stale-data overflow on tables that grow without bound
 *   • Token-cleanup cron gaps on auth tables
 *
 * Each probe returns the canonical RawFinding shape the loop already consumes
 * — no new branch in the auto-fix kernel, no new audit row shape. The kernel
 * already knows how to fix `missing_rate_limit` and `missing_index` (it routes
 * the latter through the same CREATE_INDEX path as `missing_fk_index`).
 *
 * Read-only. Every probe isolates its own failure.
 */

import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import type { RawFinding } from '@/lib/core/types'
import { notReservedTableSql } from '@/lib/security/workspace-schema'

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL })

async function pgQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await pgPool.connect()
  try {
    const result = await client.query(sql, params)
    return result.rows as T[]
  } finally {
    client.release()
  }
}

// ── 1. Hot-path index gaps (common filter columns: created_at, status, …) ─────

/**
 * Common filter columns worth an index.
 *
 * BOTH conventions are listed on purpose. Workspace schemas genuinely mix them:
 * a table created through the builder gets `"createdAt"` / `"updatedAt"`
 * (camelCase, quoted — see the CREATE TABLE in lib/ai/minimal-executor.ts),
 * while one written by hand, imported, or migrated in gets `created_at` /
 * `updated_at`.
 *
 * Listing only snake_case made this probe structurally incapable of firing on
 * the platform's OWN output: every builder-created table reported no indexable
 * column, forever. That is the `detectMissingRls` failure again — a probe whose
 * empty result is indistinguishable from a healthy backend.
 *
 * The sibling detector in lib/ai/infra-intelligence.ts was fixed for exactly
 * this in 7851f40e (`INDEX_CANDIDATES`); this copy was missed. Keep the two
 * lists in step.
 *
 * `deleted_at` is deliberately NOT here despite being filtered by most list
 * queries: adding it would mint a finding against essentially every table in
 * every project at once, and a fleet-wide storm is not how a new candidate
 * column should be introduced.
 */
const HOT_FILTER_COLS = [
  'created_at', 'createdAt',
  'updated_at', 'updatedAt',
  'status', 'slug', 'email', 'handle',
]

/**
 * Find common filter columns that have no index. Distinct from
 * detectMissingFkIndexes which only catches the *_id pattern. Same fix path
 * (CREATE INDEX CONCURRENTLY) — same blast radius (purely additive). Routed
 * through the existing CREATE_INDEX action via the auto-fix engine.
 */
export async function detectMissingHotPathIndexes(projectId: string): Promise<RawFinding[]> {
  try {
    const schema = `workspace_${projectId}`

    const columns = await pgQuery<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema
        AND t.table_name = c.table_name
       WHERE c.table_schema = $1
         AND t.table_type = 'BASE TABLE'
         AND ${notReservedTableSql('c.table_name')}
         AND c.column_name = ANY($2::text[])`,
      [schema, HOT_FILTER_COLS],
    )

    if (columns.length === 0) return []

    const indexes = await pgQuery<{ tablename: string; indexdef: string }>(
      `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = $1`,
      [schema],
    )

    const indexed = new Set<string>()
    for (const idx of indexes) {
      const m = idx.indexdef.match(/\(([^)]+)\)/)
      if (!m) continue
      for (const c of m[1].split(',')) {
        indexed.add(`${idx.tablename}.${c.trim().replace(/^"|"$/g, '')}`)
      }
    }

    const findings: RawFinding[] = []
    for (const { table_name, column_name } of columns) {
      if (indexed.has(`${table_name}.${column_name}`)) continue
      findings.push({
        type: 'missing_fk_index', // routed through the same CREATE_INDEX path
        severity: 'warning',
        autoFixable: true,
        details: {
          tableName: table_name,
          columnName: column_name,
          location: `${table_name}.${column_name}`,
          subtype: 'hot_path',
          reason:
            `Column "${column_name}" on "${table_name}" is a common filter column with no index — ` +
            `list and lookup queries will slow as the table grows.`,
        },
      })
    }
    return findings
  } catch (err: any) {
    // Never return "no findings" when the probe could not run. An empty
    // result is indistinguishable from a healthy backend, which is how
    // detectMissingRls stayed silently dead for months. Throwing lets
    // computeDesiredStateDiff isolate this probe and mark its invariant
    // UNSATISFIED — unknown state is not the same as healthy.
    throw new Error(`[detectMissingHotPathIndexes] probe failed: ${err?.message ?? String(err)}`)
  }
}

// ── 2. Rate-limit gaps on user-facing endpoints ──────────────────────────────

// detectMissingRateLimits was DELETED on 2026-07-21. It could not ever find a
// true positive, and it produced 28 `auto_fixed` findings in production doing so.
//
// It read `ApiDefinition.config.rateLimit` and, when absent, queued a fix that
// wrote that same field. Nothing in the request path has ever read it: rate
// limiting is enforced per API key via enforceRateLimitByKeyId
// (server/lib/auth.ts), `ApiKey.rateLimit` is `Int @default(1000)` so it can
// never be unset, and the only per-ApiDefinition limiter
// (enforceApiDefinitionRateLimit) had zero callers and is now gone.
//
// So the loop was: detect config nobody reads is missing -> write config nobody
// reads -> record a successful repair. Twenty-eight fabricated entries in the
// trust timeline for protection that never took effect. A detector that is
// structurally incapable of being right is worse than no detector, because the
// autonomy loop spends its credibility claiming those repairs.
//
// There WAS a real rate-limit gap underneath the noise, and a probe of this
// shape could never have found it: /api/v2 authenticated through the same path
// as /api/v1 but never called the limiter, so one key was capped on one URL and
// uncapped on the other. That is fixed in code (server/routes/v2.ts), where an
// enforcement gap belongs — not behind a detector.

// ── 3. Stale-data overflow (tables that grow without bound) ──────────────────

const ARCHIVAL_PATTERNS = ['session', 'log', 'audit', 'event', 'notification', 'message']

/**
 * Tables that are likely to grow without bound (sessions, logs, events). When
 * row count crosses a threshold AND no archival/cleanup cron exists, surface
 * a finding the user can approve. NOT auto-applied — destructive enough to
 * need a human nod on the retention window.
 */
export async function detectStaleDataOverflow(projectId: string): Promise<RawFinding[]> {
  try {
    const schema = `workspace_${projectId}`

    const tables = await pgQuery<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [schema],
    )

    const archivable = tables
      .map(t => t.table_name)
      .filter(n => ARCHIVAL_PATTERNS.some(p => n.toLowerCase().includes(p)))

    if (archivable.length === 0) return []

    // Check existing cron jobs for an archival job on each table.
    const cronJobs = await prisma.appTrigger.findMany({
      where: { projectId, actionType: 'cron' },
      select: { name: true, sourceTable: true },
    }).catch(() => [])

    const hasCronFor = (table: string): boolean => {
      const lower = table.toLowerCase()
      return cronJobs.some(j =>
        (j.sourceTable ?? '').toLowerCase() === lower ||
        (j.name ?? '').toLowerCase().includes(lower),
      )
    }

    const findings: RawFinding[] = []
    for (const table of archivable) {
      if (hasCronFor(table)) continue

      // Approximate row count cheaply via pg_class.reltuples (avoids COUNT(*)).
      const count = await pgQuery<{ rows: number }>(
        `SELECT COALESCE(reltuples, 0)::bigint AS rows
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, table],
      ).then(r => Number(r[0]?.rows ?? 0)).catch(() => 0)

      // Only flag once a table is non-trivial. Empty tables would just spam.
      if (count < 1000) continue

      findings.push({
        // notify_only — adding an archival cron requires the user to pick a
        // retention window. Never routed to DROP_TABLE (which is what
        // `orphan_table` would route to).
        type: 'missing_archival_job',
        severity: 'info',
        autoFixable: false,
        details: {
          tableName: table,
          location: table,
          rowCount: count,
          findingType: 'missing_archival_job',
          reason:
            `"${table}" has ~${count.toLocaleString()} rows and no archival cron — ` +
            `it will slow every query against it and inflate storage cost month over month.`,
        },
      })
    }
    return findings
  } catch (err: any) {
    // Never return "no findings" when the probe could not run. An empty
    // result is indistinguishable from a healthy backend, which is how
    // detectMissingRls stayed silently dead for months. Throwing lets
    // computeDesiredStateDiff isolate this probe and mark its invariant
    // UNSATISFIED — unknown state is not the same as healthy.
    throw new Error(`[detectStaleDataOverflow] probe failed: ${err?.message ?? String(err)}`)
  }
}

// ── 4. Token-cleanup cron gap on auth tables ────────────────────────────────

/**
 * Auth-style tables (sessions, password_resets, refresh_tokens) accumulate
 * expired rows. Without a cleanup cron, the table grows forever and gives
 * attackers a wider brute-force window of stolen credentials.
 */
export async function detectExpiredTokenBuildup(projectId: string): Promise<RawFinding[]> {
  try {
    const schema = `workspace_${projectId}`

    const candidates = await pgQuery<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema
        AND t.table_name = c.table_name
       WHERE c.table_schema = $1
         AND t.table_type = 'BASE TABLE'
         AND c.column_name IN ('expires_at', 'expiry', 'expired_at')`,
      [schema],
    )

    if (candidates.length === 0) return []

    const cronJobs = await prisma.appTrigger.findMany({
      where: { projectId, actionType: 'cron' },
      select: { name: true, sourceTable: true },
    }).catch(() => [])

    const hasCronFor = (table: string): boolean => {
      const lower = table.toLowerCase()
      return cronJobs.some(j =>
        (j.sourceTable ?? '').toLowerCase() === lower ||
        (j.name ?? '').toLowerCase().includes(lower),
      )
    }

    const findings: RawFinding[] = []
    for (const { table_name } of candidates) {
      if (hasCronFor(table_name)) continue
      findings.push({
        // notify_only — adding a cron requires the user to confirm cadence +
        // retention. Never auto-dropped — that's a destructive default no
        // production system should ever take.
        type: 'missing_token_cleanup_cron',
        severity: 'info',
        autoFixable: false,
        details: {
          tableName: table_name,
          location: table_name,
          findingType: 'missing_token_cleanup_cron',
          reason:
            `"${table_name}" has an expiry column but no cleanup cron — ` +
            `expired tokens accumulate and broaden the attack window for stolen credentials.`,
        },
      })
    }
    return findings
  } catch (err: any) {
    // Never return "no findings" when the probe could not run. An empty
    // result is indistinguishable from a healthy backend, which is how
    // detectMissingRls stayed silently dead for months. Throwing lets
    // computeDesiredStateDiff isolate this probe and mark its invariant
    // UNSATISFIED — unknown state is not the same as healthy.
    throw new Error(`[detectExpiredTokenBuildup] probe failed: ${err?.message ?? String(err)}`)
  }
}

// ── Dead-tuple bloat that autovacuum is not keeping up with ──────────────────

/**
 * Minimum dead-tuple RATIO before a table counts as bloated.
 *
 * The number matters more than it looks. PostgreSQL's own autovacuum triggers
 * at `autovacuum_vacuum_scale_factor = 0.2` — twenty percent dead tuples IS the
 * point where the database starts cleaning up, i.e. the normal operating point
 * of every healthy write-heavy table. The infra scan flagged at exactly that
 * ratio, so it reported healthy tables doing exactly what they should be doing:
 * four such rows sat open in the production queue against tables with 91% and
 * 96% index coverage, and the only reason they were not noisier is that nobody
 * could act on them.
 *
 * Forty percent means autovacuum has run or should have run and the table is
 * still dirty — the shape of a genuinely starved or disabled autovacuum, which
 * a manual VACUUM does resolve. Between 20 and 40 is Postgres's business, and
 * the platform should stay out of it.
 */
const BLOAT_RATIO_PCT = 40

/**
 * Floor on absolute dead tuples, so a tiny table cannot flap.
 *
 * Without it a 5-row table with 3 dead rows is 60% "bloated" and would be
 * detected, vacuumed, re-detected on the next insert, and eventually escalated
 * to a human by the recurrence guard — a permanent nuisance finding generated
 * entirely by rounding.
 */
const BLOAT_MIN_DEAD_TUPLES = 1_000

/**
 * Tables carrying enough dead rows that autovacuum is demonstrably behind.
 *
 * Exists so the loop can VERIFY its own VACUUM. The bloat repair is applied
 * automatically (it changes no data and takes no exclusive lock), and an
 * auto-applied fix with no probe to re-run afterwards is recorded on the
 * executor's word alone — the exact failure mode
 * tests/core/autonomy-verification-coverage.test.ts exists to keep out of this
 * catalogue. With this probe registered, a VACUUM that did not actually reclaim
 * anything is caught and escalated instead of being logged as a repair.
 */
export async function detectTableBloat(projectId: string): Promise<RawFinding[]> {
  try {
    const schema = `workspace_${projectId}`

    const rows = await pgQuery<{
      relname: string
      dead: string
      live: string
      ratio: string
    }>(
      `SELECT relname,
              n_dead_tup::text AS dead,
              n_live_tup::text AS live,
              round(
                (n_dead_tup::numeric * 100)
                / NULLIF(n_live_tup + n_dead_tup, 0)
              )::text AS ratio
         FROM pg_stat_user_tables
        WHERE schemaname = $1
          AND n_dead_tup >= $2
          AND (n_dead_tup::numeric * 100) / NULLIF(n_live_tup + n_dead_tup, 0) >= $3
          AND ${notReservedTableSql('relname')}`,
      [schema, BLOAT_MIN_DEAD_TUPLES, BLOAT_RATIO_PCT],
    )

    return rows.map(r => ({
      type: 'infra_table_bloat' as const,
      severity: 'warning' as const,
      autoFixable: true,
      details: {
        tableName: r.relname,
        location: r.relname,
        findingType: 'infra_table_bloat',
        deadTupRatio: Number(r.ratio),
        deadTuples: Number(r.dead),
        liveRows: Number(r.live),
        reason:
          `"${r.relname}" is carrying ${Number(r.dead).toLocaleString()} dead rows ` +
          `(${r.ratio}% of the table) — autovacuum has not kept up, so reads scan ` +
          `space that holds nothing.`,
      },
    }))
  } catch (err: any) {
    // Same contract as every probe here: an empty result must never stand in
    // for "could not check".
    throw new Error(`[detectTableBloat] probe failed: ${err?.message ?? String(err)}`)
  }
}
