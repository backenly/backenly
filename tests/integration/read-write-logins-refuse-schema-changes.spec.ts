/**
 * A READ-WRITE LOGIN CHANGES ROWS, NOT THE SCHEMA, UNTIL ITS OWNER ALLOWS IT
 * ==========================================================================
 *
 * Production QA (2026-11-09, report 91): a read-write Postgres login could
 * DROP a table from psql, skipping the approvals and the History every other
 * door goes through; its schema changes were only observed as drift after the
 * fact. The person arming it was told "observed, not blocked".
 *
 * A new read-write login now reads and writes rows only: it is no member of
 * the project's owner role and has no CREATE on the schema, so Postgres itself
 * refuses a schema change over it. The project's admin can allow schema
 * changes, and a login from before this setting keeps what it had.
 *
 * Real Postgres and the real definer functions (scripts/setup-direct-access.sql):
 * the property is what a role may do, which only the database can say. The
 * read-write role is exercised with SET ROLE from the test's own connection.
 */
import { execFileSync } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { directAccessRoleNames, getDirectAccessStatus, provisionDirectAccess, revokeDirectAccess, setSchemaChanges } from '@/lib/services/direct-access'

const CONN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
const hex = randomBytes(6).toString('hex')
const schema = `workspace_${randomUUID()}`
const rw = `bkn_rw_${hex}`
const own = `bkn_own_${hex}`
const legacy = `bkn_rw_${randomBytes(6).toString('hex')}`
const legacyOwn = `bkn_own_${legacy.slice(7)}`
const legacySchema = `workspace_${randomUUID()}`
const app = `bkn_test_app_${hex}`
const PASSWORD = randomBytes(24).toString('base64url')
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

let db: Client
let ownerId = ''
let projectId = ''

const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
/** Run `sql` as `role`, and say whether Postgres allowed it. */
async function as(role: string, sql: string): Promise<'ok' | string> {
  await q('BEGIN')
  try {
    await q(`SET LOCAL ROLE ${role}`)
    await q(sql)
    await q('COMMIT')
    return 'ok'
  } catch (err) {
    await q('ROLLBACK')
    return (err as Error).message
  }
}
const sync = (s: string, rwRole: string, ownRole: string) =>
  q(`SELECT public.backenly_direct_sync_schema($1, NULL, $2, $3)`, [s, rwRole, ownRole])
const isMember = async (member: string, role: string) =>
  (await q(
    `SELECT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
                                                    AND m.member = (SELECT oid FROM pg_roles WHERE rolname = $2)) AS yes`,
    [role, member],
  ))[0].yes as boolean

beforeAll(async () => {
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', 'scripts/setup-direct-access.sql', '-d', CONN], { stdio: 'pipe' })
  db = new Client({ connectionString: CONN })
  await db.connect()
  await q(`CREATE ROLE ${app} NOLOGIN`)
  await q(`SET backenly.app_role = '${app}'`)
  for (const s of [schema, legacySchema]) {
    await q(`CREATE SCHEMA "${s}" AUTHORIZATION ${app}`)
    await q(`CREATE TABLE "${s}".orders (id serial PRIMARY KEY, total int)`)
    await q(`ALTER TABLE "${s}".orders OWNER TO ${app}`)
  }
}, 120_000)

afterAll(async () => {
  if (projectId) await revokeDirectAccess(projectId, 'READ_WRITE').catch(() => {})
  if (ownerId) {
    const ids = (await prisma.project.findMany({ where: { userId: ownerId }, select: { id: true } })).map((p) => p.id)
    for (const id of ids) {
      await q(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
      const own = directAccessRoleNames(id).owner
      await q(`DROP OWNED BY ${own}`).catch(() => {})
      await q(`DROP ROLE IF EXISTS ${own}`).catch(() => {})
    }
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  }
  await q(`RESET backenly.app_role`).catch(() => {})
  for (const s of [schema, legacySchema]) await q(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
  for (const role of [rw, own, legacy, legacyOwn, app]) {
    await q(`DROP OWNED BY ${role}`).catch(() => {})
    await q(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
  }
  await db.end()
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
}, 120_000)

describe('a new read-write login', () => {
  it('reads and writes rows, and Postgres refuses it any schema change', async () => {
    await q(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_WRITE')`, [rw, PASSWORD, schema])
    await sync(schema, rw, own)

    expect(await as(rw, `INSERT INTO "${schema}".orders (total) VALUES (10)`)).toBe('ok')
    expect(await as(rw, `UPDATE "${schema}".orders SET total = 11`)).toBe('ok')
    expect(await as(rw, `SELECT count(*) FROM "${schema}".orders`)).toBe('ok')
    expect(await as(rw, `CREATE TABLE "${schema}".scratch (id int)`)).toMatch(/permission denied for schema/)
    expect(await as(rw, `DROP TABLE "${schema}".orders`)).toMatch(/must be owner/)
    expect(await as(rw, `ALTER TABLE "${schema}".orders ADD COLUMN note text`)).toMatch(/must be owner/)
    expect(await isMember(rw, own)).toBe(false)
  }, 60_000)

  it('may change the schema once its owner allows it, and not after they take that back', async () => {
    await q(`SELECT public.backenly_direct_set_schema_changes($1, true)`, [rw])
    await sync(schema, rw, own)
    expect(await as(rw, `CREATE TABLE "${schema}".scratch (id int)`)).toBe('ok')
    expect(await as(rw, `DROP TABLE "${schema}".scratch`)).toBe('ok')

    await q(`SELECT public.backenly_direct_set_schema_changes($1, false)`, [rw])
    await sync(schema, rw, own)
    expect(await as(rw, `CREATE TABLE "${schema}".scratch (id int)`)).toMatch(/permission denied for schema/)
    expect(await isMember(rw, own)).toBe(false)
    expect(await as(rw, `INSERT INTO "${schema}".orders (total) VALUES (12)`)).toBe('ok')
  }, 60_000)

  it('keeps its setting when its password is changed', async () => {
    await q(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_WRITE')`, [rw, randomBytes(24).toString('base64url'), schema])
    await sync(schema, rw, own)
    expect(await as(rw, `CREATE TABLE "${schema}".scratch (id int)`)).toMatch(/permission denied for schema/)
  }, 60_000)
})

describe('a read-write login made before the setting existed', () => {
  it('keeps the schema changes it had', async () => {
    await q(`CREATE ROLE ${legacy} NOLOGIN`)
    await sync(legacySchema, legacy, legacyOwn)
    expect(await as(legacy, `CREATE TABLE "${legacySchema}".made_directly (id int)`)).toBe('ok')
    expect(await isMember(legacy, legacyOwn)).toBe(true)
  }, 60_000)
})

describe('held by a definer that is not a superuser, as on Amazon RDS', () => {
  // RDS gives no superuser. Its master owns the definer functions and holds
  // ADMIN on the roles it created, nothing more, and a role-level setting of
  // Backenly's own (ALTER ROLE ... SET backenly.x) needs a superuser to write.
  // All of this runs in one transaction and is rolled back, so other suites
  // only ever see the functions as installed.
  it('makes a read-write login that refuses schema changes, and lets its owner allow them', async () => {
    const definer = `bkn_test_definer_${hex}`
    const login = `bkn_rw_${randomBytes(6).toString('hex')}`
    const refused = async () =>
      (await q(
        `SELECT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
                         WHERE g.rolname = 'backenly_no_schema_changes' AND u.rolname = $1) AS yes`,
        [login],
      ))[0].yes as boolean
    await q('BEGIN')
    try {
      await q(`CREATE ROLE ${definer} NOLOGIN NOSUPERUSER CREATEROLE`)
      // ADMIN on the groups the install made, as the master that made them holds it.
      for (const { rolname } of await q(`SELECT rolname FROM pg_roles WHERE rolname IN ('backenly_external', 'backenly_no_schema_changes')`)) {
        await q(`GRANT ${rolname} TO ${definer} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`)
      }
      await q(`ALTER FUNCTION public.backenly_direct_create_role(text, text, text, text) OWNER TO ${definer}`)
      await q(`ALTER FUNCTION public.backenly_direct_set_schema_changes(text, boolean) OWNER TO ${definer}`)

      await q(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_WRITE')`, [login, PASSWORD, schema])
      expect(await refused()).toBe(true)
      await q(`SELECT public.backenly_direct_set_schema_changes($1, true)`, [login])
      expect(await refused()).toBe(false)
      await q(`SELECT public.backenly_direct_set_schema_changes($1, false)`, [login])
      expect(await refused()).toBe(true)
    } finally {
      await q('ROLLBACK')
    }
  }, 60_000)
})

describe('through the application', () => {
  it('provisions read-write access that refuses schema changes, says so, and lets the admin allow them', async () => {
    process.env.BACKENLY_EDITION = 'cloud'
    ownerId = (await prisma.user.create({
      data: { email: `rw-login-${hex}@example.test`, password: 'not-a-real-hash', name: 'owner' },
    })).id
    projectId = (await createProvisionedProject({ name: 'read-write-logins', userId: ownerId })).id
    const role = directAccessRoleNames(projectId).rw
    const workspace = `workspace_${projectId}`

    const credential = await provisionDirectAccess(projectId, 'READ_WRITE')
    expect(credential.schemaChanges).toBe('refused')
    expect((await getDirectAccessStatus(projectId)).credentials.find((c) => c.mode === 'READ_WRITE')?.schemaChanges).toBe('refused')
    expect(await as(role, `CREATE TABLE "${workspace}".scratch (id int)`)).toMatch(/permission denied for schema/)

    await setSchemaChanges(projectId, true)
    expect((await getDirectAccessStatus(projectId)).credentials.find((c) => c.mode === 'READ_WRITE')?.schemaChanges).toBe('allowed')
    expect(await as(role, `CREATE TABLE "${workspace}".scratch (id int)`)).toBe('ok')
  }, 120_000)

  it('refuses to set it where there is no read-write login', async () => {
    const other = (await createProvisionedProject({ name: 'no-read-write', userId: ownerId })).id
    await expect(setSchemaChanges(other, true)).rejects.toThrow(/no read-write login/)
  }, 120_000)
})
