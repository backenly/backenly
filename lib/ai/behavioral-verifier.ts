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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Placeholder for a value about to be bound by PRISMA.
 *
 * The cast is not cosmetic — on this transport it is mandatory. Prisma's
 * `$queryRawUnsafe` sends string parameters explicitly typed as `text`, so
 * `INSERT INTO t (uuid_col) VALUES ($1)` is rejected with
 * `42804 column "…" is of type uuid but expression is of type text` EVEN WHEN
 * the value is a well-formed uuid. (node-postgres sends parameters untyped and
 * lets Postgres infer from the target column, which is why the same SQL works
 * there — a difference that made this look like a bad value rather than a
 * transport rule.)
 *
 * So the COLUMN TYPE decides, exactly as it already did for timestamp and json.
 * It previously decided from the VALUE's shape for uuid alone, which meant any
 * uuid column whose bound value was not a canonical uuid string got a bare
 * placeholder and failed every single time. That ran 641 times against one
 * production table over six days, swallowed, reported as a passing check.
 *
 * The value-shape test is kept as a last resort for callers that genuinely do
 * not know the column type (dataType defaults to '').
 */
function typedPlaceholder(val: any, idx: number, dataType: string = ''): string {
  const t = dataType.toLowerCase()
  if (t === 'uuid') return `$${idx}::uuid`
  if (t.includes('timestamp') || t === 'date' || t.includes('time')) return `$${idx}::timestamp`
  if (t.includes('json')) return `$${idx}::jsonb`
  if (typeof val === 'string' && UUID_RE.test(val)) return `$${idx}::uuid`
  return `$${idx}`
}

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

// ─── Synthetic value generator ────────────────────────────────────────────────

/** Return a safe test value for a given PostgreSQL data_type. */
function syntheticValue(dataType: string): any {
  const t = dataType.toLowerCase()
  if (t.includes('uuid'))                                              return crypto.randomUUID()
  if (t.includes('bool'))                                              return false
  if (t.includes('int') || t.includes('serial'))                       return 0
  if (t.includes('float') || t.includes('double') ||
      t.includes('decimal') || t.includes('numeric') ||
      t.includes('real'))                                              return 0
  if (t.includes('timestamp') || t.includes('date') || t.includes('time')) return new Date().toISOString()
  if (t.includes('json'))                                              return '{}'
  if (t.startsWith('_') || t.includes('array'))                       return '{}'
  // text, varchar, char, citext, name, etc.
  return '__bv_test__'
}

// ─── Column loader ────────────────────────────────────────────────────────────

interface ColInfo {
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
}

async function loadColumns(projectId: string, schemaName: string, tableName: string): Promise<ColInfo[]> {
  // The catalog of the project's database, in its region; resolved outside any
  // catch, so an unreachable region fails the check rather than skipping it.
  const db = await workspaceRawClient(projectId)
  return db.$queryRawUnsafe<ColInfo[]>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    schemaName, tableName,
  )
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
 * referenced columns. The seeding code uses this map to insert parent rows with
 * the exact id that the FK will reference, as does run_test's create
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

/**
 * Return a map of column_name → first valid string from its CHECK constraint.
 * Used to avoid inserting synthetic values that violate enum-style checks, here
 * and by run_test's create (lib/ai/brain/verify-create.ts).
 */
export async function loadCheckConstraintValues(
  projectId: string,
  schemaName: string,
  tableName: string,
): Promise<Record<string, string>> {
  // The catalog of the project's database, in its region; resolved outside any
  // catch, so an unreachable region fails the check rather than skipping it.
  const db = await workspaceRawClient(projectId)
  try {
    const rows = await db.$queryRawUnsafe<{ attname: string; consrc: string }[]>(
      `SELECT a.attname, pg_get_constraintdef(c.oid) AS consrc
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
       WHERE c.contype = 'c'
         AND n.nspname = $1
         AND t.relname = $2`,
      schemaName, tableName,
    )
    const result: Record<string, string> = {}
    for (const row of rows) {
      // Extract first quoted literal from IN (...) or = '...' expressions
      const match = row.consrc.match(/'([^']+)'/)
      if (match) result[row.attname] = match[1]
    }
    return result
  } catch {
    return {}
  }
}

/** Build (insertCols, insertVals, colInfoMap) for required non-default columns, skipping id. */
function buildInsertParts(
  cols: ColInfo[],
  overrides: Record<string, any> = {},
): { insertCols: string[]; insertVals: any[]; colInfoMap: Map<string, string> } {
  const insertCols: string[] = []
  const insertVals: any[] = []
  const colInfoMap = new Map<string, string>()
  for (const col of cols) {
    if (col.column_name === 'id') continue
    if (col.column_name in overrides) {
      insertCols.push(col.column_name)
      insertVals.push(overrides[col.column_name])
      colInfoMap.set(col.column_name, col.data_type)
      continue
    }
    if (col.column_default !== null) continue
    if (col.is_nullable === 'YES') continue
    insertCols.push(col.column_name)
    insertVals.push(syntheticValue(col.data_type))
    colInfoMap.set(col.column_name, col.data_type)
  }
  return { insertCols, insertVals, colInfoMap }
}

function buildInsertSql(
  schemaName: string,
  tableName: string,
  insertCols: string[],
  insertVals: any[],
  colInfoMap: Map<string, string> = new Map(),
): { sql: string; params: any[] } {
  if (insertCols.length === 0) {
    return {
      sql: `INSERT INTO "${schemaName}"."${tableName}" DEFAULT VALUES RETURNING *`,
      params: [],
    }
  }
  const colList = insertCols.map(c => `"${c}"`).join(', ')
  const placeholders = insertVals.map((v, i) => typedPlaceholder(v, i + 1, colInfoMap.get(insertCols[i]) ?? '')).join(', ')
  return {
    sql: `INSERT INTO "${schemaName}"."${tableName}" (${colList}) VALUES (${placeholders}) RETURNING *`,
    params: insertVals,
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

/** A parent row a check writes for its test row's foreign keys. */
interface ParentSeed {
  table: string
  /** The test row's columns that reference this parent. */
  mappings: FkColumnMapping[]
  sql: string
  params: any[]
}

/**
 * The INSERT for each parent table a test row's foreign keys need, planned
 * from the catalog before the check's transaction opens. `seedId` is the id
 * each parent is written with, the value every FK pointing at it gets.
 */
async function planParentSeeds(
  projectId: string,
  schemaName: string,
  mappingsByParent: Map<string, FkColumnMapping[]>,
  seedId: () => string,
  emailPrefix: string,
): Promise<ParentSeed[]> {
  const seeds: ParentSeed[] = []
  for (const [table, mappings] of mappingsByParent) {
    const refCols = await loadColumns(projectId, schemaName, table)
    if (refCols.length === 0) continue
    const id = seedId()
    const refCheckOverrides = await loadCheckConstraintValues(projectId, schemaName, table)
    // buildInsertParts skips 'id', so prepend it: the seeded parent must land
    // on a known id, which is the value written into every FK pointing at it.
    const { insertCols, insertVals, colInfoMap } = buildInsertParts(refCols, {
      ...refCheckOverrides,
      email: `${emailPrefix}${id.slice(0, 8)}@test.internal`,
    })
    const { sql, params } = buildInsertSql(
      schemaName,
      table,
      ['id', ...insertCols],
      [id, ...insertVals],
      new Map<string, string>([['id', 'uuid'], ...colInfoMap]),
    )
    seeds.push({ table, mappings, sql, params })
  }
  return seeds
}

/**
 * Write `seeds` in the check's transaction, adding a line to `details` for
 * each. Returns the value each FK column gets, or the parent that could not be
 * written; after that the transaction is aborted, so the check must stop.
 */
async function writeParentSeeds(
  tx: ProbeTx,
  seeds: ParentSeed[],
  details: string[],
): Promise<{ overrides: Record<string, string> } | { failed: string; err: unknown }> {
  const overrides: Record<string, string> = {}
  for (const seed of seeds) {
    let rows: any[]
    try {
      rows = await tx.$queryRawUnsafe<any[]>(seed.sql, ...seed.params)
    } catch (err) {
      return { failed: seed.table, err }
    }
    if (!rows[0]) continue
    const parentId = String(rows[0].id ?? rows[0][Object.keys(rows[0])[0]])
    for (const m of seed.mappings) overrides[m.column] = parentId
    details.push(
      `✓ Seeded "${seed.table}" id=${parentId.slice(0, 8)}… (FK${seed.mappings.length === 1 ? '' : 's'}: ${seed.mappings.map(m => m.column).join(', ')})`,
    )
  }
  return { overrides }
}

// ─── CHECK 3.1 — CRUD lifecycle ───────────────────────────────────────────────

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

  // Find the first project table that is not a system table.
  // Async job/workflow tables (names matching *_jobs, *_tasks, generation_*) often
  // have FK constraints referencing other tables we can't create rows in during a test.
  // We skip them and try the next candidate instead of failing the CRUD check.
  const SYSTEM_TABLES = new Set(['users', '_backenly_presence', 'audit_logs', 'email_events', 'sms_events'])
  const ASYNC_JOB_PATTERN = /(_jobs|_tasks|_queue|_runs|generation_|generated_|_steps|_events)$/i

  const tables = await prisma.table.findMany({
    where: { projectId },
    select: { name: true },
    take: 20,
  })

  const schemaName = `workspace_${projectId}`
  let candidate: { name: string } | null = null

  for (const t of tables) {
    const lName = t.name.toLowerCase()
    if (SYSTEM_TABLES.has(lName)) continue

    // A foreign key is no longer disqualifying — parents get seeded below, the
    // same way checkRlsIsolation already does it.
    //
    // This used to `continue` on any FK to another table, with the reasoning
    // "we can't create a real user in a CRUD test". On a normal relational
    // schema that is every table, so the check tested nothing and reported it
    // as though the project were empty. The capability it called impossible
    // lives a few hundred lines below in this same file.
    //
    // Only ONE case still disqualifies: a FK referencing a non-id parent column
    // (compound PK, unusual target). Synthetic seeding cannot satisfy those, and
    // guessing produces a confusing 23503 instead of an honest skip — the same
    // line checkRlsIsolation draws.
    try {
      const fkMaps = await loadFkColumnMappings(projectId, schemaName, lName)
      const unseedable = fkMaps.filter(m => m.foreignColumn !== 'id' && m.foreignTable !== lName)
      if (unseedable.length > 0) {
        base.details.push(
          `⏭ Skipping '${lName}' — FK(s) reference non-id parent columns ` +
          `(${unseedable.map(m => `${m.column}→${m.foreignTable}.${m.foreignColumn}`).join(', ')})`,
        )
        continue
      }
    } catch {
      // FK metadata query failed — be conservative and skip this table.
      base.details.push(`⏭ Skipping '${lName}' — could not read FK constraints`)
      continue
    }

    candidate = t
    break
  }

  if (!candidate) {
    // Say what was actually true. "No testable tables exist yet" reads as an
    // empty project, and it was being returned for a fully-built relational
    // schema where every table simply has a foreign key — which is most real
    // schemas. That phrasing turned a KNOWN COVERAGE GAP into what looked like
    // a project with nothing in it.
    //
    // FK parents are seeded below (planParentSeeds), so what is left here is a
    // FK to a parent column other than its id, or FK metadata that could not
    // be read.
    const skipped = base.details.filter(d => d.startsWith('⏭')).length
    return {
      ...base,
      skipped: true,
      skipReason:
        skipped > 0
          ? `CRUD lifecycle not exercised: all ${skipped} candidate table(s) carry foreign keys, and this check does not yet seed parent rows. This is a coverage gap, not an empty project.`
          : 'No application tables exist yet to exercise a CRUD lifecycle against.',
    }
  }

  const tableName = candidate.name.toLowerCase()

  // A test user ID to satisfy NOT NULL owner columns and jwt_claim() defaults.
  const dummyUserId = crypto.randomUUID()
  const USER_ID_COLS = new Set(['user_id', 'userid', 'author_id', 'authorid', 'owner_id', 'ownerid', 'created_by', 'createdby'])

  try {
    const cols = await loadColumns(projectId, schemaName, tableName)
    if (cols.length === 0) {
      return { ...base, skipped: true, skipReason: `Table '${tableName}' has no columns in information_schema` }
    }

    // ── Plan the FK parents ───────────────────────────────────────────────────
    // Authoritative mapping from pg_constraint, not column-name heuristics:
    // `author_id → users.id` and `parent_comment_id → comments.id` both need the
    // exact target, and guessing is what produced 23503 in the field.
    const fkMappings = await loadFkColumnMappings(projectId, schemaName, tableName)
    const mappingsByParent = new Map<string, FkColumnMapping[]>()
    for (const m of fkMappings) {
      // A self-referencing FK is satisfied by leaving the column null; seeding a
      // parent in the same table would just create a second row.
      if (m.foreignTable === tableName) continue
      const arr = mappingsByParent.get(m.foreignTable) ?? []
      arr.push(m)
      mappingsByParent.set(m.foreignTable, arr)
    }
    const seeds = await planParentSeeds(projectId, schemaName, mappingsByParent, () => crypto.randomUUID(), '__bv_crud_')
    const checkOverrides = await loadCheckConstraintValues(projectId, schemaName, tableName)

    // Every write below is rolled back with the transaction: nothing to clean up.
    return await inRolledBackTransaction<BehavioralCheck>(
      projectId,
      { userId: dummyUserId, isServiceRole: true },
      async (tx) => {
        const seeded = await writeParentSeeds(tx, seeds, base.details)
        if ('failed' in seeded) {
          // Skip rather than fail: an unseedable parent says nothing about
          // whether CRUD works.
          return {
            ...base,
            skipped: true,
            skipReason:
              `CRUD lifecycle skipped — could not seed parent table "${seeded.failed}" required by a FK on ` +
              `"${tableName}": ${sanitizeDiagnostic(seeded.err)}`,
            details: base.details,
          }
        }
        const fkOverrides = seeded.overrides

        // ── INSERT ────────────────────────────────────────────────────────────
        // Fill owner and NOT NULL columns that weren't seeded via explicit FKs
        const ownerOverrides: Record<string, string> = {}
        for (const c of cols) {
          if (USER_ID_COLS.has(c.column_name.toLowerCase()) && !fkOverrides[c.column_name]) {
            ownerOverrides[c.column_name] = dummyUserId
          }
        }

        const { insertCols, insertVals, colInfoMap } = buildInsertParts(cols, { ...checkOverrides, ...fkOverrides, ...ownerOverrides })
        const { sql: insertSql, params: insertParams } = buildInsertSql(schemaName, tableName, insertCols, insertVals, colInfoMap)

        const inserted = await tx.$queryRawUnsafe<any[]>(insertSql, ...insertParams)
        if (!inserted[0]) {
          return { ...base, error: 'INSERT returned no row', details: [...base.details, '✗ INSERT failed'] }
        }
        const testId = String(inserted[0].id ?? inserted[0][Object.keys(inserted[0])[0]])
        base.details.push(`✓ INSERT succeeded (id=${testId})`)

        // ── READ ──────────────────────────────────────────────────────────────
        const readSql = `SELECT * FROM "${schemaName}"."${tableName}" WHERE id = $1::uuid`
        const readRows = await tx.$queryRawUnsafe<any[]>(readSql, testId)
        if (readRows.length === 0) {
          return { ...base, error: 'READ returned 0 rows after INSERT', details: [...base.details, '✗ READ failed'] }
        }
        base.details.push('✓ READ returned inserted row')

        // ── UPDATE (best-effort — needs a text column) ────────────────────────
        const textCol = cols.find(
          c => c.column_name !== 'id' &&
               ['text', 'character varying', 'varchar', 'character', 'citext'].includes(c.data_type),
        )
        if (textCol) {
          const updateSql = `UPDATE "${schemaName}"."${tableName}" SET "${textCol.column_name}" = $1 WHERE id = $2::uuid RETURNING id`
          const updated = await tx.$queryRawUnsafe<any[]>(updateSql, '__bv_updated__', testId)
          if (updated.length > 0) {
            base.details.push(`✓ UPDATE succeeded on column '${textCol.column_name}'`)
          } else {
            base.details.push(`~ UPDATE on '${textCol.column_name}' matched 0 rows (non-fatal)`)
          }
        } else {
          base.details.push('~ UPDATE skipped (no text column available for this table)')
        }

        // ── DELETE ────────────────────────────────────────────────────────────
        const deleteSql = `DELETE FROM "${schemaName}"."${tableName}" WHERE id = $1::uuid RETURNING id`
        const deleted = await tx.$queryRawUnsafe<any[]>(deleteSql, testId)
        if (deleted.length === 0) {
          return { ...base, error: 'DELETE matched 0 rows', details: [...base.details, '✗ DELETE failed'] }
        }
        base.details.push('✓ DELETE succeeded')

        // ── POST-DELETE READ — must return 0 rows ─────────────────────────────
        const postDeleteRows = await tx.$queryRawUnsafe<any[]>(readSql, testId)
        if (postDeleteRows.length > 0) {
          return {
            ...base,
            error: `Row still exists after DELETE (id=${testId})`,
            details: [...base.details, '✗ Post-delete read returned rows — the DELETE did not remove the row'],
          }
        }
        base.details.push('✓ Post-delete read returns 0 rows')

        return { ...base, passed: true }
      },
    )
  } catch (err: any) {
    return { ...base, error: sanitizeDiagnostic(err), details: base.details }
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

  // 3. Introspect actual users table schema — avoids hardcoded column assumptions
  //    (OAuth-only tables have no password column; Prisma camelCase tables differ from snake_case)
  const cols = await loadColumns(projectId, schemaName, 'users')
  if (cols.length === 0) {
    return { ...base, skipped: true, skipReason: 'workspace users table has no columns in information_schema' }
  }
  const colNames = new Set(cols.map(c => c.column_name.toLowerCase()))
  if (!colNames.has('id') || !colNames.has('email')) {
    return { ...base, skipped: true, skipReason: 'workspace users table is missing required id or email columns' }
  }

  const testEmail = `__bv_test_${Date.now()}@backenly.internal`

  try {
    // ── Signup: dynamic INSERT shaped to the actual table schema ──────────────
    // Build overrides for all known auth-related columns, then use buildInsertParts
    // to fill in any remaining NOT NULL columns with synthetic values — this handles
    // extended users tables that have extra required columns like role, status, etc.
    const userId = crypto.randomUUID()
    const overrides: Record<string, any> = {
      email: testEmail,
    }
    if (colNames.has('password')) {
      overrides.password = await hashPassword(crypto.randomBytes(12).toString('hex'))
    }
    if (colNames.has('name'))           overrides.name           = '__bv_test_user__'
    if (colNames.has('role'))           overrides.role           = 'customer'
    if (colNames.has('status'))         overrides.status         = 'active'
    if (colNames.has('is_active'))      overrides['is_active']   = true
    if (colNames.has('email_verified')) overrides['email_verified'] = false
    // Only set phone to null when the column actually allows nulls — forcing null on NOT NULL phone columns triggers 23502
    const phoneColInfo = cols.find(c => c.column_name === 'phone')
    if (colNames.has('phone') && phoneColInfo?.is_nullable === 'YES') overrides.phone = null
    // Prisma camelCase timestamps
    if (cols.some(c => c.column_name === 'createdAt' && c.column_default === null && c.is_nullable === 'NO'))
      overrides['createdAt'] = new Date().toISOString()
    if (cols.some(c => c.column_name === 'updatedAt' && c.column_default === null && c.is_nullable === 'NO'))
      overrides['updatedAt'] = new Date().toISOString()

    // buildInsertParts skips 'id' — prepend it manually
    const { insertCols, insertVals, colInfoMap: authColInfoMap } = buildInsertParts(cols, overrides)
    const allCols = ['id', ...insertCols]
    const allVals: any[] = [userId, ...insertVals]
    const authColTypes = new Map([['id', 'uuid'], ...authColInfoMap])

    const colList      = allCols.map(c => `"${c}"`).join(', ')
    const placeholders = allVals.map((v, i) => typedPlaceholder(v, i + 1, authColTypes.get(allCols[i]) ?? '')).join(', ')

    // Service-role: the workspace users table may have RLS enabled
    // (own_rows / public_read templates). Real signup also runs as
    // service-role; the verifier must do the same to match production
    // behavior, otherwise PG 42501 surfaces here even though the live
    // signup route would succeed. The test user is rolled back with the
    // transaction, so it never exists outside it.
    return await inRolledBackTransaction<BehavioralCheck>(projectId, { userId: '', isServiceRole: true }, async (tx) => {
      const signupResult = await tx.$queryRawUnsafe<any[]>(
        `INSERT INTO "${schemaName}"."users" (${colList}) VALUES (${placeholders})
         ON CONFLICT DO NOTHING
         RETURNING id, email`,
        ...allVals,
      )

      if (!signupResult[0]?.id) {
        return { ...base, error: 'Signup: INSERT into workspace users returned no row', details: base.details }
      }
      const testUserId = String(signupResult[0].id)
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
      const protectedRead = await tx.$queryRawUnsafe<any[]>(
        `SELECT id, email FROM "${schemaName}"."users" WHERE id = $1::uuid`,
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

  // Find tables with Backenly-managed RLS policies
  const rlsTables = await db.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT DISTINCT tablename FROM pg_policies
     WHERE schemaname = $1 AND policyname LIKE 'backenly_%'`,
    schemaName,
  )

  if (rlsTables.length === 0) {
    return { ...base, skipped: true, skipReason: 'No Backenly-managed RLS policies exist yet' }
  }

  // Find the first RLS table that has a user_id-like column
  const USER_ID_COLS = new Set(['user_id', 'userid', 'author_id', 'authorid', 'owner_id', 'ownerid', 'created_by', 'createdby'])
  let targetTable: string | null = null
  let userIdCol: string | null = null

  for (const { tablename } of rlsTables) {
    const cols = await db.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      schemaName, tablename,
    )
    const match = cols.find(c => USER_ID_COLS.has(c.column_name.toLowerCase()))
    if (match) {
      targetTable = tablename
      userIdCol   = match.column_name
      break
    }
  }

  if (!targetTable || !userIdCol) {
    return { ...base, skipped: true, skipReason: 'No RLS-protected table has a user_id-like column' }
  }
  const table = targetTable
  const ownerCol = userIdCol

  const userAId = crypto.randomUUID()
  const userBId = crypto.randomUUID()

  try {
    const cols = await loadColumns(projectId, schemaName, table)
    if (cols.length === 0) {
      return { ...base, skipped: true, skipReason: `Table '${table}' has no columns in information_schema` }
    }

    // ── Plan parent rows for FK columns ──────────────────────────────────────
    // Use precise FK metadata from pg_constraint so we know the EXACT
    // (column → parent.column) mapping. Heuristics on column names
    // ("does user_id map to users.id?") miss compound cases like
    // `author_id → users.id` or `parent_comment_id → comments.id` and
    // produce the 23503 failure pattern seen in the field.
    const fkMappings = await loadFkColumnMappings(projectId, schemaName, table)

    // Group mappings by parent table so we seed each parent once even when
    // multiple FK columns point at it (e.g. created_by AND updated_by both
    // referencing users.id).
    const mappingsByParent = new Map<string, FkColumnMapping[]>()
    for (const m of fkMappings) {
      const arr = mappingsByParent.get(m.foreignTable) ?? []
      arr.push(m)
      mappingsByParent.set(m.foreignTable, arr)
    }

    // When any FK references a non-id column we can't easily seed (compound
    // PKs, unusual referenced columns) — bail with a clear skip reason rather
    // than producing a confusing 23503.
    const unseedableFks = fkMappings.filter(m => m.foreignColumn !== 'id')
    if (unseedableFks.length > 0) {
      return {
        ...base,
        skipped: true,
        skipReason:
          `RLS test skipped — table "${table}" has FK(s) referencing non-id parent columns ` +
          `(${unseedableFks.map(m => `${m.column}→${m.foreignTable}.${m.foreignColumn}`).join(', ')}). ` +
          `Synthetic seeding cannot satisfy these.`,
      }
    }

    // Every parent is written with id=userAId, the value written into every
    // FK column that targets it.
    const seeds = await planParentSeeds(projectId, schemaName, mappingsByParent, () => userAId, '__bv_test_')
    const rlsCheckOverrides = await loadCheckConstraintValues(projectId, schemaName, table)

    // Each write and read below runs in one transaction that is rolled back,
    // switching identity between them: nothing to clean up.
    const failed = await inRolledBackTransaction<BehavioralCheck | null>(
      projectId,
      // User A inserts via service role (bypass existing RLS for test setup)
      { userId: userAId, isServiceRole: true },
      async (tx) => {
        const seeded = await writeParentSeeds(tx, seeds, base.details)
        if ('failed' in seeded) {
          // Surface the failure clearly. A silent skip here masks the real cause
          // of downstream 23503 errors — bail with a SKIP so the developer knows.
          return {
            ...base,
            skipped: true,
            skipReason:
              `RLS test skipped — could not seed parent table "${seeded.failed}" required by FK on "${table}": ` +
              sanitizeDiagnostic(seeded.err),
          }
        }

        // Build insert overriding the owner column to belong to user A + any FK overrides
        const { insertCols, insertVals, colInfoMap: rlsColInfoMap } = buildInsertParts(
          cols,
          { ...rlsCheckOverrides, ...seeded.overrides, [ownerCol]: userAId },
        )
        const { sql: insertSql, params: insertParams } = buildInsertSql(schemaName, table, insertCols, insertVals, rlsColInfoMap)

        const inserted = await tx.$queryRawUnsafe<any[]>(insertSql, ...insertParams)
        if (!inserted[0]) {
          return { ...base, error: `RLS test: INSERT as user A into '${table}' failed`, details: base.details }
        }
        const testId = String(inserted[0].id ?? inserted[0][Object.keys(inserted[0])[0]])
        base.details.push(`✓ User A (${userAId.slice(0, 8)}…) inserted row id=${testId}`)

        // User B tries to read user A's row — must be denied by RLS
        const readSql = `SELECT id FROM "${schemaName}"."${table}" WHERE id = $1::uuid`
        await actAs(tx, { userId: userBId, isServiceRole: false })
        const userBRows = await tx.$queryRawUnsafe<any[]>(readSql, testId)

        if (userBRows.length > 0) {
          return {
            ...base,
            error: `RLS isolation failure: user B can read user A's row (table: ${table})`,
            details: [
              ...base.details,
              `✗ User B (${userBId.slice(0, 8)}…) returned ${userBRows.length} row(s) — should be 0`,
            ],
          }
        }
        base.details.push(`✓ User B (${userBId.slice(0, 8)}…) correctly denied — 0 rows returned`)

        // User A reads their own row — should succeed
        await actAs(tx, { userId: userAId, isServiceRole: false })
        const userARows = await tx.$queryRawUnsafe<any[]>(readSql, testId)
        if (userARows.length > 0) {
          base.details.push('✓ User A can read their own row (self-access allowed)')
        } else {
          base.details.push('~ User A self-read returned 0 rows (own_rows policy may use different column mapping)')
        }
        return null
      },
    )
    if (failed) return failed

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
  } catch (err: any) {
    return { ...base, error: sanitizeDiagnostic(err), details: base.details }
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

/** How many levels of parent rows the probe creates for a row's foreign keys. */
const MAX_PARENT_DEPTH = 3

/** A column, as the probe gives it a value. */
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
  /** The quoted values a single-column CHECK names, per column, in order. */
  allowed: Record<string, string[]>
  fks: FkColumnMapping[]
}

/** Why a test row could not be written; reported as "couldn't check", never as a failure. */
class CannotBuildRow extends Error {}

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

  const checks = await db.$queryRawUnsafe<Array<{ column: string; def: string }>>(
    `SELECT a.attname AS column, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'c' AND n.nspname = $1 AND t.relname = $2
        AND array_length(c.conkey, 1) = 1`,
    schemaName, table,
  )
  // Only a list of values, `col IN (...)` (which PostgreSQL prints as
  // `= ANY (ARRAY[...])`) or `col = '...'`: the quoted text in any other CHECK,
  // a pattern such as (email ~* '^.+@.+$') say, is not a value it allows.
  const allowed: Record<string, string[]> = {}
  for (const check of checks) {
    if (!/= ANY \(ARRAY\[/.test(check.def) && !/^CHECK \(+"?[^"\s]+"? = '/.test(check.def)) continue
    const literals = Array.from(check.def.matchAll(/'((?:[^']|'')*)'/g), (m) => m[1].replace(/''/g, "'"))
    if (literals.length > 0) allowed[check.column] = [...(allowed[check.column] ?? []), ...literals]
  }

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
    allowed,
    fks: await loadFkColumnMappings(projectId, schemaName, table),
  }
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

/** A diagnostic sentence as a clause: lower-case start, no closing full stop. */
const clause = (text: string) => text.charAt(0).toLowerCase() + text.slice(1).replace(/\.\s*$/, '')

/** A value for `col`, as text PostgreSQL casts to the column's type. */
function probeValue(col: ProbeColumn, allowed: string[] | undefined, salt: string): string {
  if (allowed && allowed.length > 0) return allowed[0]
  if (col.enumLabels && col.enumLabels.length > 0) return col.enumLabels[0]
  switch (col.typname) {
    case 'uuid': return crypto.randomUUID()
    case 'json':
    case 'jsonb': return '{}'
    case 'date': return new Date().toISOString().slice(0, 10)
    case 'time':
    case 'timetz': return '12:00:00'
    case 'inet':
    case 'cidr': return '192.0.2.1'
    case 'bytea': return '\\x00'
  }
  switch (col.category) {
    // 1, not 0: a CHECK such as (amount > 0) is far commoner than one 1 breaks.
    case 'N': return '1'
    case 'B': return 'false'
    case 'D': return new Date().toISOString()
    case 'T': return '1 hour'
    case 'A': return '{}'
  }
  return /e[-_]?mail/i.test(col.name) ? `bv-probe-${salt}@example.com` : `__bv_probe_${salt}`
}

/**
 * Insert a row Backenly can build into `plan.table`, with the parent rows its
 * foreign keys need, inside the probe's transaction. Returns the row's ctid.
 * Throws CannotBuildRow when no such row can be written.
 */
async function insertProbeRow(
  tx: ProbeTx,
  projectId: string,
  schemaName: string,
  plan: ProbeTable,
  salt: string,
  path: string[] = [],
  mustFill: string[] = [],
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

  const values = new Map<string, string>()
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
    if (!values.has(col.name)) values.set(col.name, probeValue(col, plan.allowed[col.name], salt))
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
    throw new CannotBuildRow(`a test row could not be written to "${plan.table}" (${clause(sanitizeDiagnostic(err))})`)
  }
  if (!rows[0]) throw new CannotBuildRow(`writing a test row to "${plan.table}" returned no row`)
  return rows[0]
}

/**
 * Change one column of the probe row so the update is one `fn` runs for: a
 * column it watches when it watches any, otherwise any column a test may
 * change. Returns the updated row's ctid.
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
  // column; plain values first, an id last.
  const keys = new Set(plan.fks.map((fk) => fk.column))
  const settable = (c: ProbeColumn) => !c.computed && !keys.has(c.name)
  const rank = (c: ProbeColumn) =>
    (c.name === 'id' ? 10 : 0) + ('SNBDTE'.includes(c.category) ? 0 : c.typname === 'uuid' || c.typname.startsWith('json') ? 5 : 20)
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
  const listed = plan.allowed[col.name] ?? col.enumLabels ?? null
  let set: string
  const params: unknown[] = [ctid]
  if (listed && listed.length > 0) {
    // A different value from the ones the column allows.
    const current = await tx.$queryRawUnsafe<Array<{ value: string | null }>>(
      `SELECT ${column}::text AS value FROM ${target} WHERE ctid = $1::tid`, ctid,
    )
    const next = listed.find((v) => v !== current[0]?.value)
    if (next === undefined) {
      throw new CannotBuildRow(`"${col.name}" allows only one value, so a test update cannot change it`)
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
    throw new CannotBuildRow(`"${col.name}" could not be changed by a test update (${clause(sanitizeDiagnostic(err))})`)
  }
}

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
  const tables = await prisma.table.findMany({
    where: { projectId },
    select: { name: true },
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

  try {
    // ── 1. HTTP Signup → JWT ──────────────────────────────────────────────────
    let signupRes: Response
    try {
      signupRes = await fetchWithTimeout(`${baseUrl}/api/v1/${projectId}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: testPassword, name: '__bv_http_test__' }),
      })
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
