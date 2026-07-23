/**
 * Governed read-only SQL for the MCP data plane.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Backenly's rule was "never expose raw SQL". For WRITES that rule is the
 * product: every mutation goes through the governance kernel so it can be
 * planned, approved, verified and reversed. For READS it bought nothing, and
 * cost a great deal:
 *
 *   1. It was already false. `get_database_credentials(mode=READ_ONLY)`
 *      provisions a SELECT-only Postgres role instantly, with no human consent
 *      step. Any agent could already run arbitrary SQL — just outside the
 *      governed channel, where Backenly could neither see it nor bound it.
 *   2. `db_query`'s filter DSL cannot express a join, an aggregate, or a
 *      projection. Measured against 21 realistic database tasks, 17 needed
 *      set-based SQL. Agents hit that wall constantly.
 *   3. A model has seen millions of lines of SQL and zero lines of Backenly's
 *      DSL. Standard grammar is the single largest reliability lever available
 *      to us; a proprietary dialect must be taught in-context, every session.
 *
 * So reads move onto standard SQL, and the escape hatch becomes a front door:
 * bounded, audited, and observable. Writes are untouched and stay typed.
 *
 * ── How isolation is enforced ───────────────────────────────────────────────
 *
 * The query runs as the project's own `bkn_ro_<hex>` role — the same role
 * `get_database_credentials` hands out, whose grants are exactly
 * `USAGE ON SCHEMA workspace_<projectId>` + `SELECT`. Cross-tenant reads are
 * therefore refused by POSTGRES, not by inspecting the SQL. That distinction is
 * the whole design: a schema-qualified `SELECT * FROM workspace_other.users`
 * fails on a missing grant, and no parser has to be clever enough to catch it.
 * `search_path` is a convenience, never the boundary.
 *
 * The syntactic guards below are defence in depth for clearer errors and to
 * refuse statement smuggling. They are NOT the security boundary, and must
 * never be relied on as one.
 */

import { Client } from 'pg'
import { provisionDirectAccess, getDirectAccessStatus } from '@/lib/services/direct-access'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'

export const MAX_ROWS = 1000
export const DEFAULT_ROWS = 200
/** Well under the role's own 60s ceiling — an agent should fail fast, not hang. */
const STATEMENT_TIMEOUT_MS = 15_000

export interface ReadQueryResult {
  rows: Record<string, unknown>[]
  rowCount: number
  /** True when the cap clipped the result — the agent must know it is partial. */
  truncated: boolean
  fields: { name: string; dataType: string }[]
  redactedColumns: string[]
  ms: number
}

export class ReadQueryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ReadQueryError'
  }
}

// ── Guards ───────────────────────────────────────────────────────────────────

/**
 * Strip string literals, dollar-quoted blocks and comments before keyword
 * checks, so a row containing the word "delete" can never look like a DELETE.
 * Analysing raw text without this is how naive SQL guards produce both false
 * positives and false negatives.
 */
export function stripSqlNoise(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const two = sql.slice(i, i + 2)
    if (two === '--') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl
      continue
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      out += ' '
      continue
    }
    const ch = sql[i]
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue } // escaped quote
          i++
          break
        }
        i++
      }
      out += ' '
      continue
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        i = close === -1 ? sql.length : close + tag[0].length
        out += ' '
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

/** Verbs that may begin a statement. EXPLAIN is allowed; ANALYZE is not. */
const READ_VERBS = /^(select|with|explain|show|table|values)\b/i

/**
 * Write verbs. Checked across the WHOLE statement, not just the start, because
 * `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x` begins with WITH and
 * is a data-modifying statement.
 */
const WRITE_VERBS =
  /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|comment|reindex|vacuum|refresh|call|do|copy|import|lock|listen|notify|prepare|execute|reset|discard|security\s+label)\b/i

export function assertReadOnlySql(sqlRaw: string): void {
  const sql = sqlRaw.trim()
  if (!sql) {
    throw new ReadQueryError('Empty query.', 'EMPTY_QUERY')
  }

  const bare = stripSqlNoise(sql).trim().replace(/;\s*$/, '')

  if (bare.includes(';')) {
    throw new ReadQueryError(
      'Only a single statement is allowed. Remove the ";" and send one query per call.',
      'MULTI_STATEMENT',
      'Run statements one at a time so each result is attributable.',
    )
  }

  if (!READ_VERBS.test(bare)) {
    throw new ReadQueryError(
      `run_query executes read-only SQL. A statement must begin with SELECT, WITH, EXPLAIN, SHOW, TABLE or VALUES.`,
      'NOT_READ_ONLY',
      // Name the ADVERTISED doors. This used to say "create_table, add_column"
      // — real brain tools that the MCP manifest does not list, so an agent
      // reading this refusal was sent to two tools it could not call, inside the
      // message explaining what it did wrong. `apply_migration` takes the DDL
      // the agent already wrote and translates it into those same governed
      // actions, which is the answer it was looking for.
      'To change the SCHEMA, send the same DDL to apply_migration — it translates CREATE TABLE / ALTER TABLE / CREATE INDEX into governed, reversible actions. To change ROWS use db_insert, db_update or db_delete. For anything else, describe it to backend_chat.',
    )
  }

  const write = WRITE_VERBS.exec(bare)
  if (write) {
    throw new ReadQueryError(
      `run_query is read-only and rejected the keyword "${write[1].toUpperCase()}".`,
      'NOT_READ_ONLY',
      'Mutations go through the governed tools so they are reversible and auditable: apply_migration for schema (send the DDL as written), db_insert / db_update / db_delete for rows.',
    )
  }

  // EXPLAIN ANALYZE actually EXECUTES the plan. Harmless for a SELECT under a
  // read-only role, but it would run a data-modifying statement for real if one
  // ever slipped past the checks above, so refuse it rather than depend on them.
  if (/^explain\b/i.test(bare) && /\banalyze\b/i.test(bare)) {
    throw new ReadQueryError(
      'EXPLAIN ANALYZE executes the statement. Use plain EXPLAIN for the plan.',
      'NOT_READ_ONLY',
    )
  }

  const catalog = CATALOG_REFERENCE.exec(bare)
  if (catalog) {
    throw new ReadQueryError(
      `run_query does not read the PostgreSQL system catalogs (matched "${catalog[0]}").`,
      'CATALOG_NOT_READABLE',
      'The catalogs are shared by every project on the instance, so a query against ' +
      'them is not scoped to yours. To inspect YOUR schema use read_backend_state ' +
      '{section:"tables"} or get_table_schema {tableName} — those answer the same questions ' +
      'and only ever describe this project.',
    )
  }
}

/**
 * System-catalog and information_schema references, which `run_query` refuses.
 *
 * ── Why a syntactic refusal here, when grants are the boundary everywhere else ─
 *
 * This module's own header says the guards are defence in depth and "must never
 * be relied on" as the security boundary — because for TENANT ROWS they are not.
 * A `SELECT * FROM workspace_other.orders` fails on a missing grant, and that is
 * a guarantee no parser bug can undo.
 *
 * The catalogs are the one place where that argument does not hold, and the
 * documentation claimed otherwise. `pg_catalog` is readable by PUBLIC by
 * default and is INSTANCE-WIDE, not per-schema: a plain
 * `SELECT proname, prosrc FROM pg_proc` from a project's read-only role returned
 * the full source of ~10 other tenants' functions, and `pg_namespace` enumerates
 * every customer's schema — hence every customer's project id. Reported from a
 * real session on 2026-07-22 against the claim that run_query "cannot read
 * another project."
 *
 * There is no grant that fixes this proportionately. Revoking the catalogs from
 * PUBLIC instance-wide would break `pg_dump` and `\d` for the read-only
 * credentials this platform deliberately hands out (see lib/services/
 * direct-access.ts) — a shipped feature traded away to close a metadata leak.
 * So this boundary IS syntactic, and saying so plainly is part of the fix: the
 * claim in the docs has been corrected to match rather than the other way round.
 *
 * What the refusal costs is nothing an agent needs: schema introspection is
 * served by read_backend_state and get_table_schema, which read the live catalog
 * server-side and filter to the calling project. The hint names them, because a
 * refusal that does not say where to go instead costs a whole turn of guessing.
 *
 * ── Why the rule is a PREFIX and not a list of catalog names ─────────────────
 *
 * PostgreSQL reserves the `pg_` prefix for system use — `CREATE TABLE pg_foo`
 * is refused by the server itself. So "any identifier beginning with pg_" is
 * exhaustive over the catalogs AND cannot collide with a tenant's own table, in
 * this version of Postgres or any later one that adds new catalogs. An
 * enumerated list would have to be maintained forever and would be wrong the
 * first time it was not.
 *
 * Matched after `stripSqlNoise`, so a row whose TEXT contains "pg_proc" cannot
 * trip it, and on word boundaries, so a column named `information_schema_notes`
 * is not a false positive.
 */
const CATALOG_REFERENCE = /\b(?:information_schema|pg_[a-z0-9_]+)\b/i

// ── Redaction ────────────────────────────────────────────────────────────────

/**
 * Secret-bearing columns are blanked before the rows leave the process.
 *
 * The read-only role can legitimately SELECT the end-user `users` table (a
 * deliberate direct-access decision: an owner may read their own project's
 * data). That is defensible for a human at a psql prompt. It is NOT the same
 * risk for an agent, whose results land in an LLM context window, a host
 * transcript, and quite possibly a log the user never reads. `/db/users` is
 * locked for exactly this reason, and this surface must not quietly reopen it.
 *
 * Values are replaced, not dropped, so the shape of the result still tells the
 * agent the column exists.
 */
const SECRET_COLUMN = /(password|passwd|pwd|secret|token|api_?key|private_?key|salt|cipher|credential)/i

export function redactRows(
  rows: Record<string, unknown>[],
): { rows: Record<string, unknown>[]; redactedColumns: string[] } {
  if (rows.length === 0) return { rows, redactedColumns: [] }
  const redacted = Object.keys(rows[0]).filter((c) => SECRET_COLUMN.test(c))
  if (redacted.length === 0) return { rows, redactedColumns: [] }
  return {
    rows: rows.map((r) => {
      const copy = { ...r }
      for (const c of redacted) if (copy[c] !== null && copy[c] !== undefined) copy[c] = '[redacted]'
      return copy
    }),
    redactedColumns: redacted,
  }
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * Internal connection info. The stored credential's host is the PUBLIC one
 * (backenly.com) because it is built for a developer's psql; the server sits on
 * the same box as Postgres, so it dials localhost instead of leaving the machine.
 */
function internalTarget(): { host: string; port: number; database: string } {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost:5432/backenly')
  return {
    host: url.hostname || 'localhost',
    port: parseInt(url.port || '5432', 10),
    database: url.pathname.replace(/^\//, '').split('?')[0] || 'backenly',
  }
}

async function readOnlyCredential(projectId: string) {
  const status = await getDirectAccessStatus(projectId)
  const existing = status.credentials.find((c) => c.mode === 'READ_ONLY')
  if (existing) return existing
  // Provisioning is idempotent and instant; a read tool should never make the
  // agent go and arrange its own access first.
  return provisionDirectAccess(projectId, 'READ_ONLY')
}

export async function runReadQuery(
  projectId: string,
  sql: string,
  limit: number = DEFAULT_ROWS,
): Promise<ReadQueryResult> {
  assertReadOnlySql(sql)
  try {
    return await execute(projectId, sql, limit)
  } catch (err) {
    // 42501 = insufficient_privilege. A table created outside the governed DDL
    // path has no grant for the read-only role yet, and the agent would see a
    // baffling "permission denied" for a table it can plainly see in
    // list_tables. Re-syncing is idempotent and only ever grants THIS project's
    // own schema, so a genuine cross-tenant attempt still fails after the retry.
    if ((err as { code?: string })?.code !== '42501') throw err
    const { syncDirectAccessGrants } = await import('@/lib/services/direct-access')
    await syncDirectAccessGrants(projectId)
    return execute(projectId, sql, limit)
  }
}

async function execute(
  projectId: string,
  sql: string,
  limit: number,
): Promise<ReadQueryResult> {
  const cap = Math.min(Math.max(1, Math.floor(limit)), MAX_ROWS)
  const schema = workspaceSchemaName(projectId)
  const cred = await readOnlyCredential(projectId)
  const { host, port, database } = internalTarget()

  const client = new Client({
    host,
    port,
    database,
    user: cred.roleName,
    password: cred.password,
    // Localhost on the app box; TLS is not adding anything over the loopback
    // and the snakeoil cert would fail verification anyway.
    ssl: false,
    connectionTimeoutMillis: 10_000,
statement_timeout: STATEMENT_TIMEOUT_MS,
  } as any)

  const started = Date.now()
  try {
    await client.connect()
    // Read-only transaction: a second, independent guarantee alongside the
    // role's grants and its default_transaction_read_only setting.
    await client.query('BEGIN READ ONLY')
    await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`)
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    const res = await client.query({ text: capped(sql, cap), rowMode: 'array' })
    await client.query('ROLLBACK')

    const fields = (res.fields ?? []).map((f: any) => ({ name: f.name, dataType: String(f.dataTypeID) }))
    const all = materialise(res.rows as unknown as unknown[][], fields)
    const truncated = all.length > cap
    const { rows, redactedColumns } = redactRows(truncated ? all.slice(0, cap) : all)

    return {
      rows,
      rowCount: rows.length,
      truncated,
      fields,
      redactedColumns,
      ms: Date.now() - started,
    }
  } finally {
    await client.end().catch(() => {})
  }
}

/**
 * Enforce the row cap IN POSTGRES rather than by slicing what came back.
 *
 * Truncating after the fact still transfers and materialises every row, so a
 * `SELECT * FROM a_million_rows` would exhaust memory before the cap ever
 * applied — the cap would look like it worked while protecting nothing.
 *
 * One extra row is requested so truncation can be reported honestly instead of
 * returning exactly `cap` rows and leaving the agent to guess whether more
 * exist. Postgres permits duplicate output column names in a subquery, so a
 * join selecting `a.id` and `b.id` wraps without complaint.
 *
 * EXPLAIN / SHOW cannot be wrapped in a subquery and return trivially few rows,
 * so they are passed through untouched.
 */
export function capped(sql: string, cap: number): string {
  const bare = sql.trim().replace(/;\s*$/, '')
  if (/^(explain|show)\b/i.test(stripSqlNoise(bare).trim())) return bare
  return `SELECT * FROM (\n${bare}\n) AS _bkn_read_query LIMIT ${cap + 1}`
}

/**
 * `rowMode: 'array'` is used so duplicate column names from a join survive as
 * distinct columns. Object mode silently collapses `a.id` and `b.id` into one
 * key — a wrong answer with no error, which is exactly the failure class this
 * whole change exists to remove.
 */
function materialise(rows: unknown[][], fields: { name: string }[]): Record<string, unknown>[] {
  const seen = new Map<string, number>()
  const names = fields.map((f) => {
    const n = seen.get(f.name) ?? 0
    seen.set(f.name, n + 1)
    return n === 0 ? f.name : `${f.name}__${n + 1}`
  })
  return rows.map((r) => {
    const o: Record<string, unknown> = {}
    names.forEach((name, i) => { o[name] = r[i] })
    return o
  })
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
