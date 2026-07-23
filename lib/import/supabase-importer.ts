/**
 * Supabase importer — the engine behind POST /api/projects/[id]/import/supabase.
 *
 * ⚠ DORMANT BY DESIGN (2026-07-17). The route that calls this is gated OFF
 * (env SUPABASE_IMPORT_ENABLED, default false → 404) for ~1–3 months. Reason:
 * "migrate from Supabase" must not be Backenly's hook — the autonomous governed
 * backend + agent lane is. This engine is complete, unit-tested, and preserved;
 * it simply has no reachable entry point until we choose to surface migration.
 * Do not delete. See the route file for the full rationale + re-enable steps.
 *
 * Turns a running Supabase project into a running Backenly backend:
 *
 *   1. Introspect the source (public schema tables, columns, PK/FK, policies,
 *      auth.users) over a direct Postgres connection the OWNER supplies.
 *   2. Build a deterministic ImportPlan (lib/import/supabase-map.ts — pure,
 *      unit-tested) covering renames, legacy-id preservation, and lossy-type
 *      degradations.
 *   3. Create every table through `executeAction` — the same governed kernel
 *      the AI and dashboard use, so imported tables get metadata, generated
 *      APIs, and reconciler coverage like any other table.
 *   4. Copy rows in batches with source-side casts; remap legacy FKs to the
 *      new UUIDs; import auth identities (bcrypt hashes are compatible).
 *   5. Verify row counts per table and return a full report. FK constraints
 *      are deliberately left to the autonomy reconciler's governed loop.
 *
 * Safety: refuses non-empty projects (clean-slate import), caps rows per
 * table and wall-clock time, never logs the connection string, and writes
 * start/finish audit entries.
 */

import { Client as PgClient, Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'
import {
  buildImportPlan,
  type ImportPlan,
  type SourcePolicy,
  type SourceTable,
  type TablePlan,
} from './supabase-map'

const DEFAULT_MAX_ROWS_PER_TABLE = 100_000
const BATCH_SIZE = 500
const DEFAULT_BUDGET_MS = 4 * 60 * 1000

// Destination writes go through a module-local pool against the platform DB —
// the same pattern schema-reader/schema-reconciler use.
const destPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })

export interface ImportOptions {
  maxRowsPerTable?: number
  budgetMs?: number
  /** Skip auth.users import (e.g. source key lacks access) */
  skipAuth?: boolean
}

export interface TableReport {
  table: string
  sourceRows: number
  copiedRows: number
  verified: boolean
  truncated: boolean
  warnings: string[]
}

export interface ImportReport {
  ok: boolean
  tables: TableReport[]
  authUsersImported: number
  policies: ImportPlan['policies']
  warnings: string[]
  error?: string
  elapsedMs: number
}

export async function runSupabaseImport(input: {
  projectId: string
  userId: string
  connectionString: string
  options?: ImportOptions
}): Promise<ImportReport> {
  const startedAt = Date.now()
  const budget = input.options?.budgetMs ?? DEFAULT_BUDGET_MS
  const maxRows = input.options?.maxRowsPerTable ?? DEFAULT_MAX_ROWS_PER_TABLE
  const overBudget = () => Date.now() - startedAt > budget

  const report: ImportReport = {
    ok: false,
    tables: [],
    authUsersImported: 0,
    policies: [],
    warnings: [],
    elapsedMs: 0,
  }

  // ── clean-slate guard ────────────────────────────────────────────────────────
  const existing = await prisma.table.count({ where: { projectId: input.projectId } })
  if (existing > 0) {
    report.error =
      `This project already has ${existing} table${existing === 1 ? '' : 's'}. ` +
      `Imports target a fresh project so nothing can be overwritten — create a new project and import there.`
    report.elapsedMs = Date.now() - startedAt
    return report
  }

  await audit(input.projectId, input.userId, 'SUPABASE_IMPORT_STARTED', {})

  // ── source connection ────────────────────────────────────────────────────────
  const source = new PgClient({
    connectionString: input.connectionString,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 30_000,
    query_timeout: 30_000,
    connectionTimeoutMillis: 15_000,
  })

  try {
    await source.connect()
  } catch (e: any) {
    report.error = `Could not connect to the source database: ${e?.message ?? 'connection failed'}`
    report.elapsedMs = Date.now() - startedAt
    await audit(input.projectId, input.userId, 'SUPABASE_IMPORT_FAILED', { reason: 'connect' })
    return report
  }

  try {
    // ── introspection ──────────────────────────────────────────────────────────
    const tables = await introspectSource(source)
    if (tables.length === 0) {
      report.error = 'No tables found in the source public schema.'
      report.elapsedMs = Date.now() - startedAt
      return report
    }
    const policies = await introspectPolicies(source)

    const plan = buildImportPlan(tables, policies)
    report.policies = plan.policies
    report.warnings.push(...plan.warnings)

    // ── create tables through the governed kernel ──────────────────────────────
    for (const t of plan.tables) {
      if (overBudget()) throw new Error('Import time budget exceeded during table creation')
      const result: any = await executeAction(
        {
          type: 'CREATE_TABLE',
          params: {
            tableName: t.targetName,
            columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
          },
        } as any,
        input.projectId,
        undefined,
      )
      if (result && result.success === false) {
        throw new Error(`CREATE_TABLE ${t.targetName} failed: ${result.error ?? 'unknown error'}`)
      }
    }

    // ── copy data ──────────────────────────────────────────────────────────────
    const schemaName = `workspace_${input.projectId}`
    for (const t of plan.tables) {
      if (overBudget()) throw new Error(`Import time budget exceeded while copying ${t.sourceName}`)
      const tr = await copyTable(source, schemaName, t, maxRows, overBudget)
      report.tables.push(tr)
    }

    // ── FK remaps (legacy ids → new UUIDs) ─────────────────────────────────────
    for (const t of plan.tables) {
      for (const remap of t.fkRemaps) {
        await destPool.query(
          `UPDATE "${schemaName}"."${t.targetName}" c
             SET "${remap.column}" = p."id"
            FROM "${schemaName}"."${remap.refTable}" p
           WHERE p."legacy_id" = c."${remap.legacyColumn}"
             AND c."${remap.legacyColumn}" IS NOT NULL`,
        )
      }
    }

    // ── auth identities ────────────────────────────────────────────────────────
    if (!input.options?.skipAuth) {
      try {
        report.authUsersImported = await importAuthUsers(source, input.projectId, schemaName)
      } catch (e: any) {
        report.warnings.push(
          `auth.users could not be imported (${e?.message ?? 'no access'}) — end-users can be re-invited, or re-run with a service_role connection`,
        )
      }
    }

    // ── verification: row counts ───────────────────────────────────────────────
    for (const tr of report.tables) {
      const t = plan.tables.find((x) => x.targetName === tr.table)!
      const destCount = await destPool.query(
        `SELECT COUNT(*)::int AS n FROM "${schemaName}"."${t.targetName}"`,
      )
      const n = destCount.rows[0]?.n ?? 0
      tr.verified = tr.truncated ? n === tr.copiedRows : n === tr.sourceRows
      if (!tr.verified) {
        report.warnings.push(`${tr.table}: destination has ${n} rows, expected ${tr.truncated ? tr.copiedRows : tr.sourceRows}`)
      }
    }

    report.ok = report.tables.every((t) => t.verified)
    report.elapsedMs = Date.now() - startedAt
    await audit(input.projectId, input.userId, 'SUPABASE_IMPORT_COMPLETED', {
      tables: report.tables.length,
      rows: report.tables.reduce((s, t) => s + t.copiedRows, 0),
      authUsers: report.authUsersImported,
      ok: report.ok,
      ms: report.elapsedMs,
    })
    return report
  } catch (e: any) {
    report.error = e?.message ?? 'Import failed'
    report.elapsedMs = Date.now() - startedAt
    await audit(input.projectId, input.userId, 'SUPABASE_IMPORT_FAILED', { reason: report.error?.slice(0, 200) })
    return report
  } finally {
    await source.end().catch(() => {})
  }
}

// ── introspection SQL ──────────────────────────────────────────────────────────

async function introspectSource(source: PgClient): Promise<SourceTable[]> {
  const cols = await source.query(`
    SELECT c.table_name,
           c.column_name,
           c.data_type,
           c.udt_name,
           c.is_nullable = 'YES' AS is_nullable,
           c.column_default IS NOT NULL AS has_default,
           COALESCE(pk.is_pk, false) AS is_pk,
           fk.ref_table,
           fk.ref_column
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT kcu.table_name, kcu.column_name, true AS is_pk
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
      ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
      LEFT JOIN (
        SELECT kcu.table_name, kcu.column_name,
               ccu.table_name AS ref_table, ccu.column_name AS ref_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      ) fk ON fk.table_name = c.table_name AND fk.column_name = c.column_name
     WHERE c.table_schema = 'public'
     ORDER BY c.table_name, c.ordinal_position
  `)

  const byTable = new Map<string, SourceTable>()
  for (const r of cols.rows) {
    let t = byTable.get(r.table_name)
    if (!t) {
      t = { name: r.table_name, columns: [], rowCount: 0 }
      byTable.set(r.table_name, t)
    }
    t.columns.push({
      name: r.column_name,
      dataType: r.data_type,
      udtName: r.udt_name,
      isNullable: r.is_nullable,
      isPrimaryKey: r.is_pk,
      referencedTable: r.ref_table ?? null,
      referencedColumn: r.ref_column ?? null,
      hasDefault: r.has_default,
    })
  }

  for (const t of byTable.values()) {
    const c = await source.query(`SELECT COUNT(*)::int AS n FROM "public"."${t.name}"`)
    t.rowCount = c.rows[0]?.n ?? 0
  }
  return [...byTable.values()]
}

async function introspectPolicies(source: PgClient): Promise<SourcePolicy[]> {
  try {
    const res = await source.query(`
      SELECT tablename AS table, policyname AS name, cmd AS command, qual
        FROM pg_policies
       WHERE schemaname = 'public'
    `)
    return res.rows
  } catch {
    return []
  }
}

// ── data copy ──────────────────────────────────────────────────────────────────

async function copyTable(
  source: PgClient,
  schemaName: string,
  t: TablePlan,
  maxRows: number,
  overBudget: () => boolean,
): Promise<TableReport> {
  const tr: TableReport = {
    table: t.targetName,
    sourceRows: t.rowCount,
    copiedRows: 0,
    verified: false,
    truncated: t.rowCount > maxRows,
    warnings: [...t.warnings],
  }
  if (tr.truncated) {
    tr.warnings.push(`Row cap: copied first ${maxRows} of ${t.rowCount} rows — raise maxRowsPerTable to import the rest`)
  }

  // Destination column list. UUID-pk tables also receive their source id.
  const destCols = t.columns.map((c) => c.name)
  const selectExprs = t.columns.map((c) => c.sourceExpr)
  if (t.pkKind === 'uuid' && t.pkColumn) {
    destCols.unshift('id')
    selectExprs.unshift(`"${t.pkColumn}"`)
  }
  if (destCols.length === 0) return tr

  const orderBy = t.pkColumn ? `ORDER BY "${t.pkColumn}"` : ''
  const limit = Math.min(t.rowCount, maxRows)

  for (let offset = 0; offset < limit; offset += BATCH_SIZE) {
    if (overBudget()) {
      tr.warnings.push('Stopped early: import time budget exceeded')
      break
    }
    const batch = await source.query(
      `SELECT ${selectExprs.join(', ')} FROM "public"."${t.sourceName}" ${orderBy} LIMIT ${Math.min(BATCH_SIZE, limit - offset)} OFFSET ${offset}`,
    )
    if (batch.rows.length === 0) break

    // Multi-row parameterized insert. Fields come back in selectExprs order.
    const fields = batch.fields.map((f) => f.name)
    const values: unknown[] = []
    const tuples: string[] = []
    let p = 1
    for (const row of batch.rows) {
      const placeholders: string[] = []
      for (const f of fields) {
        values.push(row[f])
        placeholders.push(`$${p++}`)
      }
      tuples.push(`(${placeholders.join(', ')})`)
    }
    const insertSql =
      `INSERT INTO "${schemaName}"."${t.targetName}" (${destCols.map((c) => `"${c}"`).join(', ')}) ` +
      `VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`
    await destPool.query(insertSql, values)
    tr.copiedRows += batch.rows.length
  }
  return tr
}

// ── auth identities ────────────────────────────────────────────────────────────

async function importAuthUsers(source: PgClient, projectId: string, schemaName: string): Promise<number> {
  const users = await source.query(`
    SELECT id, email, encrypted_password,
           email_confirmed_at IS NOT NULL AS verified,
           COALESCE(raw_user_meta_data->>'name', raw_user_meta_data->>'full_name') AS name
      FROM auth.users
     WHERE email IS NOT NULL
     LIMIT 50000
  `)
  if (users.rows.length === 0) return 0

  await ensureAuthUsersTable(projectId)

  // Adapt to whatever columns the destination users table actually has.
  const destColsRes = await destPool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users'`,
    [schemaName],
  )
  const destCols = new Set(destColsRes.rows.map((r: any) => r.column_name as string))

  let imported = 0
  for (const u of users.rows) {
    const cols: string[] = ['id', 'email']
    const vals: unknown[] = [u.id, u.email]
    // Supabase bcrypt hashes ($2a$/$2b$) verify directly under bcryptjs.
    if (destCols.has('password') && u.encrypted_password?.startsWith('$2')) {
      cols.push('password')
      vals.push(u.encrypted_password)
    }
    if (destCols.has('name') && u.name) {
      cols.push('name')
      vals.push(u.name)
    }
    if (destCols.has('email_verified')) {
      cols.push('email_verified')
      vals.push(!!u.verified)
    }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ')
    const res = await destPool.query(
      `INSERT INTO "${schemaName}"."users" (${cols.map((c) => `"${c}"`).join(', ')})
       VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      vals,
    )
    imported += res.rowCount ?? 0
  }
  return imported
}

// ── audit ──────────────────────────────────────────────────────────────────────

async function audit(projectId: string, userId: string, action: string, details: Record<string, unknown>) {
  await prisma.auditLog
    .create({
      data: {
        projectId,
        userId,
        action,
        type: 'import',
        details: JSON.stringify({ ...details, at: new Date().toISOString() }),
        timestamp: new Date(),
      },
    })
    .catch(() => {})
}
