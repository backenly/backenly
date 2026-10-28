/**
 * WHO RUNS EACH STATEMENT, AND WHAT EVERY OTHER IDENTITY CAN DO WITH IT
 * =====================================================================
 * The identities production has, created here as NOSUPERUSER roles with the
 * grants production's own scripts give them, and the ladder run by the
 * production renderers over a connection that LOGS IN as the application role,
 * as production's does (no superuser anywhere on the path under test):
 *
 *   platform           the application role (scripts/setup-app-role.ts):
 *                      NOSUPERUSER NOBYPASSRLS. Runs every statement of the
 *                      ladder (catalog reads, the rehearsal, every rung, the
 *                      backfill, reconciliation, undo); the forward sync runs as
 *                      it (SECURITY DEFINER). It is also who the runtime serves
 *                      end users as, claims set.
 *   PostgREST          anon / authenticated / service_role, reached through a
 *                      NOINHERIT authenticator login, holding the table grants
 *                      and the EXECUTE on every function that
 *                      scripts/setup-postgrest-roles.ts gives them
 *   MCP and direct     bkn_ro_<hex>, SELECT only, its own login
 *   read-only          (lib/mcp/read-query.ts connects as it)
 *   direct read-write  bkn_rw_<hex>, a member of bkn_own_<hex>, which owns the
 *                      schema and every table in it once main's
 *                      backenly_direct_sync_schema has run — the satellite
 *                      included, mid-ladder, as drift-watch and the MCP read
 *                      path run it
 *   backup             BYPASSRLS, SELECT only
 *
 * For each it proves: what it reads and may write through the new table is what
 * it reads and may write through its parent, with or without the ladder's own
 * settings forged; no identity is a member of the platform role, so none
 * inherits the ladder's own policies; no ladder function can be called,
 * attached to another table or replaced; nothing a project role creates in the
 * schema runs as the platform inside a ladder function; a write reaches the
 * host exactly once whoever owns the satellite; the rehearsal includes the
 * platform's own identity when the host belongs to the project's owner role;
 * another project's tables are out of reach; and undo still works.
 *
 * Earlier regressions it pins:
 *   - The reverse sync recognised the forward sync's own writes by the
 *     satellite's OWNER. Main's direct-access sync hands the satellite to
 *     bkn_own_<hex>, the guard stopped matching, and every host write was
 *     applied twice (the customer's own triggers fired twice).
 *   - The ladder's functions ran with the workspace schema on their search
 *     path. A READ_WRITE role may create objects there, and an operator it
 *     created ran inside the SECURITY DEFINER forward sync, as the platform.
 *   - The rehearsal left out the platform identity unless the platform owned
 *     the host, which a direct-access project's host never is.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { PrismaClient } from '@prisma/client'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { rlsSessionParams, rlsSessionSql, type RlsIdentity } from '@/lib/services/rls-session'
import { granteesWith, readTableFacts } from '@/lib/structural-evolution/facts'
import { reconcileWith } from '@/lib/structural-evolution/reconcile'
import { rehearseExtraction } from '@/lib/structural-evolution/rehearse'
import { workspaceOn } from '@/lib/structural-evolution/workspace'
import {
  backfillBatchSql,
  carriedObjects,
  closeWritesSql,
  createSatelliteSql,
  dropForwardSyncSql,
  dropSatelliteSql,
  exposeReadsSql,
  forwardSyncSql,
  ladderAccessSql,
  ladderNames,
  openWritesSql,
  revokeReadsSql,
  type ExtractionSpec,
} from '@/lib/structural-evolution/sql'

jest.setTimeout(180_000)

const CONN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
const hex = randomBytes(6).toString('hex')
const PW = randomBytes(16).toString('hex')
const A = `workspace_${randomUUID()}`
const B = `workspace_${randomUUID()}`
const R = {
  platform: `bkn_evo_app_${hex}`,
  anon: `bkn_evo_anon_${hex}`,
  authenticated: `bkn_evo_auth_${hex}`,
  service: `bkn_evo_svc_${hex}`,
  authenticator: `bkn_evo_authn_${hex}`,
  ro: `bkn_ro_${hex}`,
  rw: `bkn_rw_${hex}`,
  own: `bkn_own_${hex}`,
  backup: `bkn_evo_bk_${hex}`,
}
const TRIO = [R.anon, R.authenticated, R.service]
const SPEC: ExtractionSpec = { host: 'orders', members: ['refund_amount', 'refund_reason'], satellite: 'order_refunds', label: 'refund' }
const N = ladderNames(SPEC)
const U1 = randomUUID()
const U2 = randomUUID()
const ANON: RlsIdentity = { userId: '' }
const SERVICE: RlsIdentity = { userId: '', isServiceRole: true, userRole: 'service' }
const user = (id: string): RlsIdentity => ({ userId: id })
const t = (schema: string, n: string) => `"${schema}"."${n}"`
const a = (n: string) => t(A, n)

let admin: Client
let appDb: PrismaClient
/** Logins kept open for the whole suite, as a pool would keep them. */
const logins: Client[] = []
const q = async <T = any>(sql: string, p: unknown[] = []): Promise<T[]> => (await admin.query(sql, p)).rows

function urlAs(role: string): string {
  const u = new URL(CONN)
  u.username = role
  u.password = PW
  return u.toString()
}
async function login(role: string): Promise<Client> {
  const c = new Client({ connectionString: urlAs(role) })
  await c.connect()
  logins.push(c)
  return c
}

/** The platform's own connection: a transaction with claims, optionally in the ladder's context. */
async function asPlatform<T = any>(claims: RlsIdentity, sql: string | string[], opts: { ladder?: boolean; params?: unknown[] } = {}): Promise<T[]> {
  return appDb.$transaction(async tx => {
    await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams(claims))
    if (opts.ladder) await tx.$executeRawUnsafe(ladderAccessSql(SPEC))
    let last: any[] = []
    for (const s of Array.isArray(sql) ? sql : [sql]) last = await tx.$queryRawUnsafe<any[]>(s, ...(opts.params ?? []))
    return last
  })
}

/** What production's direct-access sync does for this project, as drift-watch and the MCP read path run it. */
async function directAccessSync(): Promise<void> {
  await q(`SET backenly.app_role = '${R.platform}'`)
  await q(`SET backenly.backup_role = '${R.backup}'`)
  await q(`SELECT public.backenly_direct_sync_schema($1, $2, $3, $4)`, [A, R.ro, R.rw, R.own])
}

/** What scripts/setup-postgrest-roles.ts grants on a served schema, re-run by an operator at any time. */
async function postgrestGrants(schema: string): Promise<void> {
  await q(`GRANT USAGE ON SCHEMA "${schema}" TO ${TRIO.join(', ')}`)
  await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${R.authenticated}, ${R.service}`)
  await q(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO ${R.anon}`)
  await q(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${R.authenticated}, ${R.service}`)
  await q(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "${schema}" TO ${TRIO.join(', ')}`)
}

const facts = async () => (await readTableFacts(workspaceOn(appDb, A), SPEC.host))!

function ordersSql(schema: string): string[] {
  const svc = `${t(schema, 'backenly_jwt_claim')}('role') = 'service_role'`
  const sub = `${t(schema, 'backenly_jwt_claim')}('sub')`
  const own = `(${svc} OR user_id::text = ${sub})`
  return [
    jwtClaimFunctionSql(schema),
    `CREATE TABLE ${t(schema, 'orders')} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL,
       shared boolean NOT NULL DEFAULT false,
       total numeric NOT NULL,
       refund_amount numeric,
       refund_reason text,
       version int NOT NULL DEFAULT 0
     )`,
    `CREATE TABLE ${t(schema, 'orders_audit')} (id bigserial PRIMARY KEY, order_id uuid, who text)`,
    `CREATE FUNCTION ${t(schema, 'bump')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.version := OLD.version + 1; RETURN NEW; END $$`,
    `CREATE FUNCTION ${t(schema, 'audit')}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN INSERT INTO ${t(schema, 'orders_audit')} (order_id, who) VALUES (NEW.id, current_user); RETURN NULL; END $$`,
    `CREATE TRIGGER bump BEFORE UPDATE ON ${t(schema, 'orders')} FOR EACH ROW EXECUTE FUNCTION ${t(schema, 'bump')}()`,
    `CREATE TRIGGER audit AFTER UPDATE ON ${t(schema, 'orders')} FOR EACH ROW EXECUTE FUNCTION ${t(schema, 'audit')}()`,
    `INSERT INTO ${t(schema, 'orders')} (user_id, shared, total, refund_amount, refund_reason)
     SELECT CASE WHEN i % 2 = 0 THEN '${U1}'::uuid ELSE '${U2}'::uuid END, i % 4 = 0, i,
            CASE WHEN i % 3 <> 0 THEN i END, CASE WHEN i % 3 = 1 THEN 'late' END
       FROM generate_series(1, 24) i`,
    `ALTER TABLE ${t(schema, 'orders')} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${t(schema, 'orders')} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY orders_read ON ${t(schema, 'orders')} FOR SELECT USING (${svc} OR user_id::text = ${sub} OR shared)`,
    `CREATE POLICY orders_ins ON ${t(schema, 'orders')} FOR INSERT WITH CHECK ${own}`,
    `CREATE POLICY orders_upd ON ${t(schema, 'orders')} FOR UPDATE USING ${own} WITH CHECK ${own}`,
    `CREATE POLICY orders_del ON ${t(schema, 'orders')} FOR DELETE USING ${own}`,
  ]
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  // Production's direct-access functions, as an install runs them (idempotent).
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', 'scripts/setup-direct-access.sql', '-d', CONN], { stdio: 'pipe' })
  admin = new Client({ connectionString: CONN })
  await admin.connect()
  const [{ db }] = await q<{ db: string }>(`SELECT current_database() AS db`)

  await q(`CREATE ROLE ${R.platform} LOGIN PASSWORD '${PW}' NOSUPERUSER NOBYPASSRLS`)
  // The application creates schemas, and the rehearsal its scratch schema.
  await q(`GRANT CREATE ON DATABASE "${db}" TO ${R.platform}`)
  for (const r of TRIO) await q(`CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  await q(`CREATE ROLE ${R.authenticator} LOGIN NOINHERIT PASSWORD '${PW}' NOSUPERUSER NOBYPASSRLS`)
  for (const r of TRIO) await q(`GRANT ${r} TO ${R.authenticator}`)
  await q(`CREATE ROLE ${R.backup} LOGIN PASSWORD '${PW}' NOSUPERUSER BYPASSRLS`)

  for (const schema of [A, B]) await q(`CREATE SCHEMA "${schema}" AUTHORIZATION ${R.platform}`)
  appDb = new PrismaClient({ datasources: { db: { url: urlAs(R.platform) } } })
  await asPlatform(SERVICE, ordersSql(A))
  await asPlatform(SERVICE, ordersSql(B))
  await postgrestGrants(A)

  // READ_ONLY and READ_WRITE direct access, by production's own functions.
  await q(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_ONLY')`, [R.ro, PW, A])
  await q(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_WRITE')`, [R.rw, PW, A])
  await directAccessSync()
}, 180_000)

afterAll(async () => {
  await appDb?.$disconnect()
  for (const c of logins) await c.end().catch(() => {})
  await q(`RESET backenly.app_role`).catch(() => {})
  await q(`RESET backenly.backup_role`).catch(() => {})
  for (const schema of [A, B]) await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  for (const r of [R.rw, R.ro, R.own, R.authenticator, ...TRIO, R.backup, R.platform]) {
    await q(`DROP OWNED BY ${r}`).catch(() => {})
    await q(`DROP ROLE IF EXISTS ${r}`).catch(() => {})
  }
  await admin?.end()
}, 120_000)

// ── Identities ────────────────────────────────────────────────────────────────

interface Identity {
  label: string
  client: () => Promise<Client>
  /** The role a NOINHERIT login switches into, as PostgREST does. */
  role?: string
  claims: RlsIdentity | null
  /** May forge the ladder's own settings without that being the trust boundary itself. */
  forgeable: boolean
}

let platformLogin: Client
let authenticatorLogin: Client
let roLogin: Client
let rwLogin: Client
let backupLogin: Client

const IDENTITIES = (): Identity[] => [
  { label: 'runtime, anonymous', client: async () => platformLogin, claims: ANON, forgeable: false },
  { label: 'runtime, signed in', client: async () => platformLogin, claims: user(U1), forgeable: false },
  { label: 'runtime, service role', client: async () => platformLogin, claims: SERVICE, forgeable: false },
  { label: 'PostgREST anon', client: async () => authenticatorLogin, role: R.anon, claims: ANON, forgeable: true },
  { label: 'PostgREST authenticated (U1)', client: async () => authenticatorLogin, role: R.authenticated, claims: user(U1), forgeable: true },
  { label: 'PostgREST authenticated (U2)', client: async () => authenticatorLogin, role: R.authenticated, claims: user(U2), forgeable: true },
  { label: 'PostgREST service_role', client: async () => authenticatorLogin, role: R.service, claims: SERVICE, forgeable: true },
  { label: 'MCP / direct read-only', client: async () => roLogin, claims: null, forgeable: true },
  { label: 'direct read-only, claiming service', client: async () => roLogin, claims: SERVICE, forgeable: true },
  { label: 'direct read-write', client: async () => rwLogin, claims: null, forgeable: true },
  { label: 'direct read-write, claiming service', client: async () => rwLogin, claims: SERVICE, forgeable: true },
  { label: 'backup', client: async () => backupLogin, claims: null, forgeable: true },
]

type Q = <T = any>(sql: string, p?: unknown[]) => Promise<T[]>

/** One transaction as the identity, always rolled back. */
async function asIdentity<T>(who: Identity, fn: (q: Q) => Promise<T>, forged = false): Promise<T> {
  const c = await who.client()
  await c.query('BEGIN')
  try {
    if (who.role) await c.query(`SET LOCAL ROLE ${who.role}`)
    if (who.claims) await c.query(rlsSessionSql(1), rlsSessionParams(who.claims))
    if (forged) {
      // Every setting the ladder reads, as any session may set them.
      await c.query(`SELECT set_config($1, 'on', true), set_config($2, '1', true)`, [N.access, N.guc])
    }
    return await fn(async (sql, p = []) => (await c.query(sql, p)).rows)
  } finally {
    await c.query('ROLLBACK').catch(() => {})
  }
}

/** Rows a statement returns, in a savepoint, or that it was refused. */
async function rowsOrRefused(q: Q, sql: string): Promise<string[] | 'refused'> {
  await q('SAVEPOINT probe')
  try {
    const rows = await q<{ v: string }>(sql)
    await q('RELEASE SAVEPOINT probe')
    return rows.map(r => r.v)
  } catch {
    await q('ROLLBACK TO SAVEPOINT probe')
    return 'refused'
  }
}

/**
 * A write in a savepoint, always undone: did it change a row? A parent's update
 * policy filters a row out silently, and the reverse sync raises 42501 for the
 * same answer (sql.ts); both are "not allowed".
 */
async function allowed(q: Q, sql: string, p: unknown[]): Promise<boolean> {
  await q('SAVEPOINT probe')
  try {
    const rows = await q<{ n: number }>(`WITH w AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM w`, p)
    return rows[0].n > 0
  } catch {
    return false
  } finally {
    await q('ROLLBACK TO SAVEPOINT probe')
  }
}

/** What the identity reads and may write, through the host and through the satellite. */
async function accessOf(who: Identity, forged: boolean, keys: string[]) {
  return asIdentity(
    who,
    async q => {
      const host = await rowsOrRefused(
        q,
        `SELECT id::text || ':' || ROW(refund_amount, refund_reason)::text AS v FROM ${a('orders')}
          WHERE refund_amount IS NOT NULL OR refund_reason IS NOT NULL ORDER BY 1`,
      )
      const sat = await rowsOrRefused(
        q,
        `SELECT ${N.fkColumn}::text || ':' || ROW(refund_amount, refund_reason)::text AS v FROM ${a('order_refunds')} ORDER BY 1`,
      )
      const writes: Array<{ key: string; host: boolean; satellite: boolean }> = []
      for (const key of keys) {
        writes.push({
          key,
          host: await allowed(q, `UPDATE ${a('orders')} SET refund_reason = 'probe' WHERE id = $1`, [key]),
          satellite: await allowed(q, `UPDATE ${a('order_refunds')} SET refund_reason = 'probe' WHERE ${N.fkColumn} = $1`, [key]),
        })
      }
      return { host, sat, writes }
    },
    forged,
  )
}

// ── The ladder, as the platform's own login ──────────────────────────────────

let rehearsal: Awaited<ReturnType<typeof rehearseExtraction>>

describe('the ladder, run as the platform role alone', () => {
  it('starts with the host owned by the project\'s owner role, the platform a member', async () => {
    expect((await q(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = $1::regclass`, [a('orders')]))[0].o).toBe(R.own)
    expect((await q(`SELECT pg_has_role($1, $2, 'MEMBER') AS m`, [R.platform, R.own]))[0].m).toBe(true)
  })

  it('tells a key the sync can compare with built-ins from one it cannot, which is not planned', async () => {
    await asPlatform(SERVICE, [
      `CREATE DOMAIN ${t(B, 'order_key')} AS uuid`,
      `CREATE TYPE ${t(B, 'tier')} AS ENUM ('gold', 'silver')`,
      `CREATE TYPE ${t(B, 'pair')} AS (a int, b int)`,
      `CREATE TABLE ${t(B, 'by_domain')} (id ${t(B, 'order_key')} PRIMARY KEY)`,
      `CREATE TABLE ${t(B, 'by_enum')} (id ${t(B, 'tier')} PRIMARY KEY)`,
      `CREATE TABLE ${t(B, 'by_pair')} (id ${t(B, 'pair')} PRIMARY KEY)`,
    ])
    const keyOf = async (table: string) => (await readTableFacts(workspaceOn(appDb, B), table))!.columns[0].builtinType
    expect(await keyOf('orders')).toBe(true)
    expect(await keyOf('by_domain')).toBe(true)
    expect(await keyOf('by_enum')).toBe(true)
    expect(await keyOf('by_pair')).toBe(false)
  })

  it('rehearses the platform\'s own identity although it does not own the host', async () => {
    const f = await facts()
    rehearsal = await rehearseExtraction(workspaceOn(appDb, A), f, SPEC, `plan-${hex}`)
    expect(rehearsal.error).toBeNull()
    expect(rehearsal.passed).toBe(true)
    expect(rehearsal.authorization.status).toBe('passed')
    const identities = [...new Set(rehearsal.authorization.checks.map(c => c.identity))]
    expect(identities).toEqual(expect.arrayContaining([`${R.platform} as anonymous`, `${R.platform} claiming the service role`]))
    // Roles the platform cannot become are named, never silently skipped.
    expect(rehearsal.notRehearsed.join('\n')).toContain(R.anon)
  })

  it('runs every rung with nothing but its own privileges, the owner role taking the new table mid-ladder', async () => {
    const target = { schema: A }
    let f = await facts()
    await asPlatform(SERVICE, createSatelliteSql(f, SPEC, target, carriedObjects(f, SPEC, N, target), `plan-${hex}`))
    // Drift-watch, the MCP read path or a restore runs main's sync while the ladder is in place.
    await directAccessSync()
    expect((await q(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = $1::regclass`, [a('order_refunds')]))[0].o).toBe(R.own)
    f = await facts()
    await asPlatform(SERVICE, forwardSyncSql(f, SPEC, target))
    const [batch] = await asPlatform<{ scanned: bigint }>(SERVICE, backfillBatchSql(f, SPEC, target, 1000), { ladder: true, params: [null] })
    expect(Number(batch.scanned)).toBe(24)
    f = await facts()
    await asPlatform(SERVICE, exposeReadsSql(f, SPEC, target, granteesWith(f, 'SELECT')))
    const readers = granteesWith(f, 'SELECT')
    await asPlatform(SERVICE, openWritesSql(f, SPEC, target, granteesWith(f, 'UPDATE').filter(r => readers.includes(r))))
    // An operator re-running the PostgREST setup re-grants EXECUTE on every function.
    await postgrestGrants(A)

    platformLogin = await login(R.platform)
    authenticatorLogin = await login(R.authenticator)
    roLogin = await login(R.ro)
    rwLogin = await login(R.rw)
    backupLogin = await login(R.backup)
  })

  it('installs functions that resolve names in pg_catalog only, run as their owner, the forward sync alone as definer', async () => {
    const fns = await q<{ name: string; owner: string; definer: boolean; config: string[] | null }>(
      `SELECT p.proname::text AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config
         FROM pg_proc p WHERE p.pronamespace = $1::regnamespace AND p.proname LIKE 'bkn\\_evo\\_%' ORDER BY 1`,
      [`"${A}"`],
    )
    expect(fns.map(f => f.name).sort()).toEqual([N.forward, N.hostTruncate, N.reverse, N.truncateGuard].sort())
    for (const fn of fns) {
      expect(fn.owner).toBe(R.platform)
      expect(fn.config).toEqual(['search_path=pg_catalog, pg_temp'])
      expect(fn.definer).toBe(fn.name === N.forward)
    }
  })
})

// ── Every identity against the new table ─────────────────────────────────────

describe('every identity gets from the new table exactly what it gets from its parent', () => {
  let keys: string[] = []
  beforeAll(async () => {
    // A row of U1's, a shared row of U1's, and a row of U2's that is not shared, each carrying a refund.
    const rows = await q<{ id: string; user_id: string; shared: boolean }>(
      `SELECT id::text, user_id::text, shared FROM ${a('orders')} WHERE refund_amount IS NOT NULL ORDER BY total`,
    )
    keys = [
      rows.find(r => r.user_id === U1 && !r.shared)!.id,
      rows.find(r => r.user_id === U1 && r.shared)!.id,
      rows.find(r => r.user_id === U2 && !r.shared)!.id,
    ]
  })

  it.each(IDENTITIES().map(i => [i.label, i] as const))('%s', async (_label, who) => {
    for (const forged of who.forgeable ? [false, true] : [false]) {
      const seen = await accessOf(who, forged, keys)
      expect({ forged, rows: seen.sat }).toEqual({ forged, rows: seen.host })
      for (const w of seen.writes) expect({ forged, key: w.key, allowed: w.satellite }).toEqual({ forged, key: w.key, allowed: w.host })
    }
  })

  it('no identity is a member of the platform role, so none inherits the ladder\'s own policies', async () => {
    for (const r of [...TRIO, R.authenticator, R.ro, R.rw, R.own, R.backup]) {
      expect({ r, member: (await q(`SELECT pg_has_role($1, $2, 'MEMBER') AS m`, [r, R.platform]))[0].m }).toEqual({ r, member: false })
    }
  })
})

// ── The sync's own writes ────────────────────────────────────────────────────

describe('a write reaches the host exactly once, whoever owns the new table', () => {
  async function onceFor(key: string, write: () => Promise<unknown>) {
    const before = await q(`SELECT version, (SELECT count(*)::int FROM ${a('orders_audit')} WHERE order_id = $1) AS audits FROM ${a('orders')} WHERE id = $1`, [key])
    await write()
    const after = await q(`SELECT version, (SELECT count(*)::int FROM ${a('orders_audit')} WHERE order_id = $1) AS audits FROM ${a('orders')} WHERE id = $1`, [key])
    return { versions: after[0].version - before[0].version, audits: after[0].audits - before[0].audits }
  }
  const committed = async (c: Client, role: string | null, claims: RlsIdentity, sql: string) => {
    await c.query('BEGIN')
    try {
      if (role) await c.query(`SET LOCAL ROLE ${role}`)
      await c.query(rlsSessionSql(1), rlsSessionParams(claims))
      await c.query(sql)
      await c.query('COMMIT')
    } catch (err) {
      await c.query('ROLLBACK')
      throw err
    }
  }
  let mine: string[] = []
  beforeAll(async () => {
    mine = (await q(`SELECT id::text FROM ${a('orders')} WHERE user_id = $1 AND refund_amount IS NOT NULL ORDER BY total`, [U1])).map(r => r.id)
    expect(mine.length).toBeGreaterThanOrEqual(4)
  })

  it('through the runtime, to the host and through the new table', async () => {
    expect(await onceFor(mine[0], () => committed(platformLogin, null, user(U1), `UPDATE ${a('orders')} SET refund_amount = 101 WHERE id = '${mine[0]}'`))).toEqual({ versions: 1, audits: 1 })
    expect(await onceFor(mine[1], () => committed(platformLogin, null, user(U1), `UPDATE ${a('order_refunds')} SET refund_reason = 'through the new table' WHERE ${N.fkColumn} = '${mine[1]}'`))).toEqual({ versions: 1, audits: 1 })
  })

  it('through PostgREST, to the host and through the new table', async () => {
    expect(await onceFor(mine[2], () => committed(authenticatorLogin, R.authenticated, user(U1), `UPDATE ${a('orders')} SET refund_amount = 202 WHERE id = '${mine[2]}'`))).toEqual({ versions: 1, audits: 1 })
    expect(await onceFor(mine[3], () => committed(authenticatorLogin, R.authenticated, user(U1), `UPDATE ${a('order_refunds')} SET refund_amount = 303 WHERE ${N.fkColumn} = '${mine[3]}'`))).toEqual({ versions: 1, audits: 1 })
  })

  it('and leaves the two equal, by the platform\'s complete view', async () => {
    const f = await facts()
    const r = await appDb.$transaction(async tx => {
      await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams(SERVICE))
      await tx.$executeRawUnsafe(ladderAccessSql(SPEC))
      return reconcileWith(tx, f, SPEC, { schema: A })
    })
    expect(r).toMatchObject({ complete: true, consistent: true, missing: 0, orphaned: 0, mismatched: 0 })
  })
})

// ── What a project role can and cannot do with the ladder's functions ────────

describe('the ladder\'s functions', () => {
  it('cannot be called directly by anyone holding EXECUTE', async () => {
    const who = IDENTITIES().find(i => i.label === 'PostgREST authenticated (U1)')!
    for (const fn of [N.forward, N.reverse, N.hostTruncate, N.truncateGuard]) {
      await asIdentity(who, async q => {
        await expect(q(`SELECT ${a(fn)}()`)).rejects.toThrow(/trigger functions can only be called as triggers/)
      })
    }
  })

  it('refuse to mirror for any table but their host, even attached by a role that holds EXECUTE', async () => {
    const c = authenticatorLogin
    await c.query('BEGIN')
    try {
      await c.query(`SET LOCAL ROLE ${R.authenticated}`)
      await c.query(`CREATE TEMP TABLE decoy (id uuid PRIMARY KEY, refund_amount numeric, refund_reason text) ON COMMIT DROP`)
      await c.query(`CREATE TRIGGER decoy AFTER INSERT ON pg_temp.decoy FOR EACH ROW EXECUTE FUNCTION ${a(N.forward)}()`)
      await expect(c.query(`INSERT INTO pg_temp.decoy VALUES (gen_random_uuid(), 1, 'x')`)).rejects.toThrow(/fires only for orders/)
    } finally {
      await c.query('ROLLBACK').catch(() => {})
    }
    // The owner itself cannot point it at another project's table either.
    await expect(
      asPlatform(SERVICE, [
        `CREATE TRIGGER decoy AFTER UPDATE ON ${t(B, 'orders')} FOR EACH ROW EXECUTE FUNCTION ${a(N.forward)}()`,
        `UPDATE ${t(B, 'orders')} SET refund_amount = 1 WHERE id = (SELECT id FROM ${t(B, 'orders')} LIMIT 1)`,
      ]),
    ).rejects.toThrow(/fires only for orders/)
  })

  it('cannot be replaced by the project\'s read-write role, which owns the tables but not them', async () => {
    await rwLogin.query('BEGIN')
    try {
      await expect(
        rwLogin.query(`CREATE OR REPLACE FUNCTION ${a(N.forward)}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`),
      ).rejects.toThrow(/must be owner of function/)
    } finally {
      await rwLogin.query('ROLLBACK').catch(() => {})
    }
  })

  it('never run what a project role creates in the schema, whoever writes', async () => {
    // A read-write role may create objects in its schema. Each of these would
    // be chosen over a built-in by a function that searched the schema.
    const shadows = [
      `CREATE TABLE ${a('seen')} (who text, what text)`,
      `GRANT INSERT, SELECT ON ${a('seen')} TO PUBLIC`,
      `CREATE FUNCTION ${a('seen_oid_regclass')}(oid, regclass) RETURNS boolean LANGUAGE plpgsql AS $$
         BEGIN INSERT INTO ${a('seen')} VALUES (current_user, 'oid = regclass'); RETURN $1 = $2::oid; END $$`,
      `CREATE OPERATOR "${A}".= (LEFTARG = oid, RIGHTARG = regclass, FUNCTION = ${a('seen_oid_regclass')})`,
      `CREATE FUNCTION ${a('to_regprocedure')}(text) RETURNS regprocedure LANGUAGE plpgsql AS $$
         BEGIN INSERT INTO ${a('seen')} VALUES (current_user, 'to_regprocedure'); RETURN pg_catalog.to_regprocedure($1); END $$`,
      `CREATE FUNCTION ${a('pg_get_userbyid')}(oid) RETURNS name LANGUAGE plpgsql AS $$
         BEGIN INSERT INTO ${a('seen')} VALUES (current_user, 'pg_get_userbyid'); RETURN pg_catalog.pg_get_userbyid($1); END $$`,
      `CREATE FUNCTION ${a('set_config')}(text, text, boolean) RETURNS text LANGUAGE plpgsql AS $$
         BEGIN INSERT INTO ${a('seen')} VALUES (current_user, 'set_config'); RETURN pg_catalog.set_config($1, $2, $3); END $$`,
    ]
    for (const s of shadows) await rwLogin.query(s)
    // Fresh sessions, so no function was compiled before the objects existed.
    const runtime = await login(R.platform)
    const rest = await login(R.authenticator)
    const [k1, k2] = (await q(`SELECT id::text FROM ${a('orders')} WHERE user_id = $1 AND refund_amount IS NOT NULL ORDER BY total DESC LIMIT 2`, [U1])).map(r => r.id)
    for (const [c, role, sql] of [
      [runtime, null, `UPDATE ${a('orders')} SET refund_amount = 404 WHERE id = '${k1}'`],
      [runtime, null, `UPDATE ${a('order_refunds')} SET refund_reason = 'again' WHERE ${N.fkColumn} = '${k1}'`],
      [rest, R.authenticated, `UPDATE ${a('orders')} SET refund_amount = 505 WHERE id = '${k2}'`],
      [rest, R.authenticated, `DELETE FROM ${a('order_refunds')} WHERE ${N.fkColumn} = '${k2}'`],
    ] as Array<[Client, string | null, string]>) {
      await c.query('BEGIN')
      if (role) await c.query(`SET LOCAL ROLE ${role}`)
      await c.query(rlsSessionSql(1), rlsSessionParams(user(U1)))
      await c.query(sql)
      await c.query('COMMIT')
    }
    expect(await q(`SELECT who, what FROM ${a('seen')}`)).toEqual([])
  })
})

// ── Owner-level tampering is caught, never called consistent ─────────────────

describe('the project\'s read-write role, an owner of the tables', () => {
  it('can bypass the sync on its own data, and reconciliation reports it instead of calling it consistent', async () => {
    const [k] = (await q(`SELECT ${N.fkColumn}::text AS k FROM ${a('order_refunds')} ORDER BY 1 LIMIT 1`)).map(r => r.k)
    await rwLogin.query('BEGIN')
    try {
      await rwLogin.query(`SET LOCAL ROLE ${R.own}`)
      await rwLogin.query(`ALTER TABLE ${a('order_refunds')} DISABLE TRIGGER ${N.reverse}`)
      await rwLogin.query(rlsSessionSql(1), rlsSessionParams(SERVICE))
      await rwLogin.query(`SELECT set_config($1, 'on', true)`, [N.access])
      // As the owner, with the owner exempted only by turning FORCE off: its own data.
      await rwLogin.query(`ALTER TABLE ${a('order_refunds')} NO FORCE ROW LEVEL SECURITY`)
      await rwLogin.query(`UPDATE ${a('order_refunds')} SET refund_reason = 'diverged' WHERE ${N.fkColumn} = $1`, [k])
      const f = await facts()
      // The platform's view in a separate transaction sees the committed state only; check inside.
      await rwLogin.query(`ALTER TABLE ${a('order_refunds')} FORCE ROW LEVEL SECURITY`)
      await rwLogin.query(`ALTER TABLE ${a('order_refunds')} ENABLE TRIGGER ${N.reverse}`)
      await rwLogin.query('COMMIT')
      const r = await appDb.$transaction(async tx => {
        await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams(SERVICE))
        await tx.$executeRawUnsafe(ladderAccessSql(SPEC))
        return reconcileWith(tx, f, SPEC, { schema: A })
      })
      expect(r).toMatchObject({ complete: true, consistent: false, mismatched: 1 })
    } catch (err) {
      await rwLogin.query('ROLLBACK').catch(() => {})
      throw err
    }
    // Put it back the way the host has it, through the host, so undo below is lossless.
    await asPlatform(SERVICE, `UPDATE ${a('orders')} SET refund_reason = refund_reason WHERE id = '${k}'`)
    await asPlatform(SERVICE, [ladderAccessSql(SPEC), `UPDATE ${a('order_refunds')} s SET refund_reason = h.refund_reason FROM ${a('orders')} h WHERE h.id = s.${N.fkColumn} AND s.${N.fkColumn} = '${k}'`])
  })
})

// ── Another project ───────────────────────────────────────────────────────────

describe('another project', () => {
  it('is out of reach of this project\'s direct-access roles', async () => {
    for (const c of [roLogin, rwLogin]) {
      await expect(c.query(`SELECT count(*) FROM ${t(B, 'orders')}`)).rejects.toThrow(/permission denied for schema/)
    }
  })
})

// ── Undo ─────────────────────────────────────────────────────────────────────

describe('undo, as the platform, with the owner role holding the tables', () => {
  it('removes everything the ladder installed and leaves the host as it was', async () => {
    const f = await facts()
    const target = { schema: A }
    const readers = granteesWith(f, 'SELECT')
    const writers = granteesWith(f, 'UPDATE').filter(r => readers.includes(r))
    const before = await q(`SELECT id, refund_amount, refund_reason FROM ${a('orders')} ORDER BY id`)
    await asPlatform(SERVICE, [
      ...closeWritesSql(SPEC, target, writers),
      ...revokeReadsSql(SPEC, target, readers),
      ...dropForwardSyncSql(SPEC, target),
      ...dropSatelliteSql(SPEC, target),
    ])
    expect((await q(`SELECT to_regclass($1) AS r`, [a('order_refunds')]))[0].r).toBeNull()
    expect(await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname LIKE 'bkn\\_evo\\_%'`, [a('orders')])).toEqual([])
    expect(await q(`SELECT polname FROM pg_policy WHERE polrelid = $1::regclass AND polname LIKE 'bkn\\_evo\\_%'`, [a('orders')])).toEqual([])
    expect(await q(`SELECT proname FROM pg_proc WHERE pronamespace = $1::regnamespace AND proname LIKE 'bkn\\_evo\\_%'`, [`"${A}"`])).toEqual([])
    expect(await q(`SELECT id, refund_amount, refund_reason FROM ${a('orders')} ORDER BY id`)).toEqual(before)
  })
})
