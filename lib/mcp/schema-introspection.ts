/**
 * MCP SCHEMA INTROSPECTION
 * ========================
 * The single highest-leverage thing an agent-facing backend can do: hand the
 * LLM a complete, structured, *current* view of the backend so it never has to
 * guess. This is the lesson from the MCPMark benchmark — richer context →
 * fewer retries, fewer tokens, higher pass rate.
 *
 *   getTableSchema(projectId, table)  — one table, everything:
 *       columns (type/nullable/default/pk), foreign keys, indexes,
 *       CHECK constraints (with the actual allowed values), triggers,
 *       rlsEnabled + forceRls + the live policies, and the exact record count.
 *
 *   getBackendMetadata(projectId)     — the whole backend at a glance:
 *       every table with record count + column count + rlsEnabled + policyCount,
 *       every foreign-key relationship, and auth/storage/realtime/function state.
 *
 * All reads run against the live PostgreSQL catalog (information_schema /
 * pg_catalog) so they can never drift from the real schema. Record counts run
 * with the service-role RLS context so FORCE-RLS'd tables report true totals.
 */

import { prisma } from '@/lib/db/prisma'
import { executeWithUserContext } from '@/lib/services/workspace-rls'

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i

function schemaFor(projectId: string): string {
  return `workspace_${projectId}`
}

/**
 * PostgREST-style exposure rule: the catalog is the single source of truth, but
 * internal plumbing tables (presence tracking, email-verification, migration
 * bookkeeping — anything `_`-prefixed) are not part of the developer's backend
 * and must not surface to the agent. Everything else a project created IS
 * exposed, the instant it exists — no separate "generated API" record required.
 */
export function isExposedTable(name: string): boolean {
  if (!name) return false
  if (name.startsWith('_')) return false
  if (name.startsWith('pg_') || name === 'spatial_ref_sys') return false
  return true
}

/**
 * The end-user auth identity table. It lives in the workspace schema but is
 * managed exclusively through /auth/* (signup/signin) — it holds password
 * hashes and MUST NEVER be reachable as a generic /db/users CRUD endpoint
 * (auth identity tables are kept out of the exposed API for this reason). It
 * stays VISIBLE in list_tables/metadata (it's a real table) but is never
 * CRUD-exposed and never auto-materialized into an API.
 */
export function isAuthManagedTable(name: string): boolean {
  return String(name || '').toLowerCase() === 'users'
}

/** A table an agent-built app may CRUD over /db/<table>: exposed AND not auth-managed. */
export function isCrudExposable(name: string): boolean {
  return isExposedTable(name) && !isAuthManagedTable(name)
}

/** Deep-convert BigInt → Number so the payload is always JSON-safe. */
function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)),
  )
}

/**
 * Runtime existence gate, catalog-truth. A workspace table is servable iff it
 * physically exists AND is exposed (not internal plumbing). This replaces the
 * prisma.table metadata gate in the v1 runtime so a table is servable the
 * instant it exists and stops the instant it's dropped — PostgREST semantics,
 * one source of truth. Validates the identifier defensively.
 */
export async function workspaceTableExists(projectId: string, tableName: string): Promise<boolean> {
  const t = String(tableName || '').toLowerCase()
  if (!IDENT.test(t) || !isExposedTable(t)) return false
  return tableExists(schemaFor(projectId), t)
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2
     ) AS exists`,
    schema,
    table,
  )
  return rows[0]?.exists === true
}

async function recordCount(projectId: string, schema: string, table: string): Promise<number> {
  try {
    // ::int keeps count() out of BigInt land; service-role sees FORCE-RLS rows.
    const rows = await executeWithUserContext<{ c: number }>(
      '',
      true,
      `SELECT count(*)::int AS c FROM "${schema}"."${table}"`,
    )
    return Number(rows[0]?.c ?? 0)
  } catch {
    return 0
  }
}

export interface TableColumn {
  name: string
  type: string
  nullable: boolean
  default: string | null
  primaryKey: boolean
  maxLength: number | null
}

export interface TableSchema {
  table: string
  schema: string
  recordCount: number
  rlsEnabled: boolean
  forceRls: boolean
  columns: TableColumn[]
  primaryKey: string[]
  foreignKeys: Array<{ column: string; references: string; onDelete?: string }>
  indexes: Array<{ name: string; definition: string; unique: boolean }>
  checkConstraints: Array<{ name: string; definition: string }>
  triggers: Array<{ name: string; timing: string; event: string }>
  policies: Array<{ name: string; command: string; using: string | null; withCheck: string | null }>
}

/** Full, RLS-aware schema for a single workspace table. */
export async function getTableSchema(projectId: string, tableNameRaw: string): Promise<TableSchema> {
  const table = String(tableNameRaw || '').toLowerCase()
  if (!IDENT.test(table)) throw new Error(`Invalid table name "${tableNameRaw}".`)
  const schema = schemaFor(projectId)
  if (!(await tableExists(schema, table))) {
    throw new Error(`Table "${table}" does not exist in this project.`)
  }

  const [colsRaw, pkRaw, fksRaw, idxRaw, checksRaw, trigRaw, rlsRaw, polRaw, count] =
    await Promise.all([
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
        schema, table,
      ),
      prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
        schema, table,
      ),
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT kcu.column_name AS from_col,
                ccu.table_name  AS to_table,
                ccu.column_name AS to_col,
                rc.delete_rule  AS on_delete
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
           JOIN information_schema.referential_constraints rc
             ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
        schema, table,
      ),
      prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
        schema, table,
      ),
      prisma.$queryRawUnsafe<Array<{ conname: string; def: string }>>(
        `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
          WHERE con.contype = 'c' AND nsp.nspname = $1 AND rel.relname = $2`,
        schema, table,
      ),
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT trigger_name, action_timing, event_manipulation
           FROM information_schema.triggers
          WHERE trigger_schema = $1 AND event_object_table = $2`,
        schema, table,
      ),
      prisma.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = $2 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)`,
        schema, table,
      ),
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = $1 AND tablename = $2`,
        schema, table,
      ),
      recordCount(projectId, schema, table),
    ])

  const pkCols = new Set(pkRaw.map((r) => r.column_name))
  const columns: TableColumn[] = colsRaw.map((c) => ({
    name: c.column_name,
    type: c.data_type,
    nullable: c.is_nullable === 'YES',
    default: c.column_default ?? null,
    primaryKey: pkCols.has(c.column_name),
    maxLength: c.character_maximum_length ?? null,
  }))

  return jsonSafe({
    table,
    schema,
    recordCount: count,
    rlsEnabled: rlsRaw[0]?.relrowsecurity ?? false,
    forceRls: rlsRaw[0]?.relforcerowsecurity ?? false,
    columns,
    primaryKey: Array.from(pkCols),
    foreignKeys: fksRaw.map((f) => ({
      column: f.from_col,
      references: `${f.to_table}.${f.to_col}`,
      onDelete: f.on_delete,
    })),
    indexes: idxRaw.map((i) => ({
      name: i.indexname,
      definition: i.indexdef,
      unique: /CREATE UNIQUE/i.test(i.indexdef),
    })),
    checkConstraints: checksRaw.map((c) => ({ name: c.conname, definition: c.def })),
    triggers: trigRaw.map((t) => ({
      name: t.trigger_name,
      timing: t.action_timing,
      event: t.event_manipulation,
    })),
    policies: polRaw.map((p) => ({
      name: p.policyname,
      command: p.cmd,
      using: p.qual ?? null,
      withCheck: p.with_check ?? null,
    })),
  })
}

/**
 * Catalog-truth table list: exactly the tables that physically exist and are
 * exposed, with live column + record counts. Replaces the old metadata read
 * (prisma.table) that could disagree with the real schema — the exact read-drift
 * that made an agent query tables that no longer existed.
 */
export async function listExposedTables(
  projectId: string,
): Promise<Array<{ name: string; columns: number; recordCount: number; rlsEnabled: boolean }>> {
  const schema = schemaFor(projectId)
  const [tableRows, colCounts, rlsRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      schema,
    ),
    prisma.$queryRawUnsafe<Array<{ table_name: string; c: number }>>(
      `SELECT table_name, count(*)::int AS c FROM information_schema.columns
        WHERE table_schema = $1 GROUP BY table_name`,
      schema,
    ),
    prisma.$queryRawUnsafe<Array<{ relname: string; relrowsecurity: boolean }>>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1) AND relkind = 'r'`,
      schema,
    ),
  ])
  const colMap = new Map(colCounts.map((r) => [r.table_name, Number(r.c)]))
  const rlsMap = new Map(rlsRows.map((r) => [r.relname, r.relrowsecurity]))
  return Promise.all(
    tableRows
      .filter((t) => isExposedTable(t.table_name))
      .map(async (t) => ({
        name: t.table_name,
        columns: colMap.get(t.table_name) ?? 0,
        recordCount: await recordCount(projectId, schema, t.table_name),
        rlsEnabled: rlsMap.get(t.table_name) ?? false,
      })),
  )
}

export interface BackendMetadata {
  projectId: string
  tables: Array<{ name: string; recordCount: number; columns: number; rlsEnabled: boolean; policyCount: number }>
  relationships: Array<{ from: string; column: string; to: string; toColumn: string }>
  auth: { enabled: boolean; providers: string[] }
  storage: { buckets: string[] }
  realtime: { tables: string[] }
  functions: { count: number; names: string[] }
}

/** One-call structured view of the entire backend. */
export async function getBackendMetadata(projectId: string): Promise<BackendMetadata> {
  const schema = schemaFor(projectId)

  const [tableRows, colCounts, policyCounts, rlsRows, fkRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      schema,
    ),
    prisma.$queryRawUnsafe<Array<{ table_name: string; c: number }>>(
      `SELECT table_name, count(*)::int AS c FROM information_schema.columns
        WHERE table_schema = $1 GROUP BY table_name`,
      schema,
    ),
    prisma.$queryRawUnsafe<Array<{ tablename: string; c: number }>>(
      `SELECT tablename, count(*)::int AS c FROM pg_policies WHERE schemaname = $1 GROUP BY tablename`,
      schema,
    ),
    prisma.$queryRawUnsafe<Array<{ relname: string; relrowsecurity: boolean }>>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1) AND relkind = 'r'`,
      schema,
    ),
    prisma.$queryRawUnsafe<Array<any>>(
      `SELECT tc.table_name AS from_table, kcu.column_name AS from_col,
              ccu.table_name AS to_table, ccu.column_name AS to_col
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
      schema,
    ),
  ])

  const colMap = new Map(colCounts.map((r) => [r.table_name, Number(r.c)]))
  const polMap = new Map(policyCounts.map((r) => [r.tablename, Number(r.c)]))
  const rlsMap = new Map(rlsRows.map((r) => [r.relname, r.relrowsecurity]))

  const tables = await Promise.all(
    tableRows
      .filter((t) => isExposedTable(t.table_name))
      .map(async (t) => ({
        name: t.table_name,
        recordCount: await recordCount(projectId, schema, t.table_name),
        columns: colMap.get(t.table_name) ?? 0,
        rlsEnabled: rlsMap.get(t.table_name) ?? false,
        policyCount: polMap.get(t.table_name) ?? 0,
      })),
  )

  // Auth / storage / realtime / functions from the platform side.
  const { collectProof } = await import('@/lib/ai/proof-system')
  const proof = await collectProof(projectId).catch(() => null)
  const fnRows = await prisma.aiFunction
    .findMany({ where: { projectId }, select: { name: true } })
    .catch(() => [] as Array<{ name: string }>)

  return jsonSafe({
    projectId,
    tables,
    relationships: fkRows.map((f) => ({
      from: f.from_table,
      column: f.from_col,
      to: f.to_table,
      toColumn: f.to_col,
    })),
    auth: {
      enabled: proof?.authEnabled ?? false,
      providers: proof?.authProviders ?? [],
    },
    storage: { buckets: (proof?.buckets as string[]) ?? [] },
    realtime: { tables: (proof?.realtimeTables as string[]) ?? [] },
    functions: { count: fnRows.length, names: fnRows.map((f) => f.name) },
  })
}
