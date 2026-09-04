/**
 * BOOTSTRAP IS A RECONCILER, NOT AN INSTALLER
 * ===========================================
 * Self-hosters rerun bootstrap. CI reruns it. Upgrades will eventually rerun
 * parts of it. So "works once against a pristine database" is not the bar; the
 * bar is that a second run changes nothing and a damaged deployment is repaired
 * rather than duplicated or refused.
 *
 * These run the REAL script against a REAL database of their own, because
 * everything worth asserting here is a side effect on Postgres: a schema that
 * exists, a row that was not duplicated, a refusal that happened before
 * anything was written. A mocked Prisma client models none of that.
 *
 * The database is created and dropped by this suite. It cannot share the shared
 * test database: bootstrap counts projects globally, and the shared one holds
 * many, which is itself asserted below as the incompatible-database case.
 */

import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { Client } from 'pg'
import { PrismaClient } from '@prisma/client'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const DB_NAME = 'backenly_bootstrap_jest'

function urlForDatabase(base: string, name: string): string {
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

let bootstrapUrl = ''
let prisma: PrismaClient | null = null

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!ADMIN_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = ADMIN_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
}

/**
 * Readiness is a state machine, so the tests below assert the STATE rather than
 * a bare zero:
 *
 *   0  ready
 *   2  refused, nothing written
 *   3  core bootstrapped, prerequisites unmet
 *
 * CI has neither PostgREST nor the superuser-installed role helpers, so the
 * healthy outcome here is 3. Asserting 0 would either fail on every run or
 * force the script to lie about readiness, and the whole point of the state
 * machine is that deployment automation can tell the two apart.
 */
const BOOTSTRAPPED = [0, 3]

/** Run the real script. Returns stdout+stderr and the exit code. */
function runBootstrap(env: Record<string, string> = {}): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/bootstrap.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: bootstrapUrl,
        DIRECT_URL: bootstrapUrl,
        BACKENLY_EDITION: 'single-tenant',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { out, code: 0 }
  } catch (err: any) {
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 }
  }
}

async function adminExec(sql: string): Promise<void> {
  const client = new Client({ connectionString: urlForDatabase(ADMIN_URL!, 'postgres') })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

beforeAll(async () => {
  assertSafeTestDatabase()
  bootstrapUrl = urlForDatabase(ADMIN_URL!, DB_NAME)

  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME}`)
  await adminExec(`CREATE DATABASE ${DB_NAME}`)

  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--accept-data-loss', '--skip-generate'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: bootstrapUrl, DIRECT_URL: bootstrapUrl },
    stdio: 'ignore',
  })

  prisma = new PrismaClient({ datasources: { db: { url: bootstrapUrl } } })
}, 180_000)

afterAll(async () => {
  await prisma?.$disconnect()
  prisma = null
  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
}, 60_000)

const projectCount = () => prisma!.project.count()
const theProject = () => prisma!.project.findFirst({ select: { id: true, activeGraphId: true, jwtSecret: true } })

async function schemaExists(schema: string): Promise<boolean> {
  const rows = await prisma!.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}) AS exists
  `
  return rows[0]?.exists === true
}

describe('bootstrap', () => {
  it('provisions a working project on a fresh database', async () => {
    const r = runBootstrap()
    expect(BOOTSTRAPPED).toContain(r.code)

    expect(await projectCount()).toBe(1)
    const p = await theProject()
    expect(p).not.toBeNull()

    // A Project row is not a project. These are what make it usable.
    expect(p!.activeGraphId).toBeTruthy()
    expect(p!.jwtSecret).toBeTruthy()
    expect(await schemaExists(`workspace_${p!.id}`)).toBe(true)
    const workspace = await prisma!.workspace.findFirst({ where: { projectId: p!.id } })
    expect(workspace?.postgresSchema).toBe(`workspace_${p!.id}`)

    // No Plan and no Subscription: self-hosted entitlements resolve without
    // billing tables, so an unseeded database is fully operational.
    expect(await prisma!.plan.count()).toBe(0)
    expect(await prisma!.subscription.count()).toBe(0)
  }, 180_000)

  it('changes nothing on a second run', async () => {
    const before = await theProject()

    const r = runBootstrap()
    expect(BOOTSTRAPPED).toContain(r.code)

    expect(await projectCount()).toBe(1)
    const after = await theProject()
    expect(after!.id).toBe(before!.id)
    // Identity must not drift: the id is baked into the schema name, the bkn_*
    // role names, storage paths and every /api/v1/<id>/ URL.
    expect(after!.activeGraphId).toBe(before!.activeGraphId)
    expect(after!.jwtSecret).toBe(before!.jwtSecret)

    expect(r.out).toContain('already present')
    expect(r.out).not.toContain('project row                                                      created')
  }, 180_000)

  it('repairs a missing workspace schema without touching anything else', async () => {
    const before = await theProject()
    const schema = `workspace_${before!.id}`
    await prisma!.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    expect(await schemaExists(schema)).toBe(false)

    const r = runBootstrap()
    expect(BOOTSTRAPPED).toContain(r.code)

    expect(await schemaExists(schema)).toBe(true)
    expect(await projectCount()).toBe(1)
    const after = await theProject()
    expect(after!.id).toBe(before!.id)
    expect(after!.jwtSecret).toBe(before!.jwtSecret)
  }, 180_000)

  it('repairs a missing backend graph', async () => {
    const before = await theProject()
    await prisma!.project.update({ where: { id: before!.id }, data: { activeGraphId: null } })

    const r = runBootstrap()
    expect(BOOTSTRAPPED).toContain(r.code)

    const after = await theProject()
    expect(after!.activeGraphId).toBeTruthy()
    expect(await projectCount()).toBe(1)
  }, 180_000)

  it('refuses a pinned id that does not exist beside a different project', async () => {
    const before = await theProject()

    const r = runBootstrap({ BACKENLY_PROJECT_ID: randomUUID() })

    expect(r.code).toBe(2)
    expect(r.out).toContain('BACKENLY_PROJECT_ID_MISMATCH')
    // The point of the refusal: an environment variable changing must not
    // silently produce a second project.
    expect(await projectCount()).toBe(1)
    expect((await theProject())!.id).toBe(before!.id)
  }, 180_000)

  it('reports NOT ready, with exit 3, while prerequisites are missing', async () => {
    // The distinction that matters to deployment automation: a run that
    // provisioned the core but could not register the data plane is not a
    // successful install, and must not be readable as one.
    const r = runBootstrap()

    expect(r.code).toBe(3)
    expect(r.out).toContain('NOT yet ready')
    expect(r.out).toMatch(/PostgREST/)
    // And it says what to do, rather than only what is wrong.
    expect(r.out).toContain('npm run bootstrap')
  }, 180_000)

  it('refuses a database that holds more than one project, and writes nothing', async () => {
    const owner = await prisma!.user.create({
      data: { email: `boot-${randomUUID()}@test.invalid`, name: 'Boot' },
      select: { id: true },
    })
    const intruder = await prisma!.project.create({
      data: { name: 'second project', userId: owner.id },
      select: { id: true },
    })

    const r = runBootstrap()

    expect(r.code).toBe(2)
    expect(r.out).toContain('BACKENLY_SINGLE_TENANT_INVALID_DATABASE')
    expect(r.out).toContain('found 2')
    // Never chooses one, never deletes one, never downgrades.
    expect(await projectCount()).toBe(2)

    await prisma!.project.delete({ where: { id: intruder.id } })
    await prisma!.user.delete({ where: { id: owner.id } })
  }, 180_000)
})
