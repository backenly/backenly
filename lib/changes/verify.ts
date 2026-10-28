/**
 * PROTECTED VERIFICATION
 * ======================
 *
 * After every governed change, before it is reported to anyone, Backenly checks
 * that production is still healthy. "The SQL ran" is not that check: a
 * migration can succeed and still break production, and the failures that hurt
 * most are the silent ones.
 *
 * ── The agent cannot weaken it ──────────────────────────────────────────────
 *
 * Every check here is defined by the control plane. Nothing in the request
 * reaches it: not a tool argument, not a setting an agent can change, not the
 * statements the agent sent. Its inputs are the catalog before and after (read
 * by Backenly under its own lock), the statements Backenly captured from the
 * connection, what each step was asked to do as Backenly's own parser and
 * executor understood it, and who decided the change, which is set where the
 * identity is authenticated (lib/changes/attribution.ts) and cannot be claimed.
 *
 * ── Three-valued ────────────────────────────────────────────────────────────
 *
 * As in lib/core/fix-verification.ts: a check either confirms, contradicts, or
 * could not run. Only a contradiction is evidence the change is bad, and only a
 * contradiction starts a recovery. A check that could not run leaves the change
 * `unverified` and says so; undoing a good change because an observer went
 * blind is as wrong as keeping a bad one.
 */

import type { PoolClient } from 'pg'
import type { CatalogSnapshot, TableState } from './catalog'
import { qualified } from './names'
import { HUMAN_DECIDED_SOURCES, type TableChange } from './types'

export type CheckOutcome = 'confirmed' | 'contradicted' | 'inconclusive'

export interface VerificationCheck {
  id: string
  /** What was checked, in a few plain words. */
  label: string
  outcome: CheckOutcome
  /** What was found. Specific when it failed: which table, which object. */
  detail: string
}

export interface ChangeVerification {
  outcome: CheckOutcome
  checkedAt: string
  checks: VerificationCheck[]
}

/** What a step said it would do, as Backenly understood the step. */
export interface Expectation {
  action: string
  table?: string
  column?: string
  newName?: string
}

export interface VerifyInput {
  schema: string
  before: CatalogSnapshot
  after: CatalogSnapshot
  footprint: TableChange[]
  statements: string[]
  expectations: Expectation[]
  /** The change's source (lib/changes/types.ts). Decides whether a person chose it. */
  source: string
  client: PoolClient
}

/** The end-user auth runtime cannot work without these (lib/services/end-user-auth-table.ts). */
const AUTH_REQUIRED: Array<string[]> = [['id'], ['email'], ['password', 'password_hash']]
const API_ROLES = ['anon', 'authenticated']
const SERVING_ROLES = ['authenticated', 'service_role']

const isInternal = (table: string) => table.startsWith('_') || table.toLowerCase() === 'users'

export async function verifyChange(input: VerifyInput): Promise<ChangeVerification> {
  const checks: VerificationCheck[] = []
  const humanDecided = HUMAN_DECIDED_SOURCES.has(input.source)

  checks.push(expectedEffects(input))
  checks.push(collateralDamage(input))
  checks.push(protectionsKept(input, humanDecided))
  checks.push(credentialTablesClosed(input))
  checks.push(apiAccessKept(input, humanDecided))
  checks.push(authContract(input, humanDecided))
  checks.push(await indexesValid(input))
  checks.push(await tablesQueryable(input))

  const outcome: CheckOutcome = checks.some((c) => c.outcome === 'contradicted')
    ? 'contradicted'
    : checks.some((c) => c.outcome === 'inconclusive')
      ? 'inconclusive'
      : 'confirmed'
  return { outcome, checkedAt: new Date().toISOString(), checks }
}

function ok(id: string, label: string, detail: string): VerificationCheck {
  return { id, label, outcome: 'confirmed', detail }
}
function bad(id: string, label: string, detail: string): VerificationCheck {
  return { id, label, outcome: 'contradicted', detail }
}

// ── Each step did what it reported ───────────────────────────────────────────

function expectedEffects({ after, expectations }: VerifyInput): VerificationCheck {
  const label = 'Every step took effect'
  const missing: string[] = []
  // Executors normalise names (create_table lowercases), so a step is matched
  // without regard to case: only an object missing in every spelling counts.
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  const tableNamed = (name: string) => Object.values(after.tables).find((t) => same(t.name, name))
  const hasColumn = (t: TableState | undefined, c: string) => !!t?.columns.some((x) => same(x.name, c))
  for (const e of expectations) {
    const t = e.table ? tableNamed(e.table) : undefined
    switch (e.action) {
      case 'CREATE_TABLE':
      case 'CREATE_JUNCTION_TABLE':
        if (e.table && !t) missing.push(`table ${e.table} was reported created and does not exist`)
        break
      case 'DROP_TABLE':
        if (e.table && t) missing.push(`table ${e.table} was reported dropped and still exists`)
        break
      case 'ADD_COLUMN':
        if (e.table && e.column && !hasColumn(t, e.column)) missing.push(`${e.table}.${e.column} was reported added and does not exist`)
        break
      case 'DROP_COLUMN':
        if (e.table && e.column && hasColumn(t, e.column)) missing.push(`${e.table}.${e.column} was reported dropped and still exists`)
        break
      case 'RENAME_COLUMN':
        if (e.table && e.newName && !hasColumn(t, e.newName)) missing.push(`${e.table}.${e.newName} was reported renamed and does not exist`)
        break
      case 'SET_PERMISSION':
      case 'REMOVE_PERMISSION':
        if (e.table && !t) missing.push(`the access rules of ${e.table} were reported set and the table does not exist`)
        break
    }
  }
  if (missing.length > 0) return bad('expected_effects', label, missing.join('; '))
  return ok('expected_effects', label, expectations.length > 0 ? `${expectations.length} step${expectations.length === 1 ? '' : 's'} checked against the schema` : 'nothing to check')
}

// ── Nothing removed that the change did not name ─────────────────────────────

/**
 * A view, function or type that disappeared without any statement naming it
 * went with a CASCADE. So did a trigger or policy on a table that is still
 * there. The change did not ask for that, and nobody reviewing it saw it.
 */
function collateralDamage({ before, after, footprint, statements }: VerifyInput): VerificationCheck {
  const label = 'Nothing removed as a side effect'
  const text = statements.join('\n').toLowerCase()
  const named = (name: string) => text.includes(name.toLowerCase())
  const lost: string[] = []

  for (const c of footprint) {
    if (c.object && c.kind === 'removed' && c.before) {
      const name = before.objects?.[c.before]?.name ?? c.before
      if (!named(name)) lost.push(`${c.object.replace('_', ' ')} ${name}`)
    }
  }
  for (const c of footprint) {
    if (c.object || c.kind !== 'modified' || !c.before || !c.after) continue
    const B = before.tables[c.before]
    const A = after.tables[c.after]
    if (!B || !A) continue
    const droppedColumns = new Set(B.columns.filter((bc) => !A.columns.some((ac) => ac.attnum === bc.attnum)).map((x) => x.name))
    for (const g of B.triggers) {
      if (!A.triggers.some((x) => x.name === g.name) && !named(g.name)) lost.push(`trigger ${g.name} on ${A.name}`)
    }
    for (const con of B.constraints) {
      if (A.constraints.some((x) => x.name === con.name) || named(con.name)) continue
      // Removing a column removes the constraints on it; that is the drop, not a side effect.
      if (con.columns.length > 0 && con.columns.every((col) => droppedColumns.has(col))) continue
      lost.push(`constraint ${con.name} on ${A.name}`)
    }
  }
  if (lost.length > 0) return bad('collateral', label, `removed without being named: ${lost.join(', ')}`)
  return ok('collateral', label, 'every removal was named by the change')
}

// ── Row-level security not weakened ──────────────────────────────────────────

/** Steps whose request is a table's access rules (set_rls, add_rls). */
const ACCESS_RULE_ACTIONS = new Set(['SET_PERMISSION', 'REMOVE_PERMISSION'])

function protectionsKept({ before, after, footprint, expectations }: VerifyInput, humanDecided: boolean): VerificationCheck {
  const label = 'Row-level security kept'
  // A table whose access rules a step was asked to set: replacing its policies,
  // or opening it, is that request, not a side effect. Anything weakened on any
  // other table still is one.
  const asked = new Set(expectations.filter((e) => e.table && ACCESS_RULE_ACTIONS.has(e.action)).map((e) => e.table!.toLowerCase()))
  const weakened: string[] = []
  const requested: string[] = []
  for (const c of footprint) {
    if (c.object || !c.before || !c.after) continue
    const B = before.tables[c.before]
    const A = after.tables[c.after]
    if (!B || !A) continue
    const into = asked.has(A.name.toLowerCase()) ? requested : weakened
    if (B.rls.enabled && !A.rls.enabled) into.push(`row-level security turned off on ${A.name}`)
    if (B.rls.forced && !A.rls.forced) into.push(`row-level security no longer forced on ${A.name}`)
    for (const p of B.policies) {
      const now = A.policies.find((x) => x.name === p.name)
      if (!now) into.push(`policy ${p.name} removed from ${A.name}`)
      else if (now.using === 'true' && p.using !== 'true') into.push(`policy ${p.name} on ${A.name} now allows every row`)
    }
  }
  if (weakened.length === 0) {
    return ok('rls', label, requested.length > 0 ? `access rules set as asked: ${requested.join('; ')}` : 'no table lost row-level security')
  }
  if (humanDecided) return ok('rls', label, `changed by a person's explicit decision: ${weakened.join('; ')}`)
  return bad('rls', label, weakened.join('; '))
}

// ── Credential tables stay closed to the API ─────────────────────────────────

const exposed = (t: TableState) =>
  t.grants.filter((g) => API_ROLES.includes(g.grantee) && g.privilege === 'SELECT').map((g) => g.grantee)

function credentialTablesClosed({ before, after }: VerifyInput): VerificationCheck {
  const label = 'Credential tables closed to the API'
  const opened: string[] = []
  for (const t of Object.values(after.tables)) {
    if (!isInternal(t.name)) continue
    const now = exposed(t)
    const then = before.tables[t.name] ? exposed(before.tables[t.name]) : []
    const fresh = now.filter((r) => !then.includes(r))
    if (fresh.length > 0) opened.push(`${t.name} readable by ${fresh.join(' and ')}`)
  }
  if (opened.length > 0) return bad('credentials', label, opened.join('; '))
  return ok('credentials', label, 'no credential table newly readable by an API role')
}

// ── Existing tables keep their API access ────────────────────────────────────

function apiAccessKept({ before, after, footprint }: VerifyInput, humanDecided: boolean): VerificationCheck {
  const label = 'API access kept'
  const lost: string[] = []
  for (const c of footprint) {
    if (c.object || !c.before || !c.after) continue
    const B = before.tables[c.before]
    const A = after.tables[c.after]
    if (!B || !A || isInternal(A.name)) continue
    for (const role of SERVING_ROLES) {
      const had = B.grants.some((g) => g.grantee === role)
      const has = A.grants.some((g) => g.grantee === role)
      if (had && !has) lost.push(`${role} lost access to ${A.name}`)
    }
  }
  if (lost.length === 0) return ok('api_access', label, 'no existing table lost its API grants')
  if (humanDecided) return ok('api_access', label, `changed by a person's explicit decision: ${lost.join('; ')}`)
  return bad('api_access', label, lost.join('; '))
}

// ── End-user auth keeps working ──────────────────────────────────────────────

function authContract({ before, after }: VerifyInput, humanDecided: boolean): VerificationCheck {
  const label = 'End-user sign-in keeps working'
  const B = before.tables.users
  if (!B) return ok('auth', label, 'no users table before this change')
  const satisfied = (t: TableState | undefined) =>
    !!t && AUTH_REQUIRED.every((alts) => alts.some((col) => t.columns.some((c) => c.name === col)))
  if (!satisfied(B)) return ok('auth', label, 'the users table was not an auth table before this change')
  if (satisfied(after.tables.users)) return ok('auth', label, 'users still has id, email and a password column')
  const why = !after.tables.users ? 'the users table is gone' : 'users lost a column sign-in needs (id, email or the password)'
  if (humanDecided) return ok('auth', label, `changed by a person's explicit decision: ${why}`)
  return bad('auth', label, why)
}

// ── Indexes the change left are usable ───────────────────────────────────────

async function indexesValid({ schema, footprint, client }: VerifyInput): Promise<VerificationCheck> {
  const label = 'Indexes usable'
  const tables = footprint.filter((c) => !c.object && c.after).map((c) => c.after!)
  if (tables.length === 0) return ok('indexes', label, 'no table to check')
  try {
    const res = await client.query<{ index: string; table: string }>(
      `SELECT ic.relname AS index, tc.relname AS table
         FROM pg_index i
         JOIN pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_class tc ON tc.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = tc.relnamespace
        WHERE n.nspname = $1 AND tc.relname = ANY($2::text[]) AND (NOT i.indisvalid OR NOT i.indisready)`,
      [schema, tables],
    )
    if (res.rows.length > 0) return bad('indexes', label, res.rows.map((r) => `${r.index} on ${r.table} is invalid`).join('; '))
    return ok('indexes', label, `every index on ${tables.length} table${tables.length === 1 ? '' : 's'} is valid`)
  } catch (err: any) {
    return { id: 'indexes', label, outcome: 'inconclusive', detail: `could not read the indexes: ${err?.message ?? err}` }
  }
}

// ── Every table it touched can still be queried ──────────────────────────────

async function tablesQueryable({ schema, footprint, client }: VerifyInput): Promise<VerificationCheck> {
  const label = 'Tables queryable'
  const tables = footprint.filter((c) => !c.object && c.after).map((c) => c.after!)
  if (tables.length === 0) return ok('queryable', label, 'no table to check')
  const broken: string[] = []
  try {
    await client.query('BEGIN READ ONLY')
    for (const t of tables) {
      await client.query('SAVEPOINT q')
      try {
        await client.query(`SELECT * FROM ${qualified(schema, t)} LIMIT 0`)
        await client.query('RELEASE SAVEPOINT q')
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT q')
        broken.push(`${t}: ${err?.message ?? err}`)
      }
    }
    await client.query('COMMIT')
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {})
    return { id: 'queryable', label, outcome: 'inconclusive', detail: `could not run the check: ${err?.message ?? err}` }
  }
  if (broken.length > 0) return bad('queryable', label, broken.join('; '))
  return ok('queryable', label, `${tables.length} table${tables.length === 1 ? '' : 's'} answered a query`)
}
