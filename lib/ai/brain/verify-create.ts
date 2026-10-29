/**
 * RUN_TEST "CREATE": A REAL INSERT, AS A SIGNED-IN TEST USER
 * =========================================================
 * create used to POST a synthesised row with the project's anon key. The anon
 * key is publishable: every write it sends without an end user's X-User-Token
 * is refused, and the verifier counted that refusal as a pass ("enforcing
 * access control beyond the anon key"). So on any routed table create
 * answered ok without inserting anything, and a broken insert path passed: a
 * bad default, a trigger that raises, a constraint the sample row breaks
 * (#248). Now it writes, and cleans up after itself:
 *
 *   1. A throwaway end user signs up through the project's own /auth/signup,
 *      on a reserved address and as Backenly's own traffic, the way the
 *      behavioral verifier's live HTTP check does. The row is sent with the
 *      anon key and that user's token as X-User-Token.
 *   2. The row comes from the live catalog. Columns the database fills in
 *      (a default, identity, generated) and nullable ones are left out; the
 *      owner column(s) and references to `users` get the test user; a column
 *      under a CHECK takes a value it allows; a required reference to another
 *      table gets one parent row, owned by the test user, inserted first.
 *   3. The answer is judged. 2xx: the insert ran. 400, 409 or 5xx: it failed,
 *      and the database's own reason comes from replaying the insert in a
 *      transaction that is rolled back, because the runtime reduces most
 *      database errors to "Request could not be completed". 401 or 403: judged
 *      against the catalog (refusalVerdict), because the runtime answers every
 *      privilege error alike.
 *   4. The row, any parent and the user are removed, whatever happened.
 *
 * A project without end-user sign-up has no one to write as. Only there is a
 * refusal of the anon key counted as a pass, and the summary says the insert
 * path was not exercised.
 */

import crypto from 'crypto'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { rlsSessionParams, rlsSessionSql } from '@/lib/services/rls-session'
import { inferRlsPlan, type RlsPlan } from '@/lib/services/rls-ownership'
import { purgeSyntheticAuthArtifacts } from '@/lib/services/end-user-auth-table'
import { internalTrafficHeaders } from '@/lib/traffic/request-recorder'
import { loadCheckConstraintValues, loadFkColumnMappings } from '../behavioral-verifier'
import type { EndpointTestResult } from './verifier'

/** Where the test sends its requests, and how long each may take. */
export interface CreateTestTarget {
  projectId: string
  tableName: string
  /** The project's workspace schema. */
  schema: string
  appUrl: string
  anonKey: string
  timeoutMs: number
}

/** The end-user table signup writes to: a reference to it is a reference to the test user. */
const USERS_TABLE = 'users'

interface Column {
  name: string
  /** pg_type.typname: uuid, int4, text, timestamptz, an enum's own name… */
  typeName: string
  /** pg_type.typcategory: S string, N numeric, B boolean, D date/time, A array, E enum, U other. */
  category: string
  typeOid: number
  maxLength: number | null
  notNull: boolean
  hasDefault: boolean
  /** An identity or generated column: the database writes it, and refuses a value for it. */
  databaseFilled: boolean
}

/** The table's columns, read from the catalog, or null when it has none to read. */
async function loadColumns(projectId: string, schema: string, table: string): Promise<Column[] | null> {
  const db = await workspaceRawClient(projectId)
  const rows = await db.$queryRawUnsafe<Array<{
    name: string; type_name: string; category: string; type_oid: number | bigint
    max_length: number | null; not_null: boolean; has_default: boolean; database_filled: boolean
  }>>(
    `SELECT a.attname AS name, t.typname AS type_name, t.typcategory AS category, a.atttypid::bigint AS type_oid,
            CASE WHEN t.typcategory = 'S' AND a.atttypmod > 4 THEN a.atttypmod - 4 END AS max_length,
            a.attnotnull AS not_null, a.atthasdef AS has_default,
            (a.attidentity <> '' OR a.attgenerated <> '') AS database_filled
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    schema,
    table,
  )
  if (!rows.length) return null
  return rows.map((r) => ({
    name: r.name,
    typeName: r.type_name,
    category: r.category,
    typeOid: Number(r.type_oid),
    maxLength: r.max_length === null ? null : Number(r.max_length),
    notNull: r.not_null,
    hasDefault: r.has_default,
    databaseFilled: r.database_filled,
  }))
}

/** The table's primary-key columns, to find the inserted row again. */
async function primaryKey(projectId: string, schema: string, table: string): Promise<string[]> {
  const db = await workspaceRawClient(projectId)
  const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass AND i.indisprimary`,
    schema,
    table,
  )
  return rows.map((r) => r.name)
}

async function firstEnumLabel(projectId: string, typeOid: number): Promise<string | undefined> {
  const db = await workspaceRawClient(projectId)
  const rows = await db.$queryRawUnsafe<Array<{ label: string }>>(
    `SELECT enumlabel AS label FROM pg_enum WHERE enumtypid = $1::bigint::oid ORDER BY enumsortorder LIMIT 1`,
    typeOid,
  )
  return rows[0]?.label
}

/**
 * A value of the column's type. Text is unique to this run, so a UNIQUE column
 * does not refuse it because an earlier test left the same value.
 */
async function sampleValue(projectId: string, col: Column, tag: string): Promise<unknown> {
  const type = col.typeName
  if (col.category === 'E') return firstEnumLabel(projectId, col.typeOid)
  if (col.category === 'B') return true
  if (col.category === 'N') return 1
  if (col.category === 'A') return []
  if (type === 'uuid') return crypto.randomUUID()
  if (type === 'json' || type === 'jsonb') return {}
  if (type === 'date') return new Date().toISOString().slice(0, 10)
  if (type === 'time' || type === 'timetz') return '12:00:00'
  if (type === 'interval') return '1 hour'
  if (col.category === 'D') return new Date().toISOString()
  if (type === 'inet' || type === 'cidr') return '127.0.0.1'
  if (type === 'macaddr') return '08:00:2b:01:02:03'
  if (type === 'bytea') return '\\x00'
  if (type === 'tsvector') return 'brain'
  const name = col.name.toLowerCase()
  const text = name.includes('email')
    ? `verify-${tag}@brain.local`
    : name.includes('url')
      ? `https://example.com/${tag}`
      : `brain-verify-${col.name}-${tag}`
  return col.maxLength ? text.slice(0, col.maxLength) : text
}

/**
 * The column a table's row-level security reads as its owner, for a row the
 * test user must own. A party_rows table needs the user in one party column:
 * filling them all with the same user could break a CHECK that the parties
 * differ, and the other required ones are filled like any reference to users.
 */
function ownerColumns(plan: RlsPlan): string[] {
  if (plan.kind === 'own_rows') return [plan.userIdColumn]
  if (plan.kind === 'party_rows') return plan.partyColumns.slice(0, 1)
  return []
}

/** Tables whose rows belong to end users: a signed-in user must be able to create their own. */
const USER_OWNED = new Set<RlsPlan['kind']>(['own_rows', 'party_rows', 'related_rows'])

async function planOf(projectId: string, schema: string, table: string): Promise<RlsPlan> {
  return inferRlsPlan(projectId, table, schema).catch(
    (): RlsPlan => ({ kind: 'undecidable', template: null, basis: 'undecidable', reason: 'not read', relatedTables: [] }),
  )
}

/** INSERT … SELECT from a JSON object, the way PostgREST inserts, so every value takes its column's type. */
function insertSql(schema: string, table: string, columns: string[]): string {
  const target = `"${schema}"."${table}"`
  if (!columns.length) return `INSERT INTO ${target} DEFAULT VALUES RETURNING *`
  const list = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')
  return `INSERT INTO ${target} (${list}) SELECT ${list} FROM json_populate_record(NULL::${target}, $1::json) RETURNING *`
}

/** A row the test inserted itself, removed afterwards as the service role. */
interface Inserted {
  table: string
  key: Record<string, unknown>
}

type Built =
  | { row: Record<string, unknown>; parents: Inserted[] }
  | { cannot: string; parents: Inserted[] }

/**
 * The row to send. With no test user (a project without sign-up) it is only
 * the required columns: the anon key cannot write, so nothing else matters.
 */
async function buildRow(target: CreateTestTarget, columns: Column[], userId: string | null, tag: string): Promise<Built> {
  const { projectId, schema, tableName } = target
  const [checks, references, plan] = await Promise.all([
    loadCheckConstraintValues(projectId, schema, tableName),
    loadFkColumnMappings(projectId, schema, tableName),
    planOf(projectId, schema, tableName),
  ])
  const owners = new Set(ownerColumns(plan))
  // A related_rows table is owned through its parent, so the reference must
  // name a parent the test user owns even when the column itself is nullable.
  const ownedThrough = plan.kind === 'related_rows' ? plan.via.localColumn : null

  const row: Record<string, unknown> = {}
  const parents: Inserted[] = []
  for (const col of columns) {
    if (col.databaseFilled) continue
    const required = col.notNull && !col.hasDefault
    if (owners.has(col.name)) {
      if (userId) row[col.name] = userId
      continue
    }
    const reference = references.find((r) => r.column === col.name)
    if (reference && userId && (required || col.name === ownedThrough)) {
      if (reference.foreignTable === USERS_TABLE) {
        row[col.name] = userId
        continue
      }
      if (reference.foreignTable === tableName || reference.foreignColumn !== 'id') {
        return {
          cannot:
            `"${col.name}" must reference ${reference.foreignTable === tableName ? 'another row of this table' : `"${reference.foreignTable}"."${reference.foreignColumn}"`}, ` +
            'which the test does not create',
          parents,
        }
      }
      const parent = await insertParent(target, reference.foreignTable, userId, tag)
      if ('cannot' in parent) return { cannot: parent.cannot, parents }
      parents.push(parent)
      row[col.name] = parent.key.id
      continue
    }
    if (!required) continue
    row[col.name] = checks[col.name] ?? (await sampleValue(projectId, col, tag))
  }
  return { row, parents }
}

/**
 * One parent row for a required reference, owned by the test user, inserted as
 * the service role. One level only: a parent that needs a parent of its own is
 * not built.
 */
async function insertParent(
  target: CreateTestTarget,
  parentTable: string,
  userId: string,
  tag: string,
): Promise<Inserted | { cannot: string }> {
  const { projectId, schema } = target
  const columns = await loadColumns(projectId, schema, parentTable)
  if (!columns) return { cannot: `the table it references, "${parentTable}", could not be read` }
  const [checks, references, plan] = await Promise.all([
    loadCheckConstraintValues(projectId, schema, parentTable),
    loadFkColumnMappings(projectId, schema, parentTable),
    planOf(projectId, schema, parentTable),
  ])
  const owners = new Set(ownerColumns(plan))
  const row: Record<string, unknown> = {}
  for (const col of columns) {
    if (col.databaseFilled) continue
    const required = col.notNull && !col.hasDefault
    const reference = references.find((r) => r.column === col.name)
    if (owners.has(col.name) || (required && reference?.foreignTable === USERS_TABLE)) {
      row[col.name] = userId
    } else if (required && reference) {
      return { cannot: `its parent "${parentTable}" needs a row in "${reference.foreignTable}" first, and the test builds one level only` }
    } else if (required) {
      row[col.name] = checks[col.name] ?? (await sampleValue(projectId, col, tag))
    }
  }
  try {
    const keys = Object.keys(row)
    const [inserted] = await executeWithUserContext<Record<string, unknown>>(
      projectId, userId, true, insertSql(schema, parentTable, keys), keys.length ? [JSON.stringify(row)] : [],
    )
    if (inserted?.id === undefined) return { cannot: `the row it added to "${parentTable}" has no id to reference` }
    return { table: parentTable, key: { id: inserted.id } }
  } catch (err) {
    return { cannot: `a row could not be added to "${parentTable}": ${databaseMessage(err)}` }
  }
}

/** The database's own words from a failed raw query, without Prisma's wrapping. */
function databaseMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  const quoted = text.match(/Message: `([\s\S]*?)`/)
  return (quoted ? quoted[1] : text).replace(/^ERROR:\s*/, '').trim().slice(0, 300)
}

/**
 * Insert the row again, as the service role so row-level security is not the
 * reason, in a transaction that is always rolled back. Returns what the
 * database said, or null when the insert succeeds there.
 */
async function replayInsert(target: CreateTestTarget, row: Record<string, unknown>, userId: string | null): Promise<string | null> {
  const db = await workspaceRawClient(target.projectId)
  const rollBack = new Error('rolled back on purpose')
  const keys = Object.keys(row)
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(rlsSessionSql(), ...rlsSessionParams({ userId: userId ?? '', isServiceRole: true, userRole: 'user' }))
      await tx.$queryRawUnsafe(insertSql(target.schema, target.tableName, keys), ...(keys.length ? [JSON.stringify(row)] : []))
      throw rollBack
    })
  } catch (err) {
    return err === rollBack ? null : databaseMessage(err)
  }
  return null
}

/** Remove what the test inserted, children before parents, as the service role. */
async function removeInserted(projectId: string, schema: string, rows: Inserted[], userId: string | null): Promise<string[]> {
  const left: string[] = []
  for (const r of [...rows].reverse()) {
    const columns = Object.keys(r.key)
    const where = columns.map((c, i) => `"${c.replace(/"/g, '""')}"::text = $${i + 1}`).join(' AND ')
    try {
      const deleted = await executeWithUserContext<Record<string, unknown>>(
        projectId, userId ?? '', true,
        `DELETE FROM "${schema}"."${r.table}" WHERE ${where} RETURNING 1 AS gone`,
        columns.map((c) => String(r.key[c])),
      )
      if (!deleted.length) left.push(r.table)
    } catch {
      left.push(r.table)
    }
  }
  return left
}

type Signup =
  | { kind: 'user'; userId: string; token: string; email: string }
  | { kind: 'no_auth' }
  | { kind: 'failed'; detail: string }

async function signUpTestUser(target: CreateTestTarget, tag: string): Promise<Signup> {
  const email = `__http_bv_${Date.now()}_${tag}@backenly.internal`
  const path = `/api/v1/${target.projectId}/auth/signup`
  let res: Response
  try {
    res = await fetch(`${target.appUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalTrafficHeaders() },
      body: JSON.stringify({ email, password: `${crypto.randomBytes(12).toString('hex')}Aa1!`, name: '__bv_http_test__' }),
      signal: AbortSignal.timeout(target.timeoutMs),
    })
  } catch (err) {
    return { kind: 'failed', detail: `POST ${path} did not answer (${err instanceof Error ? err.message : 'unknown'})` }
  }
  const text = await res.text().catch(() => '')
  // A reserved address never sets end-user auth up: a project without it says so.
  if (res.status === 503 && text.includes('AUTH_NOT_CONFIGURED')) return { kind: 'no_auth' }
  if (!res.ok) return { kind: 'failed', detail: `POST ${path} → ${res.status} ${text.slice(0, 160)}` }
  let body: any = {}
  try { body = JSON.parse(text) } catch { /* judged below */ }
  const data = body?.data ?? body
  const token = data?.token ?? data?.accessToken ?? body?.token
  const userId = data?.user?.id ?? body?.user?.id
  if (typeof token !== 'string' || userId === undefined) {
    return { kind: 'failed', detail: `POST ${path} → ${res.status} without a token and user id` }
  }
  return { kind: 'user', userId: String(userId), token, email }
}

/**
 * A 403 for a signed-in user. The runtime maps every privilege error to the
 * same FORBIDDEN, so the catalog says which this is: no grant (broken), a
 * table of users' own rows refusing a row its user owns (broken), or a table
 * only the service role writes (refused by design: not a failure, though the
 * insert path was not exercised).
 */
async function refusalVerdict(
  target: CreateTestTarget,
  head: string,
): Promise<Pick<EndpointTestResult, 'ok' | 'summary' | 'failureKind'>> {
  const { projectId, schema, tableName } = target
  const db = await workspaceRawClient(projectId)
  const granted = await db
    .$queryRawUnsafe<Array<{ granted: boolean }>>(
      `SELECT has_table_privilege('authenticated', quote_ident($1) || '.' || quote_ident($2), 'INSERT') AS granted`,
      schema,
      tableName,
    )
    .then((rows) => rows[0]?.granted ?? null)
    .catch(() => null)
  if (granted === false) {
    return {
      ok: false,
      summary:
        `${head}: the database role signed-in users act as (authenticated) has no INSERT grant on "${tableName}", ` +
        'so no signed-in user can create a row.',
      failureKind: 'forbidden',
    }
  }
  const plan = await planOf(projectId, schema, tableName)
  if (USER_OWNED.has(plan.kind)) {
    return {
      ok: false,
      summary:
        `${head}: row-level security refused a row owned by the signed-in test user. "${tableName}" holds ` +
        `each user's own rows (${plan.kind}), so its policy must let a signed-in user create one, and it does not.`,
      failureKind: 'forbidden',
    }
  }
  return {
    ok: true,
    summary:
      `${head}: signed-in users may not insert into "${tableName}". Its rows belong to no end user and only ` +
      'the service role writes it, which is by design, so nothing is wrong; the insert path itself was not exercised.',
  }
}

/**
 * Insert one real row through the table's endpoint and remove it again. Null
 * when the table's columns cannot be read, so the caller falls back.
 */
export async function verifyCreate(target: CreateTestTarget): Promise<EndpointTestResult | null> {
  const { projectId, schema, tableName } = target
  const path = `/api/v1/${projectId}/db/${encodeURIComponent(tableName)}`
  const method = 'POST'
  const tag = crypto.randomBytes(4).toString('hex')
  const result = (r: Omit<EndpointTestResult, 'endpoint' | 'method'>): EndpointTestResult => ({ endpoint: path, method, ...r })

  // Read before anyone signs up: a table whose columns cannot be read is not
  // tested here at all.
  const columns = await loadColumns(projectId, schema, tableName).catch(() => null)
  if (!columns) return null

  const signup = await signUpTestUser(target, tag)
  if (signup.kind === 'failed') {
    return result({
      ok: false,
      summary: `Could not sign a test user up, so no row was written and nothing was verified: ${signup.detail}.`,
      statusCode: null,
      bodyExcerpt: '',
      failureKind: 'unauthenticated',
    })
  }
  const userId = signup.kind === 'user' ? signup.userId : null
  const inserted: Inserted[] = []
  let leftBehind: string[] = []
  try {
    const built = await buildRow(target, columns, userId, tag)
    inserted.push(...built.parents)
    if ('cannot' in built) {
      return result({
        ok: false,
        summary: `No valid row could be built for "${tableName}": ${built.cannot}. Nothing was inserted, so the insert path was not exercised.`,
        statusCode: null,
        bodyExcerpt: '',
        failureKind: 'no_valid_row',
      })
    }

    let res: Response
    try {
      res = await fetch(`${target.appUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-api-key': target.anonKey,
          ...(signup.kind === 'user' ? { 'x-user-token': signup.token } : {}),
          ...internalTrafficHeaders(),
        },
        body: JSON.stringify(built.row),
        signal: AbortSignal.timeout(target.timeoutMs),
      })
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      return result({
        ok: false,
        summary: timedOut
          ? `${method} ${path} did not answer within ${target.timeoutMs / 1000}s, so nothing was verified.`
          : `Fetch to ${path} failed: ${err instanceof Error ? err.message : 'unknown'}`,
        statusCode: null,
        bodyExcerpt: '',
        failureKind: timedOut ? 'timeout' : 'fetch_failed',
      })
    }
    const status = res.status
    const text = await res.text().catch(() => '')
    const excerpt = text.length > 320 ? `${text.slice(0, 320)}…` : text
    let body: any = null
    try { body = JSON.parse(text) } catch { /* not JSON */ }
    const head = `${method} ${path} → ${status}`
    const as = signup.kind === 'user' ? 'as a signed-in test user' : 'with the anon key alone'

    if (status === 200 || status === 201) {
      // Removed here rather than in `finally`, so the summary says what happened to it.
      const created = Array.isArray(body?.data) ? body.data[0] : body?.data
      const keyColumns = await primaryKey(projectId, schema, tableName).catch(() => [] as string[])
      const found = Boolean(created) && keyColumns.length > 0 && keyColumns.every((c) => created[c] !== undefined)
      if (found) inserted.push({ table: tableName, key: Object.fromEntries(keyColumns.map((c) => [c, created[c]])) })
      const notRemoved = found ? await removeInserted(projectId, schema, inserted.splice(0), userId) : [tableName]
      leftBehind = notRemoved
      return result({
        ok: true,
        summary:
          `${head}: a row was inserted ${as}, so the insert path works. ` +
          (notRemoved.length
            ? `Test rows could not be removed afterwards from ${notRemoved.map((t) => `"${t}"`).join(', ')}; delete them by hand.`
            : 'The test row was removed again.') +
          (signup.kind === 'no_auth' ? ' The anon key alone could write it: anyone holding the key can.' : ''),
        statusCode: status,
        bodyExcerpt: excerpt,
      })
    }

    if (status === 401 || status === 403) {
      // Without sign-up there was no one allowed to write as: the one refusal
      // that is a pass, and it proves less than an insert would.
      if (signup.kind === 'no_auth') {
        return result({
          ok: true,
          summary:
            `${head}: refused, as it must be without a signed-in user. This project has no end-user sign-up, so ` +
            'there was no one to write as, and the insert path itself was not exercised.',
          statusCode: status,
          bodyExcerpt: excerpt,
        })
      }
      if (status === 403 && body?.code === 'FORBIDDEN') {
        return result({ ...(await refusalVerdict(target, head)), statusCode: status, bodyExcerpt: excerpt })
      }
      return result({
        ok: false,
        summary: `${head}: the request was refused ${as} (${body?.code ?? 'no code'}: ${body?.error ?? excerpt.slice(0, 120)}), so nothing was verified.`,
        statusCode: status,
        bodyExcerpt: excerpt,
        failureKind: status === 401 ? 'unauthenticated' : 'forbidden',
      })
    }

    if (status === 404) {
      return result({
        ok: false,
        summary: `${head}. The endpoint is not routed — generate_api may not have run, or the table name is wrong.`,
        statusCode: status,
        bodyExcerpt: excerpt,
        failureKind: 'not_found',
      })
    }

    // The runtime keeps the database's words only for some constraint errors,
    // so ask the database directly what is wrong with this insert.
    const reason = await replayInsert(target, built.row, userId)
    return result({
      ok: false,
      summary: reason
        ? `${head}: the insert failed. The database says: ${reason}`
        : `${head}: the insert failed in the runtime, though the same row inserts in the database. Body: ${excerpt.slice(0, 160)}`,
      statusCode: status,
      bodyExcerpt: excerpt,
      failureKind: status >= 500 ? 'server_error' : 'bad_request',
    })
  } finally {
    leftBehind = [...leftBehind, ...(await removeInserted(projectId, schema, inserted, userId))]
    if (signup.kind === 'user') {
      await purgeSyntheticAuthArtifacts(projectId, { email: signup.email }).catch(() => {})
    }
    if (leftBehind.length) {
      console.error(`[run_test] create left a test row behind in ${leftBehind.join(', ')} (project ${projectId})`)
    }
  }
}
