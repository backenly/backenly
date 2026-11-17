/**
 * A DELETED PROJECT'S LOGINS ARE RETIRED AT ONCE, BY A DEFINER THAT HOLDS ONLY ADMIN ON THEM
 * =========================================================================================
 * A deletion keeps a schema PostgREST served for the region's later pass
 * (lib/postgrest/retire-schema.ts), and the project's logins cannot be dropped
 * before it: dropping one revokes its grants on what the project's owner role
 * owns, which the definer on Amazon RDS may not touch. So the deletion retires
 * each login at once through public.backenly_direct_retire_role
 * (scripts/setup-direct-access.sql) and public.backenly_fn_role_retire
 * (scripts/sql/function-roles.sql): NOLOGIN, no password, its sessions ended.
 *
 * Here the two helpers are owned by a definer that is not a superuser and holds
 * only ADMIN on the logins it made, as the RDS master does, in a database of
 * their own: installing the files writes event triggers and converges every
 * workspace schema in the database it runs in. regional-bootstrap.spec.ts
 * rehearses the deletion and the pass on the whole regional procedure in CI.
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const hex = () => randomBytes(6).toString('hex')
const DB_NAME = `backenly_retire_logins_${randomBytes(4).toString('hex')}`
const DEFINER = `retire_test_definer_${hex()}`
const ro = `bkn_ro_${hex()}`
const fn = `bkn_fn_${hex()}`
/** One the definer already holds a grant of, made by itself, as every grant the RDS master makes is recorded alike. */
const held = `bkn_rw_${hex()}`
const PASSWORD = randomBytes(24).toString('base64url')

let DB_URL = ''
let db: Client

function urlFor(database: string, role?: string, password?: string): string {
  const u = new URL(ADMIN_URL!)
  u.pathname = `/${database}`
  if (role) {
    u.username = role
    u.password = password ?? ''
  }
  return u.toString()
}

async function adminExec(query: string): Promise<void> {
  const admin = new Client({ connectionString: urlFor('postgres') })
  await admin.connect()
  try {
    await admin.query(query)
  } finally {
    await admin.end()
  }
}

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[]

/** The definer's memberships, which a retirement must leave as they were. */
const definerMemberships = () =>
  q(
    `SELECT roleid::regrole::text AS role, admin_option, inherit_option, set_option, grantor::regrole::text AS grantor
       FROM pg_auth_members WHERE member = $1::regrole
      ORDER BY roleid::regrole::text COLLATE "C", grantor::regrole::text COLLATE "C"`,
    [DEFINER],
  )

const loginState = async (role: string) =>
  (await q<{ login: boolean; no_password: boolean }>(
    `SELECT rolcanlogin AS login, rolpassword IS NULL AS no_password FROM pg_authid WHERE rolname = $1`,
    [role],
  ))[0]

/** A session open as `role`, as a developer's psql or a function's pool would hold one. */
async function sessionAs(role: string): Promise<Client> {
  const c = new Client({ connectionString: urlFor(DB_NAME, role, PASSWORD) })
  c.on('error', () => {})
  await c.connect()
  return c
}

async function stillAnswers(c: Client): Promise<boolean> {
  try {
    await c.query('SELECT 1')
    return true
  } catch {
    return false
  }
}

async function logsIn(role: string): Promise<string | null> {
  try {
    const c = await sessionAs(role)
    await c.end().catch(() => {})
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!ADMIN_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  DB_URL = urlFor(DB_NAME)
  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME}`)
  await adminExec(`CREATE DATABASE ${DB_NAME}`)
  await adminExec(`ALTER DATABASE ${DB_NAME} SET backenly.app_role = '${new URL(ADMIN_URL).username}'`)

  db = new Client({ connectionString: DB_URL })
  await db.connect()
  for (const file of ['scripts/setup-direct-access.sql', 'scripts/sql/function-roles.sql']) {
    await db.query(fs.readFileSync(path.join(process.cwd(), file), 'utf8'))
  }

  // A definer like the RDS master: CREATEROLE, not a superuser, owning the helpers.
  await q(`CREATE ROLE ${DEFINER} NOLOGIN CREATEROLE`)
  await q(`ALTER FUNCTION public.backenly_direct_retire_role(text) OWNER TO ${DEFINER}`)
  await q(`ALTER FUNCTION public.backenly_fn_role_retire(text) OWNER TO ${DEFINER}`)
  // Logins it made with createrole_self_grant unset: ADMIN on each, none of its privileges.
  await q(`SET createrole_self_grant = ''`)
  await q(`SET ROLE ${DEFINER}`)
  await q(`CREATE ROLE ${ro} LOGIN PASSWORD '${PASSWORD}'`)
  await q(`CREATE ROLE ${fn} LOGIN PASSWORD '${PASSWORD}'`)
  await q(`CREATE ROLE ${held} LOGIN PASSWORD '${PASSWORD}'`)
  await q(`GRANT ${held} TO ${DEFINER} WITH INHERIT FALSE, SET FALSE`)
  await q(`RESET ROLE`)
  await q(`RESET createrole_self_grant`)
}, 120_000)

afterAll(async () => {
  await db?.end().catch(() => {})
  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {})
  for (const role of [ro, fn, held, DEFINER]) await adminExec(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
}, 120_000)

it('the definer holds only ADMIN on the logins it made, as on Amazon RDS', async () => {
  expect(await q(`SELECT pg_has_role($1, $2, 'USAGE') AS usage, pg_has_role($1, $2, 'MEMBER WITH ADMIN OPTION') AS admin`, [DEFINER, ro]))
    .toEqual([{ usage: false, admin: true }])
})

it.each([
  ['a direct-access login', () => ro, 'backenly_direct_retire_role'],
  ['a function login', () => fn, 'backenly_fn_role_retire'],
  ['a login whose grant the definer made itself', () => held, 'backenly_direct_retire_role'],
])('retires %s at once: unable to log in, its session ended, the definer holding what it held', async (_kind, login, helper) => {
  const role = login()
  const before = await definerMemberships()
  const open = await sessionAs(role)
  expect(await stillAnswers(open)).toBe(true)

  expect(await q(`SELECT public.${helper}($1) AS retired`, [role])).toEqual([{ retired: true }])

  expect(await loginState(role)).toEqual({ login: false, no_password: true })
  expect(await stillAnswers(open)).toBe(false)
  expect(await logsIn(role)).toMatch(/not permitted to log in|password authentication failed/)
  expect(await definerMemberships()).toEqual(before)
  await open.end().catch(() => {})

  // Again, as a deletion calls it after its commit: nothing changes.
  expect(await q(`SELECT public.${helper}($1) AS retired`, [role])).toEqual([{ retired: true }])
  expect(await definerMemberships()).toEqual(before)
}, 60_000)

it('answers true for a login that is gone, and refuses a name that is not a project login', async () => {
  expect(await q(`SELECT public.backenly_direct_retire_role($1) AS retired`, [`bkn_rw_${hex()}`])).toEqual([{ retired: true }])
  expect(await q(`SELECT public.backenly_fn_role_retire($1) AS retired`, [`bkn_fn_${hex()}`])).toEqual([{ retired: true }])
  await expect(q(`SELECT public.backenly_direct_retire_role('postgres')`)).rejects.toThrow(/invalid role name/)
  await expect(q(`SELECT public.backenly_fn_role_retire($1)`, [ro])).rejects.toThrow(/not a function role/)
  await expect(q(`SELECT public.backenly_direct_retire_role($1)`, [fn])).rejects.toThrow(/invalid role name/)
})
