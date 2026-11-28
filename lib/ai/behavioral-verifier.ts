/**
 * BEHAVIORAL VERIFICATION ENGINE
 * ================================
 * Phase 3 — Full behavioral correctness gate for generated backends.
 *
 * Verifies that a project's generated backend actually works end-to-end:
 *
 *  3.1  CRUD lifecycle    — create → read → update → delete → post-delete reads nothing
 *  3.2  Auth flow         — signup → token issuance → JWT verification → protected access
 *  3.3  RLS isolation     — user A inserts row → user B correctly sees nothing
 *  3.4  Row-event functions — a row change reaches each function that runs on it
 *  3.5  Webhook HMAC      — invalid signature → 401 rejection
 *
 * A project's backend is "done" only when this file says it passes.
 * The result is consumed by:
 *  - dynamic-agent-loop.ts  → verifyCompletion() primary gate (3.6)
 *  - readiness-scorer.ts    → blocking check before production deploy (3.6)
 *
 * Design principles:
 *  - Each check is independent; failures in one do not prevent others from running.
 *  - Skipped checks (not applicable) never count as failures.
 *  - The checks that write test rows (3.1 to 3.4) write them inside a
 *    transaction that is always rolled back, so they leave nothing behind and
 *    no captured change reaches a function or a webhook. 3.6 goes through the
 *    live HTTP stack and cleans up after itself.
 *  - Checks run in parallel where there are no data dependencies.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { generateToken, verifyToken } from '@/lib/auth/jwt'
import { hashPassword } from '@/lib/auth/password'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'
import crypto from 'crypto'
import { internalTrafficHeaders } from '@/lib/traffic/request-recorder'
import { rlsSessionParams, rlsSessionSql, type RlsIdentity } from '@/lib/services/rls-session'
import { RUNNABLE_FUNCTION_STATUS_FILTER } from '@/lib/services/ai-functions/status'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import type { FunctionEvent } from '@/lib/services/ai-functions/executor'
import { chooseCheckedValue, loadTableChecks, ownChecks, type TableCheck } from './checked-values'

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface BehavioralCheck {
  id: string
  name: string
  /** True when the check ran and all assertions passed */
  passed: boolean
  /** True when the check was not applicable to this project */
  skipped: boolean
  /** Why the check was skipped (only set when skipped=true) */
  skipReason?: string
  /** First failure message (only set when passed=false, skipped=false) */
  error?: string
  /** Ordered list of assertion outcomes */
  details: string[]
}

export interface BehavioralVerificationResult {
  projectId: string
  /**
   * true only when no non-skipped check failed.
   *
   * READ `verdict` INSTEAD unless you specifically mean that. This field is true
   * when every check SKIPPED, because "nothing failed" is vacuously satisfied by
   * "nothing ran" — and two callers read it as proof the backend behaves
   * correctly. Kept for compatibility; `verdict` is the honest signal.
   */
  passed: boolean
  /** Checks that actually executed (not skipped). */
  checksRun: number
  /** Checks that were not applicable to this project. */
  checksSkipped: number
  /**
   * What was actually established:
   *   'passed'             — at least one check ran and none failed
   *   'failed'             — at least one check ran and failed
   *   'nothing_to_verify'  — every check skipped; NOT evidence of correctness
   */
  verdict: 'passed' | 'failed' | 'nothing_to_verify'
  checks: BehavioralCheck[]
  executedAt: string
}

// ─── Public entry point ────────────────────────────────────────────────────────

/**
 * Run all behavioral checks for a project in parallel.
 * Always resolves (never throws) — failures are captured inside BehavioralCheck.
 */
export async function runBehavioralVerification(
  projectId: string,
): Promise<BehavioralVerificationResult> {
  const [crud, auth, rls, trigger, webhook, httpEndpoints] = await Promise.allSettled([
    checkCrudLifecycle(projectId),
    checkAuthFlow(projectId),
    checkRlsIsolation(projectId),
    checkTriggerExecution(projectId),
    checkWebhookHmac(projectId),
    checkLiveApiEndpoints(projectId),   // 3.6 — full HTTP stack: routing + auth + handler
  ])

  const checks: BehavioralCheck[] = [
    settledToCheck(crud,          'crud_lifecycle',     'CRUD lifecycle'),
    settledToCheck(auth,          'auth_flow',           'Auth flow'),
    settledToCheck(rls,           'rls_isolation',       'RLS isolation'),
    settledToCheck(trigger,       'trigger_execution',   'Trigger execution'),
    settledToCheck(webhook,       'webhook_hmac',         'Webhook HMAC'),
    settledToCheck(httpEndpoints, 'live_api_endpoints',  'Live HTTP endpoints'),
  ]

  const passed = checks.every(c => c.skipped || c.passed)

  // A skipped check satisfies `every` above, so an all-skipped run reports
  // passed=true having asserted nothing. Count what ran and say which of the
  // three states this actually is.
  const checksRun = checks.filter(c => !c.skipped).length
  const checksSkipped = checks.length - checksRun
  const verdict: BehavioralVerificationResult['verdict'] =
    checksRun === 0 ? 'nothing_to_verify' : passed ? 'passed' : 'failed'

  return {
    projectId,
    passed,
    checksRun,
    checksSkipped,
    verdict,
    checks,
    executedAt: new Date().toISOString(),
  }
}

/** Convert a settled promise result to a BehavioralCheck — absorbs unexpected throws. */
function settledToCheck(
  result: PromiseSettledResult<BehavioralCheck>,
  id: string,
  name: string,
): BehavioralCheck {
  if (result.status === 'fulfilled') return result.value
  return {
    id,
    name,
    passed: false,
    skipped: false,
    error: (result.reason as any)?.message ?? 'Unexpected error in behavioral check',
    details: [],
  }
}

// ─── FK constraint loader ─────────────────────────────────────────────────────

/**
 * Return the names of tables that `tableName` has foreign-key constraints pointing to.
 * Uses pg_constraint directly (more reliable than information_schema for FK detection).
 */
async function loadFkReferences(projectId: string, schemaName: string, tableName: string): Promise<string[]> {
  // The catalog of the project's database, in its region; resolved outside any
  // catch, so an unreachable region fails the check rather than skipping it.
  const db = await workspaceRawClient(projectId)
  try {
    const rows = await db.$queryRawUnsafe<{ foreign_table: string }[]>(
      `SELECT DISTINCT ref.relname AS foreign_table
       FROM pg_constraint c
       JOIN pg_class t   ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class ref ON ref.oid = c.confrelid
       WHERE c.contype = 'f'
         AND n.nspname = $1
         AND t.relname = $2`,
      schemaName, tableName,
    )
    return rows.map(r => r.foreign_table)
  } catch {
    return []
  }
}

/**
 * Precise FK column → parent column mapping for a table.
 *
 * Returns one row per (FK column, referenced parent column) pair. This is the
 * authoritative source — name-based heuristics ("does `user_id` map to `users.id`?")
 * are brittle for compound names like `created_by`, `author_id`, or non-default
 * referenced columns. A test row's parents are written from this map, with the
 * exact value each reference points at, as are run_test's create's
 * (lib/ai/brain/verify-create.ts).
 */
export interface FkColumnMapping {
  /** Column on the local table that holds the FK value */
  column: string
  /** Parent table name (without schema prefix) */
  foreignTable: string
  /** Column on the parent table the FK points at (usually 'id') */
  foreignColumn: string
}

export async function loadFkColumnMappings(
  projectId: string,
  schemaName: string,
  tableName: string,
): Promise<FkColumnMapping[]> {
  // The catalog of the project's database, in its region; resolved outside any
  // catch, so an unreachable region fails the check rather than skipping it.
  const db = await workspaceRawClient(projectId)
  try {
    const rows = await db.$queryRawUnsafe<{
      column: string
      foreign_table: string
      foreign_column: string
    }[]>(
      `SELECT
         att.attname            AS column,
         ref.relname            AS foreign_table,
         ref_att.attname        AS foreign_column
       FROM pg_constraint c
       JOIN pg_class t          ON t.oid = c.conrelid
       JOIN pg_namespace n      ON n.oid = t.relnamespace
       JOIN pg_class ref        ON ref.oid = c.confrelid
       JOIN LATERAL unnest(c.conkey)  WITH ORDINALITY AS lk(attnum, ord)  ON TRUE
       JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS rk(attnum, ord)  ON lk.ord = rk.ord
       JOIN pg_attribute att      ON att.attrelid = t.oid     AND att.attnum     = lk.attnum
       JOIN pg_attribute ref_att  ON ref_att.attrelid = ref.oid AND ref_att.attnum = rk.attnum
       WHERE c.contype = 'f'
         AND n.nspname = $1
         AND t.relname = $2`,
      schemaName, tableName,
    )
    return rows.map(r => ({
      column: r.column,
      foreignTable: r.foreign_table,
      foreignColumn: r.foreign_column,
    }))
  } catch {
    return []
  }
}

// ─── Test writes are rolled back ──────────────────────────────────────────────
//
// The checks that write test rows (3.1 to 3.4) write them inside one
// transaction each that is always rolled back. They used to commit each write
// and delete the rows afterwards. Every committed write was a real change in
// the customer's database: it was captured like any other, so the customer's
// row-event functions and webhooks ran on Backenly's test rows and counted
// against the month's function runs, and the customer's own triggers (an audit
// log, a profile row for each new user) kept what they wrote after the test
// row was deleted. A row the cleanup missed stayed in the customer's table.

type ProbeTx = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>

/** Ends a probe's transaction with its result, so the transaction is always rolled back. */
class RolledBack<T> extends Error {
  constructor(readonly result: T) {
    super('rolled back')
  }
}

/** Act as `identity` for the rest of the probe's transaction. */
async function actAs(tx: ProbeTx, identity: RlsIdentity): Promise<void> {
  await tx.$executeRawUnsafe(rlsSessionSql(), ...rlsSessionParams(identity))
}

/**
 * Run `fn` in one transaction on the project's database, as `identity`, and
 * roll it back whatever happens. Nothing it writes is committed: no row is
 * left behind, no captured change reaches a function or a webhook, and no
 * NOTIFY is sent (PostgreSQL delivers those on commit only). A sequence value
 * it takes is not given back; sequences are never transactional.
 *
 * Deferred constraints are checked as each statement runs, as they would be
 * at the commit this transaction never makes. Where it can, a check reads the
 * catalog before calling this, so that the transaction's connection is the
 * only one it holds while the transaction is open.
 */
async function inRolledBackTransaction<T>(
  projectId: string,
  identity: RlsIdentity,
  fn: (tx: ProbeTx) => Promise<T>,
): Promise<T> {
  const db = await workspaceRawClient(projectId)
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '5s'`)
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`)
        await tx.$executeRawUnsafe(`SET CONSTRAINTS ALL IMMEDIATE`)
        await actAs(tx, identity)
        throw new RolledBack(await fn(tx))
      },
      { maxWait: 5_000, timeout: 30_000 },
    )
  } catch (err) {
    if (err instanceof RolledBack) return err.result as T
    throw err
  }
  throw new Error('A probe transaction ended without a result.')
}

// ─── Test rows ────────────────────────────────────────────────────────────────
//
// One way to write a row a check needs, for every check that writes one (3.1
// to 3.4). The row is built from the catalog: a value for each column the
// database does not fill, of the column's own type, that the column's CHECK
// rules accept (lib/ai/checked-values.ts asks PostgreSQL which do), with the
// parent rows its foreign keys need written first.
//
// The CRUD, auth and RLS checks used to build theirs another way: 0 for every
// number, the first quoted text of a CHECK for a column under one, and for the
// update a fixed text written into the first text column. A rating that must
// be 1 to 5 was given 0, the insert failed, and the failure was reported as
// "backend does not behave correctly", which blocks a publish (production QA,
// 2026-11-21, N1). Which table that happened to depended on the order an
// unordered query returned them in.
//
// A row Backenly cannot build says nothing about the backend. A check that
// cannot build one for a table says so and tries the next table; with none
// left it reports itself not run, and does not block.

/** How many levels of parent rows a test row's foreign keys may need. */
const MAX_PARENT_DEPTH = 3

/** A column, as a test row gives it a value. */
interface ProbeColumn {
  name: string
  /** format_type(): the exact type a value is cast to, schema-qualified where it must be. */
  type: string
  typname: string
  /** pg_type.typcategory: S string, N number, B boolean, D date and time, T interval, A array, E enum. */
  category: string
  notNull: boolean
  hasDefault: boolean
  /** An identity or generated column: PostgreSQL gives it its value. */
  computed: boolean
  enumLabels: string[] | null
}

interface ProbeTable {
  table: string
  columns: ProbeColumn[]
  /** Every CHECK constraint of the table. */
  checks: TableCheck[]
  fks: FkColumnMapping[]
}

/** SQLSTATEs of a statement that could not run just now: a timeout, a lock held by another session, a conflict. */
const COULD_NOT_RUN_NOW = new Set(['57014', '55P03', '40001', '40P01'])

/**
 * Why a test row could not be written.
 *
 * `sqlState` is PostgreSQL's code when the database refused the row, and null
 * when the row was never sent: no value was found for a column, its foreign
 * keys form a cycle, a table it needs was not found.
 */
class CannotBuildRow extends Error {
  constructor(message: string, readonly sqlState: string | null = null) {
    super(message)
  }

  /**
   * Whether the refusal is about the test's own row, and so says nothing of
   * the table: the row was never sent, its values were refused (a data or
   * integrity error, an exception a trigger raised), or the statement could
   * not run just now.
   *
   * False for anything else PostgreSQL said: a function a trigger calls that
   * does not exist, a column that is not there, a policy that refuses the
   * service role the checks write as. No row could have been written,
   * whatever it held, so that is the table's own fault, as it always was.
   */
  get saysNothingOfTheTable(): boolean {
    const code = this.sqlState
    if (code === null) return true
    return code.startsWith('22') || code.startsWith('23') || code === 'P0001' || COULD_NOT_RUN_NOW.has(code)
  }
}

/** The SQLSTATE of a failed raw query, when it carries one. */
function sqlStateOf(err: unknown): string | null {
  const code = (err as { meta?: { code?: unknown } } | null)?.meta?.code
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
  const text = err instanceof Error ? err.message : String(err ?? '')
  return /Code: `([0-9A-Z]{5})`/.exec(text)?.[1] ?? null
}

async function loadProbeTable(projectId: string, schemaName: string, table: string): Promise<ProbeTable | null> {
  const db = await workspaceRawClient(projectId)
  const columns = await db.$queryRawUnsafe<Array<{
    name: string
    type: string
    typname: string
    category: string
    not_null: boolean
    has_default: boolean
    computed: boolean
    enum_labels: string[] | null
  }>>(
    `SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            t.typname AS typname,
            t.typcategory::text AS category,
            a.attnotnull AS not_null,
            a.atthasdef AS has_default,
            (a.attidentity <> '' OR a.attgenerated <> '') AS computed,
            CASE WHEN t.typtype = 'e' THEN
              (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
            END AS enum_labels
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    schemaName, table,
  )
  if (columns.length === 0) return null

  return {
    table,
    columns: columns.map((c) => ({
      name: c.name,
      type: c.type,
      typname: c.typname,
      category: c.category,
      notNull: c.not_null,
      hasDefault: c.has_default,
      computed: c.computed,
      enumLabels: c.enum_labels,
    })),
    checks: await loadTableChecks(projectId, schemaName, table),
    fks: await loadFkColumnMappings(projectId, schemaName, table),
  }
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

/** A diagnostic sentence as a clause: lower-case start, no closing full stop. */
const clause = (text: string) => text.charAt(0).toLowerCase() + text.slice(1).replace(/\.\s*$/, '')

/**
 * Insert a row Backenly can build into `plan.table`, with the parent rows its
 * foreign keys need, inside the check's transaction. Returns the row's ctid,
 * and the value of each `mustFill` column as text. Throws CannotBuildRow when
 * no such row can be written; after that the transaction is aborted, so the
 * caller must stop.
 *
 * `fixed` gives columns the values the caller needs them to have (the owner of
 * a row, a test user's email). A column that references a parent keeps the
 * parent's value.
 */
async function insertProbeRow(
  tx: ProbeTx,
  projectId: string,
  schemaName: string,
  plan: ProbeTable,
  salt: string,
  path: string[] = [],
  mustFill: string[] = [],
  fixed: Record<string, string> = {},
): Promise<Record<string, string | null>> {
  if (path.includes(plan.table)) {
    throw new CannotBuildRow(`its foreign keys form a cycle through "${plan.table}"`)
  }
  if (path.length >= MAX_PARENT_DEPTH) {
    throw new CannotBuildRow(`its foreign keys go more than ${MAX_PARENT_DEPTH} tables deep`)
  }

  // Each parent table this row references, with the columns pointing at it.
  // A reference to the row's own table is left empty.
  const parents = new Map<string, FkColumnMapping[]>()
  for (const fk of plan.fks) {
    if (fk.foreignTable === plan.table) continue
    parents.set(fk.foreignTable, [...(parents.get(fk.foreignTable) ?? []), fk])
  }

  const values = new Map<string, string>(Object.entries(fixed))
  for (const [parentTable, mappings] of parents) {
    const parentPlan = await loadProbeTable(projectId, schemaName, parentTable)
    if (!parentPlan) throw new CannotBuildRow(`the table "${parentTable}" it references was not found`)
    const referenced = Array.from(new Set(mappings.map((m) => m.foreignColumn)))
    const parent = await insertProbeRow(tx, projectId, schemaName, parentPlan, salt, [...path, plan.table], referenced)
    for (const m of mappings) {
      const value = parent[m.foreignColumn]
      if (value !== null && value !== undefined) values.set(m.column, value)
    }
  }

  const cols: ProbeColumn[] = []
  for (const col of plan.columns) {
    if (col.computed) continue
    // A referenced column with a default (a serial, gen_random_uuid()) keeps it,
    // and RETURNING reads the value it got.
    const wanted =
      values.has(col.name) || (!col.hasDefault && (col.notNull || mustFill.includes(col.name)))
    if (!wanted) continue
    if (!values.has(col.name)) {
      // A value the column's own CHECK rules accept: PostgreSQL is asked.
      const value = await chooseCheckedValue(tx, col, plan.checks, salt)
      if (value === null) {
        const rules = ownChecks(col.name, plan.checks).map((c) => `"${c.name}"`).join(', ')
        throw new CannotBuildRow(
          `none of the values the test tries for "${plan.table}"."${col.name}" is allowed by its rule${rules.includes(',') ? 's' : ''} ${rules}`,
        )
      }
      values.set(col.name, value)
    }
    cols.push(col)
  }

  const target = `${quoteIdent(schemaName)}.${quoteIdent(plan.table)}`
  const returning = ['ctid::text AS "__ctid"', ...mustFill.map((c) => `${quoteIdent(c)}::text AS ${quoteIdent(c)}`)].join(', ')
  const sql = cols.length === 0
    ? `INSERT INTO ${target} DEFAULT VALUES RETURNING ${returning}`
    : `INSERT INTO ${target} (${cols.map((c) => quoteIdent(c.name)).join(', ')})
       VALUES (${cols.map((c, i) => `$${i + 1}::${c.type}`).join(', ')})
       RETURNING ${returning}`
  let rows: Array<Record<string, string | null>>
  try {
    rows = await tx.$queryRawUnsafe<Array<Record<string, string | null>>>(sql, ...cols.map((c) => values.get(c.name)))
  } catch (err) {
    throw new CannotBuildRow(
      `a test row could not be written to "${plan.table}" (${clause(sanitizeDiagnostic(err))})`,
      sqlStateOf(err),
    )
  }
  if (!rows[0]) throw new CannotBuildRow(`writing a test row to "${plan.table}" returned no row`)
  return rows[0]
}

/**
 * Change one column of the test row: a column in `watched` when there are any
 * (the columns a function runs on), otherwise any column a test may change.
 * Returns the updated row's ctid. Throws CannotBuildRow when no column can be
 * changed; after a refused UPDATE the transaction is aborted, unless the
 * caller set a savepoint to return to.
 */
async function updateProbeRow(
  tx: ProbeTx,
  schemaName: string,
  plan: ProbeTable,
  ctid: string,
  watched: string[],
  salt: string,
): Promise<string> {
  // Never a foreign key (its new value would have to exist) or a computed
  // column; plain values first, an id last, and of two alike the one under no
  // rule of its own, which any new value suits.
  const keys = new Set(plan.fks.map((fk) => fk.column))
  const settable = (c: ProbeColumn) => !c.computed && !keys.has(c.name)
  // A column that takes only some values: listed by its type, or kept to them by a CHECK of its own.
  const ruled = (c: ProbeColumn) => (c.enumLabels?.length ?? 0) > 0 || ownChecks(c.name, plan.checks).length > 0
  const rank = (c: ProbeColumn) =>
    (c.name === 'id' ? 10 : 0) +
    ('SNBDTE'.includes(c.category) ? 0 : c.typname === 'uuid' || c.typname.startsWith('json') ? 5 : 20) +
    (ruled(c) ? 1 : 0)
  const candidates = (watched.length > 0
    ? plan.columns.filter((c) => watched.includes(c.name) && settable(c))
    : plan.columns.filter((c) => settable(c) && rank(c) < 20)
  ).sort((a, b) => rank(a) - rank(b))
  const col = candidates[0]
  if (!col) {
    throw new CannotBuildRow(
      watched.length > 0
        ? `none of the columns it watches (${watched.join(', ')}) can be changed by a test update`
        : `no column of "${plan.table}" can be changed by a test update`,
    )
  }

  const target = `${quoteIdent(schemaName)}.${quoteIdent(plan.table)}`
  const column = quoteIdent(col.name)
  let set: string
  const params: unknown[] = [ctid]
  if (ruled(col)) {
    // Another value the column takes: PostgreSQL is asked which of the test's
    // values its rules accept, as it is for the row's first value. A fixed
    // text written here once broke the rule and failed the check.
    const current = await tx.$queryRawUnsafe<Array<{ value: string | null }>>(
      `SELECT ${column}::text AS value FROM ${target} WHERE ctid = $1::tid`, ctid,
    )
    const next = await chooseCheckedValue(tx, col, plan.checks, salt, { not: current[0]?.value ?? null })
    if (next === null) {
      throw new CannotBuildRow(`"${col.name}" takes no other value the test tries, so a test update cannot change it`)
    }
    set = `$2::${col.type}`
    params.push(next)
  } else if (col.category === 'N') {
    set = `COALESCE(${column}, 0) + 1`
  } else if (col.category === 'B') {
    set = `NOT COALESCE(${column}, false)`
  } else if (col.category === 'D') {
    set = `COALESCE(${column}, now()) + interval '1 day'`
  } else if (col.category === 'T') {
    set = `COALESCE(${column}, interval '0') + interval '1 hour'`
  } else if (col.typname === 'uuid') {
    set = 'gen_random_uuid()'
  } else if (col.typname === 'json' || col.typname === 'jsonb') {
    set = `jsonb_build_object('__bv_probe', '${salt}')::${col.type}`
  } else {
    set = `$2::${col.type}`
    params.push(`__bv_probe_changed_${salt}`)
  }
  try {
    const rows = await tx.$queryRawUnsafe<Array<{ ctid: string }>>(
      `UPDATE ${target} SET ${column} = ${set} WHERE ctid = $1::tid RETURNING ctid::text AS ctid`,
      ...params,
    )
    if (!rows[0]) throw new CannotBuildRow(`the test row in "${plan.table}" could not be found to update`)
    return rows[0].ctid
  } catch (err) {
    if (err instanceof CannotBuildRow) throw err
    throw new CannotBuildRow(
      `"${col.name}" could not be changed by a test update (${clause(sanitizeDiagnostic(err))})`,
      sqlStateOf(err),
    )
  }
}

/** A check's verdict on one table, or why the table could not be used to reach one. */
type TableAttempt =
  | { kind: 'untested'; reason: string }
  | { kind: 'checked'; passed: boolean; error?: string; details: string[] }

const untested = (reason: string): TableAttempt => ({ kind: 'untested', reason })

/** What a check says when it could write a test row to none of the tables it tried. */
function notExercised(what: string, tried: Array<{ table: string; reason: string }>, more: number): string {
  const reasons = tried.map((t) => `"${t.table}": ${t.reason}`).join('; ')
  return (
    `${what} not exercised: a test row could not be written to ${tried.length === 1 ? 'the table' : `any of the ${tried.length} tables`} tried. ` +
    `${reasons}.` +
    (more > 0 ? ` ${more} more table${more === 1 ? ' was' : 's were'} not tried.` : '') +
    ` This is a limit of Backenly's test, not a fault in the backend.`
  )
}

// ─── CHECK 3.1 — CRUD lifecycle ───────────────────────────────────────────────

/** Tables the CRUD check tries before it says it could exercise none. */
const MAX_CRUD_TABLES_TRIED = 5

/** create → read → update → delete → read again, on one table, in a transaction that is rolled back. */
async function crudLifecycleOn(projectId: string, schemaName: string, tableName: string): Promise<TableAttempt> {
  const plan = await loadProbeTable(projectId, schemaName, tableName)
  if (!plan) return untested('it was not found in the database')

  const target = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`
  const salt = crypto.randomBytes(4).toString('hex')
  const details: string[] = []
  const failed = (error: string, line: string): TableAttempt => ({ kind: 'checked', passed: false, error, details: [...details, line] })

  // The test's own end user, so a column whose default reads the signed-in
  // user (backenly_jwt_claim('sub')) gets one, as a real write would. Every
  // write below is rolled back with the transaction: nothing to clean up.
  return inRolledBackTransaction<TableAttempt>(
    projectId,
    { userId: crypto.randomUUID(), isServiceRole: true },
    async (tx) => {
      // ── INSERT ──────────────────────────────────────────────────────────────
      let ctid: string
      try {
        ctid = (await insertProbeRow(tx, projectId, schemaName, plan, salt)).__ctid as string
      } catch (err) {
        if (!(err instanceof CannotBuildRow)) throw err
        if (err.saysNothingOfTheTable) return untested(err.message)
        return failed(`INSERT failed: ${err.message}`, '✗ INSERT failed')
      }
      details.push(`✓ INSERT succeeded on "${tableName}"`)

      // ── READ ────────────────────────────────────────────────────────────────
      const readSql = `SELECT 1 AS found FROM ${target} WHERE ctid = $1::tid`
      if ((await tx.$queryRawUnsafe<unknown[]>(readSql, ctid)).length === 0) {
        return failed('READ returned 0 rows after INSERT', '✗ READ failed')
      }
      details.push('✓ READ returned inserted row')

      // ── UPDATE (best-effort) ────────────────────────────────────────────────
      // A column the test cannot change, or a rule that refuses its new value,
      // is not a failed lifecycle. The savepoint keeps the transaction usable
      // after a refused UPDATE.
      await tx.$executeRawUnsafe('SAVEPOINT bv_crud_update')
      try {
        ctid = await updateProbeRow(tx, schemaName, plan, ctid, [], salt)
        details.push('✓ UPDATE succeeded')
      } catch (err) {
        if (!(err instanceof CannotBuildRow)) throw err
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT bv_crud_update')
        details.push(`~ UPDATE not exercised: ${err.message}`)
      }

      // ── DELETE ──────────────────────────────────────────────────────────────
      const deleted = await tx.$queryRawUnsafe<unknown[]>(
        `DELETE FROM ${target} WHERE ctid = $1::tid RETURNING 1 AS gone`, ctid,
      )
      if (deleted.length === 0) return failed('DELETE matched 0 rows', '✗ DELETE failed')
      details.push('✓ DELETE succeeded')

      // ── POST-DELETE READ — must return 0 rows ───────────────────────────────
      if ((await tx.$queryRawUnsafe<unknown[]>(readSql, ctid)).length > 0) {
        return failed(
          'Row still exists after DELETE',
          '✗ Post-delete read returned rows — the DELETE did not remove the row',
        )
      }
      details.push('✓ Post-delete read returns 0 rows')

      return { kind: 'checked', passed: true, details }
    },
  )
}

async function checkCrudLifecycle(projectId: string): Promise<BehavioralCheck> {
  // Resolved first and outside any catch, so an unreachable region fails the
  // check rather than skipping it.
  await workspaceRawClient(projectId)
  const base: BehavioralCheck = {
    id: 'crud_lifecycle',
    name: 'CRUD lifecycle (create → read → update → delete → post-delete read returns nothing)',
    passed: false,
    skipped: false,
    details: [],
  }

  const SYSTEM_TABLES = new Set(['users', '_backenly_presence', 'audit_logs', 'email_events', 'sms_events'])

  // In name order, so the same project is tested the same way every time. An
  // unordered read once decided which table was tested, and with it whether a
  // publish was blocked.
  const tables = await prisma.table.findMany({
    where: { projectId },
    select: { name: true },
    orderBy: { name: 'asc' },
  })
  const candidates = tables.map((t) => t.name.toLowerCase()).filter((name) => !SYSTEM_TABLES.has(name))
  if (candidates.length === 0) {
    return { ...base, skipped: true, skipReason: 'No application tables exist yet to exercise a CRUD lifecycle against.' }
  }

  const schemaName = `workspace_${projectId}`
  const tried: Array<{ table: string; reason: string }> = []
  try {
    // A table Backenly cannot build a row for is passed over for the next one:
    // the lifecycle is proved on the first table that takes a test row.
    for (const tableName of candidates.slice(0, MAX_CRUD_TABLES_TRIED)) {
      const attempt = await crudLifecycleOn(projectId, schemaName, tableName)
      if (attempt.kind === 'untested') {
        tried.push({ table: tableName, reason: attempt.reason })
        base.details.push(`⏭ Couldn't test "${tableName}": ${attempt.reason}`)
        continue
      }
      const details = [...base.details, ...attempt.details]
      return attempt.passed ? { ...base, passed: true, details } : { ...base, error: attempt.error, details }
    }
  } catch (err: any) {
    return { ...base, error: sanitizeDiagnostic(err), details: base.details }
  }

  return {
    ...base,
    skipped: true,
    skipReason: notExercised('CRUD lifecycle', tried, candidates.length - tried.length),
  }
}

// ─── CHECK 3.2 — Auth flow ────────────────────────────────────────────────────

async function checkAuthFlow(projectId: string): Promise<BehavioralCheck> {
  const db = await workspaceRawClient(projectId)
  const base: BehavioralCheck = {
    id: 'auth_flow',
    name: 'Auth flow (signup → token issuance → JWT verification → protected resource access)',
    passed: false,
    skipped: false,
    details: [],
  }

  const schemaName = `workspace_${projectId}`

  // 1. Check workspace users table exists (auth not enabled → skip)
  const tableExists = await db.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'users'
     ) AS exists`,
    schemaName,
  )
  if (!tableExists[0]?.exists) {
    return { ...base, skipped: true, skipReason: 'Auth not enabled — workspace users table does not exist' }
  }

  // 2. Check project JWT secret
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { jwtSecret: true },
  })
  if (!project?.jwtSecret || project.jwtSecret.length < 32) {
    return { ...base, skipped: true, skipReason: 'Project JWT secret is not configured (will be auto-fixed at deploy)' }
  }

  // 3. The users table as it is, not as it is assumed to be: an OAuth-only
  //    table has no password column, and one a developer extended has required
  //    columns of its own (a role, a status), some under CHECK rules.
  const plan = await loadProbeTable(projectId, schemaName, 'users')
  if (!plan) {
    return { ...base, skipped: true, skipReason: 'workspace users table has no columns in the catalog' }
  }
  const has = (name: string) => plan.columns.some((c) => c.name === name)
  if (!has('id') || !has('email')) {
    return { ...base, skipped: true, skipReason: 'workspace users table is missing required id or email columns' }
  }

  const testEmail = `__bv_test_${Date.now()}@backenly.internal`
  const salt = crypto.randomBytes(4).toString('hex')

  try {
    // ── Signup: a row shaped to the actual table ──────────────────────────────
    // The email and the password hash are the test's own; every other required
    // column gets a value its type and its rules accept.
    const fixed: Record<string, string> = { email: testEmail }
    if (has('password')) fixed.password = await hashPassword(crypto.randomBytes(12).toString('hex'))

    // Service-role: the workspace users table may have RLS enabled
    // (own_rows / public_read templates). Real signup also runs as
    // service-role; the verifier must do the same to match production
    // behavior, otherwise PG 42501 surfaces here even though the live
    // signup route would succeed. The test user is rolled back with the
    // transaction, so it never exists outside it.
    return await inRolledBackTransaction<BehavioralCheck>(projectId, { userId: '', isServiceRole: true }, async (tx) => {
      let created: Record<string, string | null>
      try {
        created = await insertProbeRow(tx, projectId, schemaName, plan, salt, [], ['id'], fixed)
      } catch (err) {
        if (!(err instanceof CannotBuildRow)) throw err
        if (err.saysNothingOfTheTable) {
          return {
            ...base,
            skipped: true,
            skipReason:
              `Auth flow not exercised: a test user could not be written (${err.message}). ` +
              `This is a limit of Backenly's test, not a fault in the backend.`,
          }
        }
        return { ...base, error: `Signup: ${err.message}`, details: base.details }
      }

      const testUserId = created.id
      if (!testUserId) {
        return { ...base, error: 'Signup: INSERT into workspace users returned no id', details: base.details }
      }
      base.details.push(`✓ Signup: test user created (id=${testUserId.slice(0, 8)}…)`)

      // ── Token issuance ──────────────────────────────────────────────────────
      const token = generateToken({ userId: testUserId, email: testEmail, projectId })
      if (!token || typeof token !== 'string' || token.length < 20) {
        return { ...base, error: 'Token issuance failed — generateToken returned empty or invalid', details: base.details }
      }
      base.details.push('✓ Token issuance: JWT generated successfully')

      // ── Token verification ──────────────────────────────────────────────────
      let decoded: any
      try {
        decoded = verifyToken(token)
      } catch (e: any) {
        return { ...base, error: `JWT verification threw: ${e.message}`, details: base.details }
      }

      if (!decoded) {
        return { ...base, error: 'JWT verification returned null/undefined', details: base.details }
      }

      // Payload must contain the right userId and projectId
      const decodedUserId   = decoded.userId   ?? decoded.sub ?? decoded.id
      const decodedProject  = decoded.projectId ?? decoded.project

      if (String(decodedUserId) !== String(testUserId)) {
        return {
          ...base,
          error: `JWT payload mismatch: userId expected ${testUserId}, got ${decodedUserId}`,
          details: [...base.details, '✗ verifyToken payload userId mismatch'],
        }
      }
      if (decodedProject && String(decodedProject) !== String(projectId)) {
        return {
          ...base,
          error: `JWT payload mismatch: projectId expected ${projectId}, got ${decodedProject}`,
          details: [...base.details, '✗ verifyToken payload projectId mismatch'],
        }
      }
      base.details.push('✓ Token verification: payload matches (userId, projectId)')

      // ── Protected endpoint access simulation ────────────────────────────────
      // Simulate what a protected endpoint does: resolve user from the decoded
      // token. Service-role here mirrors what the platform middleware does —
      // resolving the user record from JWT claims is a privileged lookup, not
      // a user-scoped query, so RLS should not gate it.
      const protectedRead = await tx.$queryRawUnsafe<unknown[]>(
        `SELECT 1 AS found FROM ${quoteIdent(schemaName)}."users" WHERE id::text = $1`,
        testUserId,
      )
      if (protectedRead.length === 0) {
        return { ...base, error: 'Protected resource lookup: user not found by decoded userId', details: base.details }
      }
      base.details.push('✓ Protected endpoint access: user resolved from token claims')

      return { ...base, passed: true }
    })
  } catch (err: any) {
    return { ...base, error: sanitizeDiagnostic(err), details: base.details }
  }
}

// ─── CHECK 3.3 — RLS isolation ────────────────────────────────────────────────

/** Tables the RLS check tries before it says it could exercise none. */
const MAX_RLS_TABLES_TRIED = 5

/** User A writes a row, user B must not see it, on one table, in a transaction that is rolled back. */
async function rlsIsolationOn(
  projectId: string,
  schemaName: string,
  table: string,
  ownerCol: string,
): Promise<TableAttempt> {
  const plan = await loadProbeTable(projectId, schemaName, table)
  if (!plan) return untested('it was not found in the database')

  const target = `${quoteIdent(schemaName)}.${quoteIdent(table)}`
  const salt = crypto.randomBytes(4).toString('hex')
  const userAId = crypto.randomUUID()
  const userBId = crypto.randomUUID()
  const details: string[] = []

  // The owner column is given user A, unless it references a parent: then the
  // parent row the test writes decides it, and whatever it holds is user A.
  const fixed: Record<string, string> = plan.fks.some((fk) => fk.column === ownerCol) ? {} : { [ownerCol]: userAId }

  // Each write and read below runs in one transaction that is rolled back,
  // switching identity between them: nothing to clean up. User A inserts via
  // the service role, so existing policies do not stand in the way of the
  // test's own setup.
  return inRolledBackTransaction<TableAttempt>(
    projectId,
    { userId: userAId, isServiceRole: true },
    async (tx) => {
      let row: Record<string, string | null>
      try {
        row = await insertProbeRow(tx, projectId, schemaName, plan, salt, [], [ownerCol], fixed)
      } catch (err) {
        if (!(err instanceof CannotBuildRow)) throw err
        if (err.saysNothingOfTheTable) return untested(err.message)
        return { kind: 'checked', passed: false, error: `RLS test: INSERT as user A into '${table}' failed: ${err.message}`, details }
      }
      const owner = row[ownerCol]
      if (owner === null || owner === undefined || owner === '') {
        return untested(`its owner column "${ownerCol}" was left empty by the test row`)
      }
      details.push(`✓ User A (${owner.slice(0, 8)}…) inserted a row into "${table}"`)

      // User B tries to read user A's row — must be denied by RLS
      const readSql = `SELECT 1 AS seen FROM ${target} WHERE ctid = $1::tid`
      await actAs(tx, { userId: userBId, isServiceRole: false })
      const userBRows = await tx.$queryRawUnsafe<unknown[]>(readSql, row.__ctid)

      if (userBRows.length > 0) {
        return {
          kind: 'checked',
          passed: false,
          error: `RLS isolation failure: user B can read user A's row (table: ${table})`,
          details: [...details, `✗ User B (${userBId.slice(0, 8)}…) returned ${userBRows.length} row(s) — should be 0`],
        }
      }
      details.push(`✓ User B (${userBId.slice(0, 8)}…) correctly denied — 0 rows returned`)

      // User A reads their own row — should succeed
      await actAs(tx, { userId: owner, isServiceRole: false })
      const userARows = await tx.$queryRawUnsafe<unknown[]>(readSql, row.__ctid)
      details.push(
        userARows.length > 0
          ? '✓ User A can read their own row (self-access allowed)'
          : '~ User A self-read returned 0 rows (own_rows policy may use different column mapping)',
      )
      return { kind: 'checked', passed: true, details }
    },
  )
}

async function checkRlsIsolation(projectId: string): Promise<BehavioralCheck> {
  const db = await workspaceRawClient(projectId)
  const base: BehavioralCheck = {
    id: 'rls_isolation',
    name: 'RLS two-user isolation (user A inserts row → user B sees nothing)',
    passed: false,
    skipped: false,
    details: [],
  }

  const schemaName = `workspace_${projectId}`

  // Tables with Backenly-managed RLS policies, in name order: the same
  // project is tested the same way every time.
  const rlsTables = await db.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT DISTINCT tablename FROM pg_policies
     WHERE schemaname = $1 AND policyname LIKE 'backenly_%'
     ORDER BY tablename`,
    schemaName,
  )

  if (rlsTables.length === 0) {
    return { ...base, skipped: true, skipReason: 'No Backenly-managed RLS policies exist yet' }
  }

  // Those of them with a user_id-like column: the rows a user owns.
  const USER_ID_COLS = new Set(['user_id', 'userid', 'author_id', 'authorid', 'owner_id', 'ownerid', 'created_by', 'createdby'])
  const owned: Array<{ table: string; ownerCol: string }> = []
  for (const { tablename } of rlsTables) {
    const cols = await db.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      schemaName, tablename,
    )
    const match = cols.find(c => USER_ID_COLS.has(c.column_name.toLowerCase()))
    if (match) owned.push({ table: tablename, ownerCol: match.column_name })
  }

  if (owned.length === 0) {
    return { ...base, skipped: true, skipReason: 'No RLS-protected table has a user_id-like column' }
  }

  const tried: Array<{ table: string; reason: string }> = []
  try {
    // A table Backenly cannot build a row for is passed over for the next one.
    for (const { table, ownerCol } of owned.slice(0, MAX_RLS_TABLES_TRIED)) {
      const attempt = await rlsIsolationOn(projectId, schemaName, table, ownerCol)
      if (attempt.kind === 'untested') {
        tried.push({ table, reason: attempt.reason })
        base.details.push(`⏭ Couldn't test "${table}": ${attempt.reason}`)
        continue
      }
      // The table that was tested speaks first; what was passed over follows.
      base.details = [...attempt.details, ...base.details]
      if (!attempt.passed) return { ...base, error: attempt.error }

      // ── Issue 16 guard: verify the policy expression references the correct column ──
      // If the `own_rows` policy was applied using a column name that differs from
      // what the workspace auth system sets as app.user_id, isolation silently breaks.
      // Fetch the actual policy expression from pg_policies and warn if it looks wrong.
      try {
        const policyRows = await db.$queryRawUnsafe<{ qual: string | null; cmd: string }[]>(
          `SELECT qual, cmd FROM pg_policies
           WHERE schemaname = $1 AND tablename = $2 AND policyname LIKE 'backenly_%'
           LIMIT 5`,
          schemaName, table,
        )
        for (const policy of policyRows) {
          const qual = policy.qual ?? ''
          // A correct own_rows policy reads the caller identity through
          // current_setting — either the claim form
          // (request.jwt.claims ->> 'sub') or the GUC form (app.current_user_id).
          // rls-session.ts sets BOTH, so either dialect evaluates correctly here.
          //
          // The old check looked for the literal 'app.user_id', a GUC name nothing
          // sets — rlsSessionSql writes 'app.current_user_id'. Combined with the
          // second clause it could effectively never fire, so it was a guard in
          // name only.
          if (qual && !qual.includes('current_setting')) {
            base.details.push(
              `⚠ RLS policy on '${table}' (cmd=${policy.cmd}) never reads current_setting, so it ` +
              `does not depend on the caller identity at all — expression: ${qual.slice(0, 120)}. ` +
              `A policy that ignores the caller either denies everyone or exposes every row.`,
            )
          }
        }
      } catch {
        // pg_policies query failed (e.g. insufficient privileges) — skip validation
      }

      return { ...base, passed: true }
    }
  } catch (err: any) {
    return { ...base, error: sanitizeDiagnostic(err), details: base.details }
  }

  return {
    ...base,
    skipped: true,
    skipReason: notExercised('RLS isolation', tried, owned.length - tried.length),
  }
}

// ─── CHECK 3.4 — Row-event functions ─────────────────────────────────────────
//
// What it proves: a row change on a function's table is captured, and would be
// queued for that function, the way the drain queues every captured change
// (lib/webhooks/capture.ts, drainProject). It proves it inside a transaction
// that is always rolled back, so it writes nothing at all.
//
// It used to commit a test row into the customer's table and delete it 350 ms
// later. Both writes were captured like any other, so the customer's row-event
// functions and webhooks ran on Backenly's test row and counted against the
// month's function runs. It built that row without the signed-in user an owner
// column's default reads (backenly_jwt_claim('sub')), so on a table such as
// orders(user_id ... DEFAULT the caller) the insert failed, and any failure was
// reported as "backend does not behave correctly", which blocks a publish
// (production QA, 2026-11-16, N1). It always inserted, whatever the function
// listened for, checked one function picked at random, and passed when nothing
// had run.
//
// A row Backenly cannot build says nothing about the backend: that function is
// reported as not checked, and does not block.

/** The row change each row-event trigger runs on. */
const ROW_EVENT_OPERATION: Record<string, 'INSERT' | 'UPDATE' | 'DELETE'> = {
  on_db_insert: 'INSERT',
  on_db_update: 'UPDATE',
  on_db_delete: 'DELETE',
}

const OPERATION_WORDS: Record<'INSERT' | 'UPDATE' | 'DELETE', string> = {
  INSERT: 'a new row',
  UPDATE: 'a row update',
  DELETE: 'a deleted row',
}

/** Functions checked in one run; any more are named as not checked. */
const MAX_ROW_FUNCTIONS_CHECKED = 10

interface RowFunctionProbe {
  outcome: 'reached' | 'missed' | 'unchecked'
  name: string
  /** What happened, in a clause that follows the function's name. */
  why: string
}

type ProbeResult =
  | { kind: 'no-outbox' }
  | { kind: 'cannot-build'; reason: string }
  | { kind: 'captured'; event: { new_row: string | null; old_row: string | null; truncated: boolean } | null }

/** Whether a change on `fn`'s table reaches `fn`, proved without committing anything. */
async function probeRowFunction(
  projectId: string,
  fn: { id: string; name: string; triggerType: string; triggerTable: string | null },
): Promise<RowFunctionProbe> {
  const op = ROW_EVENT_OPERATION[fn.triggerType]
  const table = fn.triggerTable ?? ''
  const schemaName = workspaceSchemaName(projectId)
  const words = OPERATION_WORDS[op]
  const unchecked = (why: string): RowFunctionProbe => ({ outcome: 'unchecked', name: fn.name, why })
  const missed = (why: string): RowFunctionProbe => ({ outcome: 'missed', name: fn.name, why })
  const { isCapturableTable, changedNothing, OUTBOX_TABLE } = await import('@/lib/webhooks/capture')

  if (!(await isCapturableTable(table))) {
    return unchecked(
      `it runs on changes to "${table}", whose row changes are never captured` +
        (table === 'users' ? '; an on_signup function runs for each new user' : ''),
    )
  }
  const plan = await loadProbeTable(projectId, schemaName, table)
  if (!plan) return unchecked(`its table "${table}" was not found`)

  const executor = await import('@/lib/services/ai-functions/executor')
  const watched = op === 'UPDATE' ? ((await executor.watchedColumnsOf([fn.id])).get(fn.id) ?? []) : []
  const salt = crypto.randomBytes(4).toString('hex')
  const outbox = `${quoteIdent(schemaName)}.${quoteIdent(OUTBOX_TABLE)}`
  const target = `${quoteIdent(schemaName)}.${quoteIdent(table)}`

  // The probe's own end user, so a column whose default reads the signed-in
  // user (backenly_jwt_claim('sub')) gets one, as a real write would.
  const result = await inRolledBackTransaction<ProbeResult>(
    projectId,
    { userId: crypto.randomUUID(), isServiceRole: true },
    async (tx) => {
      const present = await tx.$queryRawUnsafe<Array<{ present: boolean }>>(
        `SELECT to_regclass($1) IS NOT NULL AS present`, outbox,
      )
      if (!present[0]?.present) return { kind: 'no-outbox' }
      const last = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT COALESCE(max(id), 0)::text AS id FROM ${outbox}`,
      )

      let row: string
      try {
        let ctid = (await insertProbeRow(tx, projectId, schemaName, plan, salt)).__ctid as string
        if (op === 'UPDATE') ctid = await updateProbeRow(tx, schemaName, plan, ctid, watched, salt)
        const json = await tx.$queryRawUnsafe<Array<{ probe_row: string }>>(
          `SELECT to_jsonb(r)::text AS probe_row FROM ${target} r WHERE r.ctid = $1::tid`, ctid,
        )
        row = json[0]?.probe_row
        if (op === 'DELETE') {
          try {
            await tx.$executeRawUnsafe(`DELETE FROM ${target} WHERE ctid = $1::tid`, ctid)
          } catch (err) {
            throw new CannotBuildRow(`the test row could not be deleted (${clause(sanitizeDiagnostic(err))})`)
          }
        }
      } catch (err) {
        if (err instanceof CannotBuildRow) return { kind: 'cannot-build', reason: err.message }
        throw err
      }

      const events = await tx.$queryRawUnsafe<Array<{ new_row: string | null; old_row: string | null; truncated: boolean }>>(
        `SELECT row_data::text AS new_row, old_data::text AS old_row, truncated
           FROM ${outbox}
          WHERE id > $1::bigint AND table_name = $2 AND event_type = $3
            AND (truncated OR row_data = $4::jsonb)
          ORDER BY id
          LIMIT 1`,
        last[0]?.id ?? '0', table, op, row,
      )
      return { kind: 'captured', event: events[0] ?? null }
    },
  )

  if (result.kind === 'cannot-build') return unchecked(result.reason)
  if (result.kind === 'no-outbox' || !result.event) {
    return missed(`${words} in "${table}" is not captured, so the function would not run`)
  }
  if (op === 'UPDATE' && result.event.new_row !== null && result.event.old_row !== null) {
    const after = JSON.parse(result.event.new_row) as Record<string, unknown>
    const before = JSON.parse(result.event.old_row) as Record<string, unknown>
    const event: FunctionEvent = { type: 'update', table, data: after, old: before }
    if (changedNothing(after, before) || !executor.dueForUpdate(watched, event)) {
      return unchecked('the test update did not change a column it runs on')
    }
  }
  return { outcome: 'reached', name: fn.name, why: `${words} in "${table}" reaches it` }
}

async function checkTriggerExecution(projectId: string): Promise<BehavioralCheck> {
  const base: BehavioralCheck = {
    id: 'trigger_execution',
    name: 'Row-event functions (a row change reaches each function that runs on it)',
    passed: false,
    skipped: false,
    details: [],
  }

  // Every function a captured change would be queued for: switched-off ones
  // are not (lib/services/ai-functions/status.ts).
  const functions = await prisma.aiFunction.findMany({
    where: {
      projectId,
      status: RUNNABLE_FUNCTION_STATUS_FILTER,
      triggerType: { in: Object.keys(ROW_EVENT_OPERATION) },
      triggerTable: { not: null },
    },
    select: { id: true, name: true, triggerType: true, triggerTable: true },
    orderBy: { name: 'asc' },
  })
  if (functions.length === 0) {
    return { ...base, skipped: true, skipReason: 'No function runs on row changes' }
  }

  const probes: RowFunctionProbe[] = []
  for (const fn of functions.slice(0, MAX_ROW_FUNCTIONS_CHECKED)) {
    probes.push(await probeRowFunction(projectId, fn))
  }
  const reached = probes.filter((p) => p.outcome === 'reached')
  const missed = probes.filter((p) => p.outcome === 'missed')
  const notChecked = probes.filter((p) => p.outcome === 'unchecked')

  const details = [
    ...reached.map((p) => `✓ ${p.name}: ${p.why}`),
    ...missed.map((p) => `✗ ${p.name}: ${p.why}`),
    ...notChecked.map((p) => `⏭ Couldn't check ${p.name}: ${p.why}`),
  ]
  const more = functions.length - probes.length
  if (more > 0) details.push(`~ ${more} more function${more === 1 ? '' : 's'} not checked in this run`)

  if (missed.length > 0) {
    return {
      ...base,
      details,
      error:
        missed.length === 1
          ? `${missed[0].name}: ${missed[0].why}`
          : `${missed.length} functions would not run on their row changes: ${missed.map((p) => `${p.name}: ${p.why}`).join('; ')}`,
    }
  }
  if (reached.length > 0) return { ...base, passed: true, details }
  const reasons = notChecked.map((p) => `${p.name}: ${p.why}`).join('; ')
  return {
    ...base,
    skipped: true,
    skipReason: notChecked.length === 1 ? `Couldn't check ${reasons}` : `Couldn't check ${notChecked.length} functions. ${reasons}`,
    details,
  }
}

// ─── CHECK 3.5 — Webhook HMAC ─────────────────────────────────────────────────

async function checkWebhookHmac(projectId: string): Promise<BehavioralCheck> {
  const base: BehavioralCheck = {
    id: 'webhook_hmac',
    name: 'Webhook HMAC security (invalid signature → 401 rejection)',
    passed: false,
    skipped: false,
    details: [],
  }

  // Find configured webhook functions to determine which integration to test
  const webhookFns = await prisma.aiFunction.findMany({
    where: { projectId, status: 'active', triggerType: 'on_webhook' },
    select: { id: true, name: true, triggerTable: true },
    take: 3,
  })

  // Also check outbound webhook triggers (AppTrigger)
  const webhookTriggers = await prisma.appTrigger.findMany({
    where: { projectId, actionType: 'webhook', enabled: true },
    select: { id: true, name: true, webhookSecret: true },
    take: 3,
  })

  if (webhookFns.length === 0 && webhookTriggers.length === 0) {
    return { ...base, skipped: true, skipReason: 'No webhook function or webhook trigger is set up' }
  }

  // Pick integration to test (prefer named integrations like 'stripe')
  const integrationId =
    webhookFns.find(f => f.triggerTable)?.triggerTable?.toLowerCase() ??
    'custom'

  try {
    // Dynamically import the webhook route handler to avoid circular deps
    const webhookModule = await import('@/app/api/v1/[projectId]/webhooks/[integration]/route') as any
    const webhookPost   = webhookModule.POST as Function

    const { NextRequest } = await import('next/server')
    const baseUrl  = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const testBody = JSON.stringify({ _bv_test: true, event: 'behavioral_verification' })

    const routeParams = { params: { projectId, integration: integrationId } }

    // ── Test 1: Invalid HMAC signature ────────────────────────────────────────
    const reqBadSig = new NextRequest(
      new URL(`/api/v1/${projectId}/webhooks/${integrationId}`, baseUrl),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        },
        body: testBody,
      },
    )
    const resBadSig: Response = await webhookPost(reqBadSig, routeParams)

    // ── Test 2: Missing signature header ──────────────────────────────────────
    const reqNoSig = new NextRequest(
      new URL(`/api/v1/${projectId}/webhooks/${integrationId}`, baseUrl),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: testBody,
      },
    )
    const resNoSig: Response = await webhookPost(reqNoSig, routeParams)

    // Determine whether a secret is configured for diagnostic detail. The route
    // is expected to fail closed either way.
    const secretConfigured =
      webhookTriggers.some(t => t.webhookSecret && t.webhookSecret.trim() !== '') ||
      (await (async () => {
        try {
          const { hasIntegrationKey } = await import('@/lib/services/integrationKeyStore')
          return await hasIntegrationKey(projectId, `${integrationId}_webhook_secret`)
        } catch { return false }
      })())

    if (resBadSig.status !== 401) {
      return {
        ...base,
        error: `Webhook security failure: invalid HMAC returned HTTP ${resBadSig.status} - expected 401`,
        details: [
          ...base.details,
          `Expected 401 for tampered signature, got ${resBadSig.status}`,
        ],
      }
    }
    base.details.push('Invalid HMAC signature correctly rejected (401)')

    if (resNoSig.status !== 401) {
      return {
        ...base,
        error: `Webhook security failure: missing signature returned HTTP ${resNoSig.status} - expected 401`,
        details: [
          ...base.details,
          `Expected 401 for missing signature, got ${resNoSig.status}`,
        ],
      }
    }
    base.details.push('Missing signature header correctly rejected (401)')

    if (secretConfigured) {
      base.details.push(`Webhook secret configured for '${integrationId}'`)
    } else {
      base.details.push(
        `No webhook secret configured for '${integrationId}' and endpoint still failed closed (401)`,
      )
    }

    return { ...base, passed: true }
  } catch (err: any) {
    return { ...base, error: sanitizeDiagnostic(err), details: base.details }
  }
}

// ─── CHECK 3.6 — Live HTTP API endpoints ─────────────────────────────────────
// The only check that makes real HTTP calls — tests the full network stack:
// routing → auth middleware → workspace DB → response body.
// Prior checks verify the DB layer; this verifies the HTTP layer.

async function checkLiveApiEndpoints(projectId: string): Promise<BehavioralCheck> {
  const base: BehavioralCheck = {
    id: 'live_api_endpoints',
    name: 'Live HTTP endpoints (signup → JWT → GET list → POST create via real HTTP)',
    passed: false,
    skipped: false,
    details: [],
  }

  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '')

  // Skip if auth not enabled (need JWT from /auth/signup)
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { jwtSecret: true },
  })
  if (!project?.jwtSecret || project.jwtSecret.length < 16) {
    return { ...base, skipped: true, skipReason: 'Auth not enabled — cannot obtain end-user JWT for HTTP testing' }
  }

  // Find a testable non-system, non-FK-heavy table that ALSO has an API
  // endpoint generated. A table without a generated REST API will return 404
  // from the runtime, which previously failed this check on hallucinated /
  // partially-built tables (e.g. a stray `products` table added to a social
  // backend that the build never generated APIs for).
  const SYSTEM_TABLES = new Set(['users', '_backenly_presence', 'audit_logs', 'email_events'])
  // In name order, so the same project is tested the same way every time.
  const tables = await prisma.table.findMany({
    where: { projectId },
    select: { name: true },
    orderBy: { name: 'asc' },
    take: 15,
  })

  // Which tables are actually reachable over HTTP.
  //
  // This read `ApiDefinition` until 2026-07-30, and that table has had no
  // writers since the PostgREST cutover on 2026-07-21 — no `.create`, `.update`
  // or `.upsert` anywhere in the repo. On every project created after the
  // cutover the set was EMPTY, so both candidate loops below hit `continue` on
  // every table, `candidate` stayed undefined, and this check returned
  //
  //   skipped: "No testable application tables with a generated API yet"
  //
  // on projects that had plenty of tables and perfectly working APIs. This is
  // the ONLY check that exercises the real HTTP stack end to end — signup → JWT
  // → GET list → POST create, through routing, auth and the handler — and it has
  // silently not run on any modern project. Until the aggregate verdict was
  // fixed earlier today, a skipped check also counted toward `passed`, so the
  // whole verification reported green on the strength of a check that never ran.
  //
  // The catalog is the source of truth for reachability under PostgREST: a table
  // is served because it exists and the role holds a grant on it. Ask it.
  const { listExposedTables } = await import('@/lib/mcp/schema-introspection')
  const exposed = await listExposedTables(projectId).catch(() => [] as Array<{ name: string }>)
  const tablesWithApi = new Set(exposed.map(t => t.name.toLowerCase()))

  const httpSchemaName = `workspace_${projectId}`
  let candidate: (typeof tables)[number] | undefined
  for (const t of tables) {
    const lower = t.name.toLowerCase()
    if (SYSTEM_TABLES.has(lower)) continue
    if (!tablesWithApi.has(lower)) continue // skip: no API endpoint = 404
    try {
      const fkRefs = await loadFkReferences(projectId, httpSchemaName, lower)
      if (fkRefs.filter(r => r !== lower).length > 0) continue
    } catch { /* non-fatal — include the table */ }
    candidate = t
    break
  }
  if (!candidate) {
    // Relax the FK constraint as a fallback — better to test a FK-heavy
    // endpoint and accept a 400 (validation) than to skip the live HTTP
    // check entirely and let real bugs through.
    for (const t of tables) {
      const lower = t.name.toLowerCase()
      if (SYSTEM_TABLES.has(lower)) continue
      if (!tablesWithApi.has(lower)) continue
      candidate = t
      break
    }
  }
  if (!candidate) {
    // Name which of the two states this is. "Build tables and APIs first" was
    // wrong and unactionable on a project full of working tables — it described
    // a stale projection, not the backend.
    return {
      ...base,
      skipped: true,
      skipReason:
        tablesWithApi.size === 0
          ? 'No tables are exposed over the REST API yet — create a table to enable live HTTP verification'
          : `No testable application table found (${tables.length} table(s) present, all either system tables or excluded)`,
    }
  }
  const tableName = candidate.name

  const testEmail = `__http_bv_${Date.now()}@backenly.internal`
  const testPassword = crypto.randomBytes(10).toString('hex') + 'A1!'

  const fetchWithTimeout = (url: string, opts: RequestInit, ms = 8000): Promise<Response> => {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), ms)
    // Marked as Backenly's own so a verification run is never recorded as the
    // customer's traffic (lib/traffic/request-recorder.ts).
    return fetch(url, {
      ...opts,
      headers: { ...(opts.headers as Record<string, string> | undefined), ...internalTrafficHeaders() },
      signal: controller.signal,
    }).finally(() => clearTimeout(id))
  }

  // Whether the sign-up answered. One that did not may still create the
  // account after the purge in `finally`.
  let signupAnswered = false

  try {
    // ── 1. HTTP Signup → JWT ──────────────────────────────────────────────────
    let signupRes: Response
    try {
      signupRes = await fetchWithTimeout(`${baseUrl}/api/v1/${projectId}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: testPassword, name: '__bv_http_test__' }),
      })
      signupAnswered = true
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { ...base, skipped: true, skipReason: 'HTTP test skipped — server unreachable from itself (self-request timeout)' }
      }
      return { ...base, skipped: true, skipReason: `HTTP test skipped — network error: ${sanitizeDiagnostic(err)}` }
    }

    // A 429 means the signup endpoint routed, hit the handler, and correctly
    // throttled — the HTTP stack is ALIVE, not broken. That must never be read as
    // "backend does not behave correctly" and block a deploy. Skip (not fail) so
    // a transient rate limit can't gate the readiness score. (Reserved test
    // accounts get their own generous bucket on the server, so this is a rare
    // safety net rather than the normal path.)
    if (signupRes.status === 429) {
      return {
        ...base,
        skipped: true,
        skipReason: 'Signup endpoint is rate-limited right now (429) — the HTTP stack is alive and throttling correctly, which is not a deploy blocker.',
      }
    }

    if (!signupRes.ok) {
      const body = await signupRes.text().catch(() => '')
      // Verifier accounts may use end-user auth but never provision it, so a
      // project with no users table answers them 503 AUTH_NOT_CONFIGURED. That
      // is "auth is not set up here", not "auth is broken".
      if (signupRes.status === 503 && body.includes('AUTH_NOT_CONFIGURED')) {
        return {
          ...base,
          skipped: true,
          skipReason: 'End-user auth is not set up for this project yet, so there is no signup flow to verify.',
        }
      }
      return {
        ...base,
        error: `POST /auth/signup returned HTTP ${signupRes.status} — ${sanitizeDiagnostic(body)}`,
        details: base.details,
      }
    }

    const signupData = await signupRes.json().catch(() => ({}))
    // Tolerant parse — covers all observed signup response shapes:
    //   Express runtime  → { data: { user, token } }
    //   Next.js route    → { data: { user, token } } (createSuccessResponse)
    //   Legacy / SDK     → { user, token }  or  { accessToken } / { jwt }
    // Without this fallback the verifier read signupData.token (root) and
    // missed the nested `data.token`, failing the deploy gate even though
    // signup itself worked perfectly.
    const root = signupData ?? {}
    const inner = (root as any).data ?? root
    const token: string | undefined =
      (root as any).token ?? (root as any).accessToken ?? (root as any).jwt ??
      (inner as any).token ?? (inner as any).accessToken ?? (inner as any).jwt

    if (!token) {
      return {
        ...base,
        error: 'Signup returned 2xx but no token field in response — check /auth/signup response shape',
        details: base.details,
      }
    }
    base.details.push(`✓ POST /auth/signup: ${signupRes.status} OK — JWT issued`)

    // ── 2. HTTP GET /db/{tableName} — list endpoint ───────────────────────────
    const listRes = await fetchWithTimeout(`${baseUrl}/api/v1/${projectId}/db/${tableName}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null)

    if (!listRes) {
      return { ...base, error: `GET /db/${tableName} timed out`, details: base.details }
    }
    if (listRes.status >= 500) {
      const body = await listRes.text().catch(() => '')
      return {
        ...base,
        error: `GET /db/${tableName} server error ${listRes.status}: ${body.slice(0, 150)}`,
        details: base.details,
      }
    }
    base.details.push(`✓ GET /db/${tableName}: HTTP ${listRes.status} — endpoint routes correctly`)

    // ── 3. HTTP POST /db/{tableName} — create endpoint ────────────────────────
    // Send minimal JSON — the generic CRUD handler accepts any valid JSON body.
    // A 400 (validation) or 201/200 are both acceptable; only 5xx means the handler crashed.
    const createRes = await fetchWithTimeout(`${baseUrl}/api/v1/${projectId}/db/${tableName}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ _bv_http_test: true }),
    }).catch(() => null)

    if (!createRes) {
      return { ...base, error: `POST /db/${tableName} timed out`, details: base.details }
    }
    if (createRes.status >= 500) {
      const body = await createRes.text().catch(() => '')
      return {
        ...base,
        error: `POST /db/${tableName} server error ${createRes.status}: ${body.slice(0, 150)}`,
        details: base.details,
      }
    }
    base.details.push(`✓ POST /db/${tableName}: HTTP ${createRes.status} — handler executed (${createRes.status < 400 ? 'created' : 'rejected invalid payload as expected'})`)

    return { ...base, passed: true }
  } catch (err: any) {
    return { ...base, error: `HTTP endpoint check error: ${sanitizeDiagnostic(err)}`, details: base.details }
  } finally {
    // Clean up the synthetic account AND every side-effect row the real signup
    // endpoint created for it (email-verification token, etc.). Targeted by
    // email so a concurrently-running verifier's in-flight user is untouched.
    // Runs under service-role inside the helper (users is RLS-FORCED).
    try {
      const { purgeSyntheticAuthArtifacts } = await import('@/lib/services/end-user-auth-table')
      await purgeSyntheticAuthArtifacts(projectId, { email: testEmail })
      if (!signupAnswered) {
        const { purgeAgainLater } = await import('@/lib/services/check-account-cleanup')
        purgeAgainLater(projectId, testEmail)
      }
    } catch { /* non-fatal */ }
  }
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Produce a concise human-readable summary of a behavioral verification result.
 * Suitable for returning in AI chat messages.
 */
export function formatBehavioralResult(result: BehavioralVerificationResult): string {
  const lines: string[] = []

  const ran     = result.checks.filter(c => !c.skipped)
  const passed  = ran.filter(c => c.passed)
  const failed  = ran.filter(c => !c.passed)
  const skipped = result.checks.filter(c => c.skipped)

  lines.push(`**Behavioral Verification: ${result.passed ? '✅ PASSED' : '❌ FAILED'}**`)
  lines.push(`  ${passed.length}/${ran.length} checks passed • ${skipped.length} skipped`)
  lines.push('')

  if (failed.length > 0) {
    lines.push('🚫 **Failed checks:**')
    for (const c of failed) {
      lines.push(`  • **${c.name}**: ${c.error ?? 'unknown error'}`)
      for (const d of c.details.slice(-3)) {
        lines.push(`    ${d}`)
      }
    }
    lines.push('')
  }

  if (passed.length > 0) {
    lines.push('✅ **Passed checks:**')
    for (const c of passed) {
      lines.push(`  • ${c.name}`)
    }
    lines.push('')
  }

  if (skipped.length > 0) {
    lines.push('⏭️ **Skipped (not applicable):**')
    for (const c of skipped) {
      lines.push(`  • ${c.name} — ${c.skipReason}`)
    }
  }

  return lines.join('\n')
}
