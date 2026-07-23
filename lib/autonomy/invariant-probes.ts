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

const HOT_FILTER_COLS = ['created_at', 'updated_at', 'status', 'slug', 'email', 'handle']

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
