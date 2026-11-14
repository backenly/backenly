/**
 * A READ-WRITE LOGIN CHANGES ROWS, NOT THE SCHEMA
 * ===============================================
 *
 * Production QA (2026-11-09, report 91): a read-write Postgres login could
 * DROP a table from psql, skipping the approvals and the History every other
 * door goes through; its schema changes were only observed as drift after the
 * fact. A new read-write login has since read and written rows only.
 *
 * The schema changes it could be allowed were worse than unrecorded. Code a
 * login creates in its schema (a trigger, a policy's function, a view, a
 * default) runs in whichever session touches the table, and on a database
 * shared by several projects those sessions are the platform's own, which
 * reach every project. Switching role inside the planted code returns to them:
 * PostgreSQL checks SET ROLE against the session user.
 *
 * So on a shared database, which every Backenly Cloud database is, a
 * read-write login holds nothing that lets it create anything: allowing schema
 * changes is refused, the sync strips the login it names, installing the SQL
 * strips every login, and a session a login had open ends. On a database
 * dedicated to one project (a self-hosted deployment, marked by
 * scripts/sql/dedicated-database.sql) the admin may still allow them, until a
 * second project's workspace makes it shared.
 *
 * Real Postgres and the real definer functions (scripts/setup-direct-access.sql):
 * the property is what a role may do, which only the database can say. Roles
 * are exercised by logging in as them where the session user matters (SET ROLE
 * is checked against it) and with SET ROLE from the test's own connection
 * elsewhere.
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
const app = `bkn_test_app_${hex}`
const PASSWORD = randomBytes(24).toString('base64url')
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

/** A read-write login from before: a member of its owner role, CREATE on its schema, a function of its own. */
function legacyNames() {
  const h = randomBytes(6).toString('hex')
  return { login: `bkn_rw_${h}`, owner: `bkn_own_${h}`, schema: `workspace_${randomUUID()}` }
}
const bySync = legacyNames()
const byInstall = legacyNames()
const onRds = legacyNames()
/** Logins from before that the later cases make, and other roles they add, all removed at the end. */
const madeLater: Array<ReturnType<typeof legacyNames>> = []
const rolesLater: string[] = []
function anotherFromBefore(): ReturnType<typeof legacyNames> {
  const l = legacyNames()
  madeLater.push(l)
  return l
}

let db: Client
let ownerId = ''
let projectId = ''
const sessions: Client[] = []

const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows

function urlFor(database: string, role?: string, password?: string): string {
  const u = new URL(CONN)
  u.pathname = `/${database}`
  if (role) {
    u.username = role
    u.password = password ?? ''
  }
  return u.toString()
}
const thisDatabase = () => new URL(CONN).pathname.replace(/^\//, '')

const install = (file: string, url = CONN) =>
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', file, '-d', url], { stdio: 'pipe' })

/** Run `sql` as `role` on `client`, and say whether Postgres allowed it. */
async function asOn(client: Client, role: string, sql: string): Promise<'ok' | string> {
  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL ROLE ${role}`)
    await client.query(sql)
    await client.query('COMMIT')
    return 'ok'
  } catch (err) {
    await client.query('ROLLBACK')
    return (err as Error).message
  }
}
const as = (role: string, sql: string) => asOn(db, role, sql)

/** A session that logs in as `role`, as a developer's psql does. */
async function login(role: string, database = thisDatabase()): Promise<Client> {
  const c = new Client({ connectionString: urlFor(database, role, PASSWORD) })
  c.on('error', () => {}) // a session the strip ends must not end the suite
  await c.connect()
  sessions.push(c)
  return c
}
async function attempt(c: Client, sql: string): Promise<'ok' | string> {
  try {
    await c.query(sql)
    return 'ok'
  } catch (err) {
    return (err as Error).message
  }
}

const sync = (s: string, rwRole: string, ownRole: string, client = db) =>
  client.query(`SELECT public.backenly_direct_sync_schema($1, NULL, $2, $3)`, [s, rwRole, ownRole])
const holds = async (role: string, client = db) =>
  (await client.query(`SELECT public.backenly_direct_schema_change_holds($1) AS holds`, [role])).rows[0].holds as string[]
const isMember = async (member: string, role: string, client = db) =>
  (await client.query(
    `SELECT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
                                                    AND m.member = (SELECT oid FROM pg_roles WHERE rolname = $2)) AS yes`,
    [role, member],
  )).rows[0].yes as boolean
const shared = async (client = db) =>
  (await client.query(`SELECT public.backenly_direct_shared_database() AS shared`)).rows[0].shared as boolean
const functionOwner = async (s: string, name: string, client = db) =>
  (await client.query(
    `SELECT pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2`,
    [s, name],
  )).rows[0]?.owner as string | undefined
/** Whether `member` may SET ROLE to `role` (PostgreSQL 16's membership option). */
const canBecome = async (member: string, role: string) =>
  (await q(`SELECT m.set_option FROM pg_auth_members m WHERE m.roleid = $1::regrole AND m.member = $2::regrole`, [role, member]))[0]
    ?.set_option as boolean | undefined
/** The mark a strip leaves on its login until the sessions that may have outlived it are ended. */
const strippedMark = async (role: string) =>
  ((await q(
    `SELECT d.description FROM pg_shdescription d JOIN pg_roles r ON r.oid = d.objoid
      WHERE d.classoid = 'pg_authid'::regclass AND r.rolname = $1`,
    [role],
  ))[0]?.description ?? null) as string | null
/** What every login holds at once in a project's schemas (scripts/setup-direct-access.sql, 5c). */
const sharedHolds = async (s: string, owner: string) =>
  (await q(`SELECT holder || ' holds ' || item AS held FROM public.backenly_direct_shared_holds($1, $2)`, [s, owner]))
    .map((r) => r.held as string)
    .sort()

/** Sessions of `role` still open, waiting up to five seconds for ended ones to go. */
async function sessionsOf(role: string): Promise<number> {
  for (let i = 0; ; i++) {
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`, [role])
    if (n === 0 || i >= 50) return n
    await new Promise((r) => setTimeout(r, 100))
  }
}

/**
 * A read-write login as the sync made one before a login could be refused
 * schema changes, and as such a login then used them: a member of its owner
 * role, CREATE on the schema, TRIGGER on a table, and a function it created.
 */
async function loginFromBefore(l: { login: string; owner: string; schema: string }): Promise<void> {
  await q(`CREATE ROLE ${l.login} LOGIN PASSWORD '${PASSWORD}' IN ROLE backenly_external`)
  await q(`CREATE ROLE ${l.owner} NOLOGIN`)
  await q(`GRANT ${l.owner} TO ${app}`)
  await q(`GRANT ${l.owner} TO ${l.login}`)
  await q(`CREATE SCHEMA "${l.schema}" AUTHORIZATION ${l.owner}`)
  await q(`CREATE TABLE "${l.schema}".orders (id serial PRIMARY KEY, total int)`)
  await q(`ALTER TABLE "${l.schema}".orders OWNER TO ${l.owner}`)
  await q(`GRANT USAGE, CREATE ON SCHEMA "${l.schema}" TO ${l.login}`)
  await q(`GRANT SELECT, INSERT, UPDATE, DELETE, TRIGGER ON "${l.schema}".orders TO ${l.login}`)
  await q(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "${l.schema}" TO ${l.login}`)
  expect(await as(l.login, `CREATE FUNCTION "${l.schema}".planted() RETURNS int LANGUAGE sql AS 'SELECT 1'`)).toBe('ok')
}

beforeAll(async () => {
  install('scripts/setup-direct-access.sql')
  db = new Client({ connectionString: CONN })
  await db.connect()
  await q(`CREATE ROLE ${app} NOLOGIN`)
  await q(`SET backenly.app_role = '${app}'`)
  await q(`CREATE SCHEMA "${schema}" AUTHORIZATION ${app}`)
  await q(`CREATE TABLE "${schema}".orders (id serial PRIMARY KEY, total int)`)
  await q(`ALTER TABLE "${schema}".orders OWNER TO ${app}`)
}, 120_000)

afterAll(async () => {
  for (const c of sessions) await c.end().catch(() => {})
  if (projectId) await revokeDirectAccess(projectId, 'READ_WRITE').catch(() => {})
  if (ownerId) {
    const ids = (await prisma.project.findMany({ where: { userId: ownerId }, select: { id: true } })).map((p) => p.id)
    for (const id of ids) {
      await q(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
      const role = directAccessRoleNames(id).owner
      await q(`DROP OWNED BY ${role}`).catch(() => {})
      await q(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
    }
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  }
  await q(`RESET backenly.app_role`).catch(() => {})
  for (const s of [schema, bySync.schema, byInstall.schema, onRds.schema, ...madeLater.map((l) => l.schema)]) {
    await q(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
  }
  for (const role of [
    rw, own, bySync.login, bySync.owner, byInstall.login, byInstall.owner, onRds.login, onRds.owner,
    ...madeLater.flatMap((l) => [l.login, l.owner]), ...rolesLater, app,
  ]) {
    await q(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [role]).catch(() => {})
    await q(`DROP OWNED BY ${role}`).catch(() => {})
    await q(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
  }
  await db.end()
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
}, 120_000)

describe('on a database shared by several projects, as this one is', () => {
  it('is read as shared: it holds more than one project\'s workspace', async () => {
    expect(await shared()).toBe(true)
  })

  it('gives a new read-write login rows, and refuses it everything it could plant code with', async () => {
    await q(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_WRITE')`, [rw, PASSWORD, schema])
    await sync(schema, rw, own)

    const c = await login(rw)
    const t = `"${schema}".orders`
    expect(await attempt(c, `INSERT INTO ${t} (total) VALUES (10)`)).toBe('ok')
    expect(await attempt(c, `UPDATE ${t} SET total = 11`)).toBe('ok')
    expect(await attempt(c, `SELECT count(*) FROM ${t}`)).toBe('ok')

    expect(await attempt(c, `CREATE FUNCTION "${schema}".f() RETURNS int LANGUAGE sql AS 'SELECT 1'`)).toMatch(/permission denied for schema/)
    expect(await attempt(c, `CREATE VIEW "${schema}".v AS SELECT 1 AS one`)).toMatch(/permission denied for schema/)
    expect(await attempt(c, `CREATE TABLE "${schema}".scratch (id int)`)).toMatch(/permission denied for schema/)
    expect(await attempt(c, `CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'SELECT 1'`)).toMatch(/permission denied for schema/)
    expect(await attempt(c, `CREATE TRIGGER t BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`)).toMatch(/permission denied/)
    expect(await attempt(c, `CREATE POLICY p ON ${t} USING (true)`)).toMatch(/must be owner/)
    expect(await attempt(c, `CREATE RULE r AS ON UPDATE TO ${t} DO ALSO NOTHING`)).toMatch(/must be owner/)
    expect(await attempt(c, `ALTER TABLE ${t} ALTER COLUMN total SET DEFAULT 1`)).toMatch(/must be owner/)
    expect(await attempt(c, `DROP TABLE ${t}`)).toMatch(/must be owner/)
    expect(await attempt(c, `CREATE SCHEMA planted_${hex}`)).toMatch(/permission denied for database/)
    expect(await attempt(c, `SET ROLE ${own}`)).toMatch(/permission denied to set role/)

    expect(await holds(rw)).toEqual([])
    expect(await isMember(rw, own)).toBe(false)
  }, 60_000)

  it('refuses to allow it schema changes, says why, and its next sync still gives none', async () => {
    await expect(q(`SELECT public.backenly_direct_set_schema_changes($1, true)`, [rw])).rejects.toThrow(/shared by several projects/)
    expect(await isMember(rw, 'backenly_no_schema_changes')).toBe(true)
    await sync(schema, rw, own)
    expect(await as(rw, `CREATE TABLE "${schema}".scratch (id int)`)).toMatch(/permission denied for schema/)
    // Refusing them is still accepted.
    expect(await q(`SELECT public.backenly_direct_set_schema_changes($1, false) AS ok`, [rw])).toEqual([{ ok: true }])
  }, 60_000)

  it('keeps refusing when its password is changed', async () => {
    await q(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_WRITE')`, [rw, PASSWORD, schema])
    await sync(schema, rw, own)
    expect(await as(rw, `CREATE TABLE "${schema}".scratch (id int)`)).toMatch(/permission denied for schema/)
  }, 60_000)

  it('takes from a login from before, at its next sync, everything that let it change the schema, and ends its session', async () => {
    await loginFromBefore(bySync)
    // The session a developer left open, as the owner role, which outlives a revoked membership.
    const session = await login(bySync.login)
    expect(await attempt(session, `SET ROLE ${bySync.owner}`)).toBe('ok')
    expect(await holds(bySync.login)).toEqual(expect.arrayContaining([
      `member of ${bySync.owner}`,
      `CREATE on schema ${bySync.schema}`,
      'owner of 1 object(s)',
    ]))

    await sync(bySync.schema, bySync.login, bySync.owner)

    expect(await holds(bySync.login)).toEqual([])
    expect(await isMember(bySync.login, bySync.owner)).toBe(false)
    expect(await isMember(bySync.login, 'backenly_no_schema_changes')).toBe(true)
    // What it created is the project's owner role's, which it can no longer act as.
    expect(await functionOwner(bySync.schema, 'planted')).toBe(bySync.owner)
    expect(await sessionsOf(bySync.login)).toBe(0)
    await expect(session.query('SELECT 1')).rejects.toThrow()
    expect(await as(bySync.login, `CREATE TABLE "${bySync.schema}".again (id int)`)).toMatch(/permission denied for schema/)
    expect(await as(bySync.login, `CREATE TRIGGER t BEFORE UPDATE ON "${bySync.schema}".orders FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`)).toMatch(/permission denied/)
    expect(await as(bySync.login, `INSERT INTO "${bySync.schema}".orders (total) VALUES (1)`)).toBe('ok')
  }, 60_000)

  it('takes it from every login from before when the file is installed again, as a release does', async () => {
    await loginFromBefore(byInstall)
    const session = await login(byInstall.login)
    expect((await holds(byInstall.login)).length).toBeGreaterThan(0)

    install('scripts/setup-direct-access.sql')

    expect(await holds(byInstall.login)).toEqual([])
    expect(await isMember(byInstall.login, 'backenly_no_schema_changes')).toBe(true)
    expect(await functionOwner(byInstall.schema, 'planted')).toBe(byInstall.owner)
    expect(await sessionsOf(byInstall.login)).toBe(0)
    await expect(session.query('SELECT 1')).rejects.toThrow()
    // Nor does any login get it through PUBLIC.
    expect((await q(`SELECT has_schema_privilege('public', 'public', 'CREATE') AS c`))[0].c).toBe(false)
    expect((await q(`SELECT has_database_privilege('public', current_database(), 'CREATE') AS c`))[0].c).toBe(false)
    // The sessions the strip left were ended by the install's next statement (section 7b).
    expect(await strippedMark(byInstall.login)).toBeNull()
  }, 120_000)

  it('takes every grant option, default privilege and membership from a login from before, so a table its owner role makes later gives it nothing', async () => {
    const l = anotherFromBefore()
    await loginFromBefore(l)
    const other = `bkn_test_other_${hex}`
    rolesLater.push(other)
    await q(`CREATE ROLE ${other} NOLOGIN`)
    await q(`GRANT ${other} TO ${l.login}`)
    await q(`GRANT CREATE ON DATABASE "${thisDatabase()}" TO ${l.login}`)
    // What such a login could give itself, acting as the owner role.
    expect(await as(l.owner, `GRANT SELECT, INSERT ON "${l.schema}".orders TO ${l.login} WITH GRANT OPTION`)).toBe('ok')
    expect(await as(l.owner, `ALTER DEFAULT PRIVILEGES FOR ROLE ${l.owner} IN SCHEMA "${l.schema}" GRANT TRIGGER ON TABLES TO ${l.login}`)).toBe('ok')
    expect(await holds(l.login)).toEqual(expect.arrayContaining([
      `member of ${other}`,
      `CREATE on database ${thisDatabase()}`,
      expect.stringMatching(/^grant option on table .*\.orders$/),
      `default privileges of ${l.owner} in schema ${l.schema} on tables`,
    ]))

    await sync(l.schema, l.login, l.owner)

    expect(await holds(l.login)).toEqual([])
    const [{ roles }] = await q(
      `SELECT array_agg(g.rolname::text ORDER BY 1) AS roles FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
        WHERE m.member = $1::regrole`,
      [l.login],
    )
    expect(roles).toEqual(['backenly_external', 'backenly_no_schema_changes'])
    expect((await q(`SELECT has_database_privilege($1, current_database(), 'CREATE') AS c`, [l.login]))[0].c).toBe(false)
    expect((await q(
      `SELECT has_table_privilege($1, $2, 'SELECT WITH GRANT OPTION') OR has_table_privilege($1, $2, 'INSERT WITH GRANT OPTION') AS g`,
      [l.login, `"${l.schema}".orders`],
    ))[0].g).toBe(false)
    // It keeps the rows it may change.
    expect((await q(`SELECT has_table_privilege($1, $2, 'INSERT') AS i`, [l.login, `"${l.schema}".orders`]))[0].i).toBe(true)
    expect(await q(
      `SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE a.grantee = $1::regrole`,
      [l.login],
    )).toEqual([])
    expect(await as(l.owner, `CREATE TABLE "${l.schema}".later (id int)`)).toBe('ok')
    expect((await q(`SELECT has_table_privilege($1, $2, 'TRIGGER') AS t`, [l.login, `"${l.schema}".later`]))[0].t).toBe(false)
  }, 60_000)

  it('does not take a temporary table for a way to change the schema, and leaves the session that made it alone', async () => {
    const c = await login(rw)
    expect(await attempt(c, `CREATE TEMP TABLE scratch_tmp (x int)`)).toBe('ok')
    expect(await holds(rw)).toEqual([])
    await sync(schema, rw, own)
    expect(await attempt(c, `SELECT count(*) FROM scratch_tmp`)).toBe('ok')
    expect(await strippedMark(rw)).toBeNull()
  }, 60_000)

  it('ends, once the strip has committed, a session that logged in while it ran and took the owner role', async () => {
    const l = anotherFromBefore()
    await loginFromBefore(l)
    let late: Client | null = null
    let tookRole = ''
    await q('BEGIN')
    try {
      expect(await q(`SELECT public.backenly_direct_strip_schema_changes($1, $2, $3) AS taken`, [l.login, l.owner, l.schema]))
        .toEqual([{ taken: true }])
      // Logs in before the strip commits, so it sees the membership still there.
      late = await login(l.login)
      tookRole = await attempt(late, `SET ROLE ${l.owner}`)
    } finally {
      await q('COMMIT')
    }
    // What no ordering inside the strip's own transaction can stop.
    expect(tookRole).toBe('ok')
    expect(await holds(l.login)).toEqual([])
    expect(await strippedMark(l.login)).toMatch(/^backenly: sessions to end after a strip/)

    // As the application does right after each sync, now that the strip has committed.
    expect(await q(`SELECT public.backenly_direct_end_stripped_sessions($1) AS ended`, [l.login])).toEqual([{ ended: 1 }])
    expect(await sessionsOf(l.login)).toBe(0)
    expect(await attempt(late!, `CREATE FUNCTION "${l.schema}".after_strip() RETURNS int LANGUAGE sql AS 'SELECT 1'`))
      .toMatch(/terminat|Connection/i)
    expect(await strippedMark(l.login)).toBeNull()

    // A session that logs in after that cannot take the role, and the next sync leaves it alone.
    const next = await login(l.login)
    expect(await attempt(next, `SET ROLE ${l.owner}`)).toMatch(/permission denied to set role/)
    await sync(l.schema, l.login, l.owner)
    expect(await attempt(next, `SELECT 1`)).toBe('ok')
  }, 60_000)

  it('lets no login become the group every login joins, and gives what that group owned to the project\'s owner role', async () => {
    // A login made now joins backenly_external without SET.
    expect(await canBecome(rw, 'backenly_external')).toBe(false)

    // One from before joined it with SET, and gave the group a function in its
    // schema, which every login then acted as the owner of.
    const l = anotherFromBefore()
    await loginFromBefore(l)
    expect(await canBecome(l.login, 'backenly_external')).toBe(true)
    await q(`GRANT CREATE ON SCHEMA "${l.schema}" TO backenly_external`)
    const c = await login(l.login)
    expect(await attempt(c, `ALTER FUNCTION "${l.schema}".planted() OWNER TO backenly_external`)).toBe('ok')
    await q(`REVOKE CREATE ON SCHEMA "${l.schema}" FROM backenly_external`)
    // And had the owner role give PUBLIC TRIGGER on every table it makes later.
    expect(await as(l.owner, `ALTER DEFAULT PRIVILEGES FOR ROLE ${l.owner} IN SCHEMA "${l.schema}" GRANT TRIGGER ON TABLES TO PUBLIC`)).toBe('ok')
    expect(await sharedHolds(l.schema, l.owner)).toEqual([
      `PUBLIC holds default privileges of ${l.owner} in schema ${l.schema} on tables: TRIGGER`,
      `backenly_external holds ownership of function "${l.schema}".planted()`,
    ])

    await sync(l.schema, l.login, l.owner)

    expect(await canBecome(l.login, 'backenly_external')).toBe(false)
    expect(await functionOwner(l.schema, 'planted')).toBe(l.owner)
    expect(await sharedHolds(l.schema, l.owner)).toEqual([])
    const again = await login(l.login)
    expect(await attempt(again, `ALTER FUNCTION "${l.schema}".planted() SECURITY DEFINER`)).toMatch(/must be owner/)
    expect(await attempt(again, `SET ROLE backenly_external`)).toMatch(/permission denied to set role/)
    expect(await as(l.owner, `CREATE TABLE "${l.schema}".later_public (id int)`)).toBe('ok')
    expect((await q(`SELECT has_table_privilege('public', $1, 'TRIGGER') AS t`, [`"${l.schema}".later_public`]))[0].t).toBe(false)
  }, 60_000)
})

describe('held by a definer that is not a superuser, as on Amazon RDS', () => {
  // RDS gives no superuser. Its master owns the definer functions and holds
  // ADMIN on the roles it created, nothing more. All of this runs in one
  // transaction and is rolled back, so other suites only ever see the functions
  // as installed.
  it('makes a refused login, refuses to allow it schema changes, and strips one from before, keeping no privileges of either', async () => {
    const definer = `bkn_test_definer_${hex}`
    const fresh = `bkn_rw_${randomBytes(6).toString('hex')}`
    await q('BEGIN')
    try {
      await q(`CREATE ROLE ${definer} NOLOGIN NOSUPERUSER CREATEROLE`)
      // ADMIN on the groups the install made, as the master that made them holds it.
      for (const { rolname } of await q(`SELECT rolname FROM pg_roles WHERE rolname IN ('backenly_external', 'backenly_no_schema_changes')`)) {
        await q(`GRANT ${rolname} TO ${definer} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`)
      }
      for (const fn of [
        'backenly_direct_create_role(text, text, text, text)',
        'backenly_direct_set_schema_changes(text, boolean)',
        'backenly_direct_shared_database()',
        'backenly_direct_login_holds(text, text)',
        'backenly_direct_schema_change_holds(text)',
        'backenly_direct_shared_holds(text, text)',
        'backenly_direct_strip_schema_changes(text, text, text)',
        'backenly_direct_end_stripped_sessions(text)',
      ]) {
        await q(`ALTER FUNCTION public.${fn} OWNER TO ${definer}`)
      }

      await q(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_WRITE')`, [fresh, PASSWORD, schema])
      expect(await isMember(fresh, 'backenly_no_schema_changes')).toBe(true)
      await q('SAVEPOINT allow')
      await expect(q(`SELECT public.backenly_direct_set_schema_changes($1, true)`, [fresh])).rejects.toThrow(/shared by several projects/)
      await q('ROLLBACK TO SAVEPOINT allow')

      // A login from before, as this definer made it then: created by it, a
      // member of an owner role the definer administers, granted CREATE and
      // TRIGGER by that owner, and owning a function.
      await q(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_WRITE')`, [onRds.login, PASSWORD, schema])
      await q(`REVOKE backenly_no_schema_changes FROM ${onRds.login} GRANTED BY ${definer}`)
      await q(`CREATE ROLE ${onRds.owner} NOLOGIN`)
      await q(`GRANT ${onRds.owner} TO ${definer} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`)
      await q(`GRANT ${onRds.owner} TO ${onRds.login} GRANTED BY ${definer}`)
      await q(`CREATE SCHEMA "${onRds.schema}" AUTHORIZATION ${onRds.owner}`)
      await q(`CREATE TABLE "${onRds.schema}".orders (id serial PRIMARY KEY, total int)`)
      await q(`ALTER TABLE "${onRds.schema}".orders OWNER TO ${onRds.owner}`)
      await q(`GRANT USAGE, CREATE ON SCHEMA "${onRds.schema}" TO ${onRds.login}`)
      await q(`GRANT TRIGGER ON "${onRds.schema}".orders TO ${onRds.login}`)
      await q(`CREATE FUNCTION "${onRds.schema}".planted() RETURNS int LANGUAGE sql AS 'SELECT 1'`)
      await q(`ALTER FUNCTION "${onRds.schema}".planted() OWNER TO ${onRds.login}`)
      expect((await holds(onRds.login)).length).toBe(4)

      expect(await q(`SELECT public.backenly_direct_strip_schema_changes($1) AS taken`, [onRds.login])).toEqual([{ taken: true }])

      expect(await holds(onRds.login)).toEqual([])
      expect(await isMember(onRds.login, 'backenly_no_schema_changes')).toBe(true)
      expect(await functionOwner(onRds.schema, 'planted')).toBe(onRds.owner)
      // What it granted itself to do this, it took back.
      for (const role of [onRds.login, onRds.owner, fresh]) {
        expect({ role, held: (await q(`SELECT pg_has_role($1, $2, 'USAGE') AS p`, [definer, role]))[0].p }).toEqual({ role, held: false })
      }
    } finally {
      await q('ROLLBACK')
    }
  }, 60_000)
})

describe('on a database dedicated to one project', () => {
  const dedicated = `bkn_dedicated_${hex}`
  const d = { ...legacyNames(), app: `bkn_test_dapp_${hex}` }
  const second = `workspace_${randomUUID()}`
  let dc: Client
  const dq = async (sql: string, params: unknown[] = []) => (await dc.query(sql, params)).rows

  beforeAll(async () => {
    await q(`CREATE DATABASE ${dedicated}`)
    // What a self-hosted install runs (scripts/selfhost.ts), then the helpers.
    install('scripts/sql/dedicated-database.sql', urlFor(dedicated))
    install('scripts/setup-direct-access.sql', urlFor(dedicated))
    dc = new Client({ connectionString: urlFor(dedicated) })
    await dc.connect()
    await dq(`CREATE ROLE ${d.app} NOLOGIN`)
    await dq(`SET backenly.app_role = '${d.app}'`)
    await dq(`CREATE SCHEMA "${d.schema}" AUTHORIZATION ${d.app}`)
    await dq(`CREATE TABLE "${d.schema}".orders (id serial PRIMARY KEY, total int)`)
    await dq(`ALTER TABLE "${d.schema}".orders OWNER TO ${d.app}`)
    await dq(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_WRITE')`, [d.login, PASSWORD, d.schema])
    await sync(d.schema, d.login, d.owner, dc)
  }, 120_000)

  afterAll(async () => {
    await dc?.end().catch(() => {})
    await q(`DROP DATABASE IF EXISTS ${dedicated} WITH (FORCE)`).catch(() => {})
    for (const role of [d.login, d.owner, d.app]) await q(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
  }, 120_000)

  it('is read as dedicated: a superuser marked it, and it holds one project\'s workspace', async () => {
    expect(await shared(dc)).toBe(false)
  })

  it('refuses a new read-write login schema changes until its admin allows them, and then gives them', async () => {
    expect(await asOn(dc, d.login, `CREATE TABLE "${d.schema}".scratch (id int)`)).toMatch(/permission denied for schema/)
    await dq(`SELECT public.backenly_direct_set_schema_changes($1, true)`, [d.login])
    await sync(d.schema, d.login, d.owner, dc)
    expect(await asOn(dc, d.login, `CREATE TABLE "${d.schema}".scratch (id int)`)).toBe('ok')
    expect(await asOn(dc, d.login, `CREATE FUNCTION "${d.schema}".made_here() RETURNS int LANGUAGE sql AS 'SELECT 1'`)).toBe('ok')
    // Installing the file again leaves a dedicated database's logins as they are.
    install('scripts/setup-direct-access.sql', urlFor(dedicated))
    expect(await asOn(dc, d.login, `CREATE TABLE "${d.schema}".scratch_after (id int)`)).toBe('ok')
  }, 120_000)

  it('is shared once a second project\'s workspace is in it, and the login loses its schema changes', async () => {
    await dq(`CREATE SCHEMA "${second}"`)
    expect(await shared(dc)).toBe(true)
    await expect(dq(`SELECT public.backenly_direct_set_schema_changes($1, true)`, [d.login])).rejects.toThrow(/shared by several projects/)
    await sync(d.schema, d.login, d.owner, dc)
    expect(await holds(d.login, dc)).toEqual([])
    expect(await asOn(dc, d.login, `CREATE TABLE "${d.schema}".scratch_shared (id int)`)).toMatch(/permission denied for schema/)
    expect(await functionOwner(d.schema, 'made_here', dc)).toBe(d.owner)
  }, 60_000)
})

describe('through the application', () => {
  it('provisions read-write access that refuses schema changes, and on this shared database cannot allow them', async () => {
    process.env.BACKENLY_EDITION = 'cloud'
    ownerId = (await prisma.user.create({
      data: { email: `rw-login-${hex}@example.test`, password: 'not-a-real-hash', name: 'owner' },
    })).id
    projectId = (await createProvisionedProject({ name: 'read-write-logins', userId: ownerId })).id
    const role = directAccessRoleNames(projectId).rw
    const workspace = `workspace_${projectId}`

    const credential = await provisionDirectAccess(projectId, 'READ_WRITE')
    expect(credential).toMatchObject({ schemaChanges: 'refused', schemaChangesUnavailable: 'shared_database' })
    expect(await as(role, `CREATE TABLE "${workspace}".scratch (id int)`)).toMatch(/permission denied for schema/)

    // The console and the route say why (409), from this error.
    await expect(setSchemaChanges(projectId, true)).rejects.toMatchObject({
      code: 'SCHEMA_CHANGES_UNAVAILABLE',
      reason: 'shared_database',
      message: expect.stringContaining('shared with other projects'),
    })
    expect((await getDirectAccessStatus(projectId)).credentials.find((c) => c.mode === 'READ_WRITE')).toMatchObject({
      schemaChanges: 'refused',
      schemaChangesUnavailable: 'shared_database',
    })
    expect(await as(role, `CREATE TABLE "${workspace}".scratch (id int)`)).toMatch(/permission denied for schema/)
    // Refusing them is still accepted.
    expect(await setSchemaChanges(projectId, false)).toMatchObject({ schemaChanges: 'refused' })
  }, 120_000)

  it('refuses to set it where there is no read-write login', async () => {
    const other = (await createProvisionedProject({ name: 'no-read-write', userId: ownerId })).id
    await expect(setSchemaChanges(other, true)).rejects.toThrow(/no read-write login/)
  }, 120_000)
})
