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
    // A definition calling a built-in nothing can take back, for a person.
    expect(report.review).toEqual([
      { projectId: projectA, schema: A, kind: 'policy', name: 'marks_mark on marks', builtins: ['set_config'] },
    ])
  })

  it('switches every one of them off, as the platform\'s role, and reads them back off', async () => {
    const live = [...new Set((await stillRunning(platform, report.planted, facts)).map((l) => l.object))]
    expect(live).toHaveLength(5)
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
    ].sort())
    expect(await stillRunning(platform, report.planted, facts)).toEqual([])
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
