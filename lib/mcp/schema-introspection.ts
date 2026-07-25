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

/**
 * `pg_policies.roles` → a plain string array.
 *
 * The column is `name[]`. Depending on how the driver maps it, it arrives either
 * already as an array or as PostgreSQL's array literal (`{authenticated,anon}`).
 * Returning the literal would hand an agent a string it has to parse, which is
 * the sort of thing that turns a fix into a new bug one layer down.
 */
function normalizeRoles(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((r) => String(r))
  if (typeof raw === 'string') {
    const inner = raw.replace(/^\{/, '').replace(/\}$/, '').trim()
    if (!inner) return []
    return inner.split(',').map((r) => r.trim().replace(/^"|"$/g, '')).filter(Boolean)
  }
  return []
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
  /**
   * Columns whose names are NOT lower-case and therefore MUST be double-quoted in
   * SQL, plus a ready-to-read note when a table mixes conventions.
   *
   * ── Why this is in the payload ──────────────────────────────────────────────
   *
   * Backenly provisions `createdAt` / `updatedAt` (camelCase) alongside
   * `deleted_at` (snake_case), and authors add snake_case columns of their own. So
   * a single table genuinely mixes conventions, and in PostgreSQL that is not
   * cosmetic: an unquoted `createdAt` folds to `createdat` and the query fails
   * with `column "createdat" does not exist`, while `deleted_at` needs no quoting
   * at all. An agent has to get this right per column, and reported the mix as a
   * real cost (defect #20).
   *
   * The column names themselves cannot be changed without a breaking migration on
   * every existing project — `"createdAt"` appears in generated SQL throughout the
   * platform, and `deleted_at` is what the soft-delete filters and autonomy probes
   * look for. Renaming either would trade a naming inconsistency for broken
   * queries on live backends.
   *
   * What CAN be removed is the guesswork, which is where the cost actually lands.
   * This states the rule for this table, computed from its real columns.
   */
  identifierQuoting: {
    /** Columns that must be written as "Name" in SQL. */
    mustQuote: string[]
    /** Present only when the table mixes conventions. */
    note?: string
  }
  primaryKey: string[]
  foreignKeys: Array<{ column: string; references: string; onDelete?: string }>
  indexes: Array<{ name: string; definition: string; unique: boolean }>
  checkConstraints: Array<{ name: string; definition: string }>
  triggers: Array<{ name: string; timing: string; event: string }>
  /**
   * Live RLS policies.
   *
   * ── Why `roles` is here ─────────────────────────────────────────────────────
   *
   * It was missing, and its absence made a correctly-scoped policy read as a
   * security hole. `bkn_direct_read USING (true)` looks like a wide-open SELECT
   * on every row until you know it is granted only to the direct-connection
   * role — and with `roles` absent there was no way to know that from this tool.
   * An agent reviewing the schema reported it as an exposure and only ruled it
   * out by noticing the same policy on a table it had never touched (defect #17).
   *
   * `run_query` refuses `pg_policies` for good reason — the catalogs are
   * instance-wide, not per-project — so there was no fallback either (defect #18).
   * The fix belongs here, in the tool that already reads the catalog server-side
   * and filters to the calling project, rather than in loosening that refusal.
   *
   * `permissive` is included for the same reason: a RESTRICTIVE policy ANDs with
   * the others instead of ORing, so two policies that look permissive in
   * isolation can combine into something much narrower.
   */
  policies: Array<{
    name: string
    command: string
    /** Database roles the policy applies to. `["public"]` means every role. */
    roles: string[]
    /** PERMISSIVE (ORed with other policies) or RESTRICTIVE (ANDed). */
    permissive: string
    using: string | null
    withCheck: string | null
    /**
     * ── The same rule, in the form you can send BACK to set_rls ──────────────
     *
     * `using` / `withCheck` above are PostgreSQL's rendering, and it is not
     * round-trippable. Postgres stores what Backenly installed, which wraps the
     * author's predicate in the service-role escape and schema-qualifies the
     * claim reader:
     *
     *   ((backenly_jwt_claim('role') = 'service_role')
     *     OR (sender_id::text = "workspace_x"."backenly_jwt_claim"('sub')))
     *
     * Feeding that back to set_rls fails twice over — the predicate grammar
     * refuses a quoted function name, and the service-role clause would be
     * double-wrapped by the installer that adds it.
     *
     * So an agent told to "read the current policy and re-send the commands you
     * are not changing" could not actually do it, and would fall back to
     * rewriting the predicate from its own understanding — which is the
     * re-derivation this whole surface exists to stop.
     *
     * These fields are that predicate as the author would write it: service-role
     * clause removed, claim reader unqualified. Copy them verbatim into
     * set_rls. Null when the policy is not one Backenly installed.
     */
    editableUsing: string | null
    editableCheck: string | null
  }>
}

/**
 * Turn PostgreSQL's rendering of a Backenly policy back into the predicate an
 * author would write — the exact string that can be sent to `set_rls`.
 *
 * Two transformations, both the inverse of what the installer did:
 *
 *   1. Drop the leading service-role escape. `installCustomPolicySet` emits
 *      `(<service-role check> OR (<author predicate>))`, and that clause is
 *      Backenly's, not the caller's: it is re-added on every install, so
 *      returning it here would double-wrap on the next write.
 *   2. Unqualify the claim reader. Postgres renders it as
 *      `"workspace_x"."backenly_jwt_claim"('sub')`, and the predicate grammar
 *      refuses a quoted function name outright.
 *
 * Returns null when the shape is not one Backenly installed — a hand-written or
 * direct-connection policy is reported as-is rather than guessed at, because a
 * wrong "editable" form is worse than none: it invites an agent to send back a
 * predicate that does not mean what the live one means.
 */
export function toAuthorForm(raw: string | null | undefined, schema: string): string | null {
  if (!raw || typeof raw !== 'string') return null

  // Not a Backenly-installed policy: no service-role escape to peel. Reported
  // as-is by the caller rather than guessed at.
  if (!/service_role/i.test(raw)) return null

  let s = stripWrappingParens(raw.trim())

  // Split on the FIRST top-level OR. Everything left of it is Backenly's
  // service-role escape; everything right of it is the author's predicate.
  // Done by paren depth rather than by matching the escape's exact text, which
  // varies with how PostgreSQL chooses to render casts ('role' vs 'role'::text)
  // and parenthesise the comparison.
  const split = splitFirstTopLevelOr(s)
  if (!split) return null
  const [head, tail] = split
  if (!/service_role/i.test(head)) return null   // OR was the author's, not ours

  s = stripWrappingParens(tail.trim())

  // Unqualify the claim reader back to its callable, grammar-legal spelling.
  // Quoted and unquoted renderings both occur depending on the catalog.
  s = s.replace(
    new RegExp(`"?${schema}"?\\s*\\.\\s*"?backenly_jwt_claim"?\\s*\\(`, 'gi'),
    'backenly_jwt_claim(',
  )
  // The EXISTS clause carries a schema-qualified table; set_rls re-qualifies it
  // from the project's own schema name, so it goes back to a bare table name.
  s = s.replace(new RegExp(`"?${schema}"?\\s*\\.\\s*(?=")`, 'gi'), '')

  return s.trim() || null
}

/** Remove redundant paren pairs that wrap the WHOLE expression. */
function stripWrappingParens(input: string): string {
  let s = input.trim()
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0
    let wraps = true
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (ch === "'") { i++; while (i < s.length && s[i] !== "'") i++; continue }
      if (ch === '(') depth++
      else if (ch === ')') { depth--; if (depth === 0 && i < s.length - 1) { wraps = false; break } }
    }
    if (!wraps) break
    s = s.slice(1, -1).trim()
  }
  return s
}

/** `[before, after]` around the first depth-0 `OR`, or null if there is none. */
function splitFirstTopLevelOr(s: string): [string, string] | null {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'") { i++; while (i < s.length && s[i] !== "'") i++; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }
    if (
      depth === 0 &&
      (ch === 'o' || ch === 'O') &&
      /^or\b/i.test(s.slice(i)) &&
      (i === 0 || /[\s)]/.test(s[i - 1]))
    ) {
      return [s.slice(0, i), s.slice(i + 2)]
    }
  }
  return null
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
        `SELECT policyname, cmd, roles, permissive, qual, with_check
           FROM pg_policies WHERE schemaname = $1 AND tablename = $2`,
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

  // Anything not already lower-case folds when unquoted, so it must be quoted.
  const mustQuote = columns.map((c) => c.name).filter((n) => n !== n.toLowerCase())
  const hasSnake = columns.some((c) => c.name.includes('_') && c.name === c.name.toLowerCase())

  return jsonSafe({
    table,
    schema,
    recordCount: count,
    rlsEnabled: rlsRaw[0]?.relrowsecurity ?? false,
    forceRls: rlsRaw[0]?.relforcerowsecurity ?? false,
    columns,
    identifierQuoting: {
      mustQuote,
      ...(mustQuote.length && hasSnake
        ? {
            note:
              `This table mixes naming conventions. ${mustQuote.map((n) => `"${n}"`).join(', ')} ` +
              `${mustQuote.length === 1 ? 'is' : 'are'} camelCase and MUST be double-quoted in SQL — ` +
              `unquoted, PostgreSQL folds ${mustQuote.length === 1 ? 'it' : 'them'} to lower case and the ` +
              `query fails with \`column "${mustQuote[0].toLowerCase()}" does not exist\`. The snake_case ` +
              `columns need no quoting. Backenly provisions createdAt/updatedAt in camelCase and deleted_at ` +
              `in snake_case; the names cannot be unified without breaking existing backends, so quote by ` +
              `this list rather than by convention.`,
          }
        : {}),
    },
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
      // pg_policies.roles is a name[]; the pg driver may hand it back as an
      // array or as the literal `{a,b}` text form depending on the type mapping.
      // Both are normalised here so the field is never a raw `{...}` string an
      // agent has to parse.
      roles: normalizeRoles(p.roles),
      permissive: String(p.permissive ?? 'PERMISSIVE'),
      using: p.qual ?? null,
      withCheck: p.with_check ?? null,
      editableUsing: toAuthorForm(p.qual, schema),
      editableCheck: toAuthorForm(p.with_check, schema),
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
