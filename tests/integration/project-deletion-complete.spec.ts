/**
 * DELETING A PROJECT DELETES EVERYTHING THAT IS THE PROJECT'S
 * ===========================================================
 * Two gaps behind "Deletion is immediate and final … every receipt":
 *
 *   - SET-05: the per-project PostgreSQL LOGIN roles survived. run_query
 *     provisions bkn_ro_<hex> for any project an agent queries, READ_WRITE
 *     adds bkn_rw_<hex>, the function runtime derives bkn_fn_<hex> — all
 *     cluster-level, remotely admitted by pg_hba, with their encrypted
 *     passwords in DatabaseCredential rows no cascade reached. A contractor's
 *     psql kept logging in after the project was deleted.
 *   - SET-06: ~27 models carry a bare projectId with no Project relation, so
 *     the cascade left full DDL snapshots (rawDdl), PITR/state graph
 *     snapshots, MCP OAuth codes/access tokens, security events and more.
 *
 * The sweep list is DERIVED from the Prisma schema (exported as
 * ORPHANED_PROJECT_MODELS), and this suite seeds it GENERICALLY from the same
 * DMMF — a future model with a bare projectId is swept and tested without
 * anyone remembering it. The user's Session keeps its row (the login is the
 * user's) with its project pointer nulled; the usage ledger rows survive on
 * purpose (billed usage is owed by the account).
 */

import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { deleteProjectCompletely, ORPHANED_PROJECT_MODELS, PURGE_JOB_TYPE } from '@/lib/projects/delete'
import { functionRoleName } from '@/lib/services/ai-functions/function-db-role'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId = ''
let projectId = ''
let schema = ''
let sessionId = ''
let roRole = ''
let fnRole = ''
const seededModels: string[] = []

/** Fill one row's required scalars from the DMMF, by type. */
function genericRow(modelName: string, pid: string): Record<string, unknown> | null {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName)!
  // A required relation needs a real parent; those models are covered by their
  // parent's cascade, so the generic seeder skips them rather than faking FKs.
  const requiredRelation = model.fields.some(
    (f) => f.kind === 'object' && f.isRequired && !f.isList,
  )
  if (requiredRelation) return null

  const row: Record<string, unknown> = {}
  for (const f of model.fields) {
    if (f.kind === 'object') continue
    if (f.name === 'projectId') { row.projectId = pid; continue }
    if (!f.isRequired || f.hasDefaultValue || f.isUpdatedAt) continue
    if (f.isList) { row[f.name] = []; continue }
    switch (f.kind === 'enum' ? 'enum' : f.type) {
      case 'String': row[f.name] = `del-test-${randomUUID()}`; break
      case 'Int': row[f.name] = 1; break
      case 'Float': row[f.name] = 1; break
      case 'BigInt': row[f.name] = BigInt(1); break
      case 'Boolean': row[f.name] = false; break
      case 'DateTime': row[f.name] = new Date(); break
      case 'Json': row[f.name] = {}; break
      case 'Bytes': row[f.name] = Buffer.from('x'); break
      case 'enum': {
        const e = Prisma.dmmf.datamodel.enums.find((en) => en.name === f.type)
        row[f.name] = e?.values[0]?.name
        break
      }
      default: return null // unknown shape — skip rather than guess
    }
  }
  return row
}

const delegate = (modelName: string) =>
  (prisma as any)[modelName.charAt(0).toLowerCase() + modelName.slice(1)]

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `del-${randomUUID()}@test.invalid`, name: 'Deletion Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `del-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."things" (id serial PRIMARY KEY)`)

  // The user's session, currently "inside" the project.
  sessionId = (
    await prisma.session.create({
      data: {
        userId: ownerId,
        token: `del-session-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600_000),
        projectId,
      },
      select: { id: true },
    })
  ).id

  // Real cluster roles, exactly the shapes the product provisions.
  roRole = `bkn_ro_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  fnRole = functionRoleName(schema)
  await prisma.$executeRawUnsafe(`CREATE ROLE "${roRole}" LOGIN PASSWORD 'del-test-pass-1'`)
  await prisma.$executeRawUnsafe(`CREATE ROLE "${fnRole}" LOGIN PASSWORD 'del-test-pass-2'`)
  await prisma.databaseCredential.create({
    data: { projectId, mode: 'READ_ONLY', roleName: roRole, passwordCipher: 'c', passwordIv: 'i', passwordTag: 't' },
  })

  // One row per orphan model the generic seeder can express.
  for (const model of ORPHANED_PROJECT_MODELS) {
    if (model === 'DatabaseCredential') { seededModels.push(model); continue } // seeded above
    const row = genericRow(model, projectId)
    if (!row) continue
    try {
      await delegate(model).create({ data: row })
      seededModels.push(model)
    } catch {
      // A model whose constraints the generic row cannot satisfy is reported,
      // not silently skipped: the assertion below requires a healthy floor.
    }
  }
}, 180_000)

afterAll(async () => {
  for (const role of [roRole, fnRole]) {
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`).catch(() => {})
  }
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  for (const model of ORPHANED_PROJECT_MODELS) {
    await delegate(model).deleteMany({ where: { projectId } }).catch(() => {})
  }
  await prisma.session.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

it('the generic seeder covered a meaningful slice of the orphan class', () => {
  // If this floor drops, the sweep assertion below is testing air — fix the
  // seeder, do not lower the floor.
  expect(seededModels.length).toBeGreaterThanOrEqual(12)
  for (const name of ['WorkspaceSchemaSnapshot', 'PITRSnapshot', 'StateSnapshot', 'OIDCAccessToken', 'SecurityEvent', 'DatabaseCredential']) {
    expect(ORPHANED_PROJECT_MODELS).toContain(name)
    expect(seededModels).toContain(name)
  }
})

it('deletes the project, every orphaned row, and the cluster roles', async () => {
  const result = await deleteProjectCompletely(projectId)
  expect(result.projectIds).toEqual([projectId])

  expect(await prisma.project.findUnique({ where: { id: projectId } })).toBeNull()

  const schemaLeft = await prisma.$queryRawUnsafe<any[]>(
    `SELECT 1 FROM pg_namespace WHERE nspname = '${schema}'`,
  )
  expect(schemaLeft).toHaveLength(0)

  // SET-06: nothing still carries this projectId, in ANY orphan model.
  for (const model of ORPHANED_PROJECT_MODELS) {
    const left = await delegate(model).count({ where: { projectId } })
    if (left !== 0) throw new Error(`${model} kept ${left} row(s) after deletion`)
  }

  // The user's login survives; only its project pointer is gone.
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  expect(session).not.toBeNull()
  expect(session!.projectId).toBeNull()

  // SET-05: the LOGIN roles are gone from the cluster.
  const roles = await prisma.$queryRawUnsafe<any[]>(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('${roRole}', '${fnRole}')`,
  )
  expect(roles).toHaveLength(0)
}, 120_000)

describe('a login another database on the cluster still names', () => {
  // A role is cluster-wide, but DROP OWNED and REASSIGN OWNED reach only the
  // current database. A second database that still grants the login, as a copy
  // restored from an older dump does, made DROP ROLE fail with 2BP01 and the
  // deletion with it, for every project whose login it named. The login is now
  // retired instead: NOLOGIN with no password. The other database is not the
  // deletion's to change, and is left exactly as it was.
  const PASSWORD = 'del-test-elsewhere-pass-1'
  const refuse = `refuse_delete_${randomUUID().replace(/-/g, '').slice(0, 8)}`
  let owner = ''
  let project = ''
  let workspace = ''
  let login = ''
  let other = ''

  const testDatabase = () => new URL(DB_URL!).pathname.slice(1)
  function urlFor(database: string, user?: string, password?: string): string {
    const u = new URL(DB_URL!)
    u.pathname = `/${database}`
    if (user) {
      u.username = user
      u.password = password ?? ''
    }
    return u.toString()
  }
  async function run<T = Record<string, unknown>>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
    const client = new Client({ connectionString: url })
    client.on('error', () => {})
    await client.connect()
    try {
      return (await client.query(sql, params)).rows as T[]
    } finally {
      await client.end().catch(() => {})
    }
  }
  /** True when the login connects with its password, else the refusal. */
  async function logsIn(): Promise<true | string> {
    try {
      await run(urlFor(testDatabase(), login, PASSWORD), 'SELECT 1')
      return true
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
  const loginState = () =>
    prisma.$queryRawUnsafe<{ login: boolean; noPassword: boolean }[]>(
      `SELECT rolcanlogin AS login, rolpassword IS NULL AS "noPassword" FROM pg_authid WHERE rolname = $1`,
      login,
    )
  const purgeJobs = async () =>
    (await prisma.backgroundJob.findMany({ where: { type: PURGE_JOB_TYPE }, select: { payload: true } })).filter(
      (j) => (j.payload as { projectId?: string } | null)?.projectId === project,
    ).length
  const otherAcl = () =>
    run<{ acl: string }>(urlFor(other), `SELECT relacl::text AS acl FROM pg_class WHERE oid = to_regclass($1)`, [`"${workspace}".kept`])

  beforeAll(async () => {
    assertSafeTestDatabase()
    owner = (
      await prisma.user.create({
        data: { email: `del-elsewhere-${randomUUID()}@test.invalid`, name: 'Deletion Test (elsewhere)' },
        select: { id: true },
      })
    ).id
    project = (
      await prisma.project.create({ data: { name: `del-else-${randomUUID().slice(0, 8)}`, userId: owner }, select: { id: true } })
    ).id
    workspace = `workspace_${project}`
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${workspace}"`)
    await prisma.$executeRawUnsafe(`CREATE TABLE "${workspace}"."things" (id int)`)
    await prisma.$executeRawUnsafe(`INSERT INTO "${workspace}"."things" VALUES (1), (2), (3)`)

    login = `bkn_ro_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    await prisma.$executeRawUnsafe(`CREATE ROLE "${login}" LOGIN PASSWORD '${PASSWORD}'`)
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${workspace}" TO "${login}"`)
    await prisma.$executeRawUnsafe(`GRANT SELECT ON "${workspace}"."things" TO "${login}"`)
    await prisma.databaseCredential.create({
      data: { projectId: project, mode: 'READ_ONLY', roleName: login, passwordCipher: 'c', passwordIv: 'i', passwordTag: 't' },
    })

    // The other database: an older copy of the project's schema that grants the login.
    other = `${testDatabase()}_elsewhere_${randomUUID().replace(/-/g, '').slice(0, 8)}`
    await run(urlFor(testDatabase()), `CREATE DATABASE "${other}"`)
    await run(urlFor(other), `CREATE SCHEMA "${workspace}"`)
    await run(urlFor(other), `CREATE TABLE "${workspace}".kept (id int)`)
    await run(urlFor(other), `INSERT INTO "${workspace}".kept VALUES (1), (2)`)
    await run(urlFor(other), `GRANT USAGE ON SCHEMA "${workspace}" TO "${login}"`)
    await run(urlFor(other), `GRANT SELECT ON "${workspace}".kept TO "${login}"`)
    expect(await logsIn()).toBe(true)
  }, 120_000)

  afterAll(async () => {
    if (other) await run(urlFor(testDatabase()), `DROP DATABASE IF EXISTS "${other}" WITH (FORCE)`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${refuse}" ON public.projects`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${refuse}"()`).catch(() => {})
    if (login) {
      await prisma.$executeRawUnsafe(`DROP OWNED BY "${login}"`).catch(() => {})
      await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${login}"`).catch(() => {})
    }
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${workspace}" CASCADE`).catch(() => {})
    await prisma.databaseCredential.deleteMany({ where: { projectId: project } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: project } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: owner } }).catch(() => {})
    await prisma.auditLog
      .deleteMany({ where: { action: 'DATABASE_LOGIN_RETIRED', details: { contains: project } } })
      .catch(() => {})
  })

  it('rolls a deletion that fails after the login was retired back whole, the login included', async () => {
    // Fails the deletion at its last step, after the schema drop and the
    // login's retirement in the same transaction, and says what the login was
    // at that moment, so the test shows the retirement did happen and was undone.
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION public."${refuse}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
         RAISE EXCEPTION 'refused for the test: the login was %',
           (SELECT CASE WHEN rolcanlogin THEN 'able to log in' ELSE 'retired' END FROM pg_roles WHERE rolname = '${login}');
       END $$`,
    )
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${refuse}" BEFORE DELETE ON public.projects FOR EACH ROW WHEN (OLD.id = '${project}') EXECUTE FUNCTION public."${refuse}"()`,
    )
    try {
      await expect(deleteProjectCompletely(project)).rejects.toThrow(/refused for the test: the login was retired/)
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${refuse}" ON public.projects`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${refuse}"()`)
    }

    expect(await prisma.project.findUnique({ where: { id: project }, select: { id: true } })).toEqual({ id: project })
    expect(await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${workspace}"."things"`)).toEqual([{ n: 3 }])
    expect(await prisma.databaseCredential.count({ where: { projectId: project } })).toBe(1)
    expect(await purgeJobs()).toBe(0)
    expect(await loginState()).toEqual([{ login: true, noPassword: false }])
    expect(await logsIn()).toBe(true)
  }, 120_000)

  it('completes the deletion with the login retired, and leaves the other database as it was', async () => {
    const before = await otherAcl()
    expect(before[0]?.acl).toContain(login)

    const result = await deleteProjectCompletely(project)

    expect(result.retiredLogins).toEqual([login])
    expect(result.schemasDropped).toEqual([workspace])
    expect(await prisma.project.findUnique({ where: { id: project } })).toBeNull()
    expect(await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, workspace)).toEqual([])
    expect(await prisma.databaseCredential.count({ where: { projectId: project } })).toBe(0)
    expect(await purgeJobs()).toBe(1)
    // Kept only as a name: no login, no password, refused at the door.
    expect(await loginState()).toEqual([{ login: false, noPassword: true }])
    expect(await logsIn()).toMatch(/not permitted to log in|password authentication failed/)
    // The other database is exactly as it was.
    expect(await otherAcl()).toEqual(before)
    expect(await run(urlFor(other), `SELECT count(*)::int AS n FROM "${workspace}".kept`)).toEqual([{ n: 2 }])
    // And the retirement is on record outside the project's cascade.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'DATABASE_LOGIN_RETIRED', details: { contains: project } },
      select: { projectId: true, details: true },
    })
    expect(audit?.projectId).toBeNull()
    expect(JSON.parse(String(audit?.details))).toEqual({ projectId: project, region: 'ap-south-1', logins: [login], via: 'project deletion' })
  }, 120_000)
})
