/**
 * OWNERSHIP IS AN INVARIANT, NOT A HOPE
 * =====================================
 * A fresh install bootstraps THE project before anyone has signed up, so it is
 * created owner-less. That part is fine. What was missing is the other half:
 * nothing adopted the operator once they DID sign up, so `Project.userId` stayed
 * NULL forever and every path keyed on ownership disagreed with every other one.
 *
 * On a clean acceptance machine, one root cause produced three symptoms:
 *
 *   - `npm run bootstrap` exited 1 on the documented "sign up, then rerun"
 *     step. ApiKey.user is required and the anon key had no owner to belong to,
 *     so Prisma answered "Argument `user` is missing".
 *   - GET /api/projects listed ZERO projects to the only account in existence.
 *   - The MCP keys endpoint answered 403 to the operator, while
 *     GET /api/projects/<id> answered 200 for that same project.
 *
 * These run the REAL script against a REAL database, in its own, because the
 * failure was a state the database was allowed to sit in rather than a bad
 * branch. Order matters here: each test is a step in the install's life.
 */

import { execFileSync } from 'child_process'
import { randomUUID, randomBytes } from 'crypto'
import { Client } from 'pg'
import * as fs from 'fs'
import * as path from 'path'
import { PrismaClient } from '@prisma/client'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const DB_NAME = `backenly_owner_jest_${randomBytes(3).toString('hex')}`

let dbUrl = ''
let prisma: PrismaClient | null = null

function urlForDatabase(base: string, name: string): string {
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!ADMIN_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = ADMIN_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
}

async function adminExec(query: string): Promise<void> {
  const client = new Client({ connectionString: urlForDatabase(ADMIN_URL!, 'postgres') })
  await client.connect()
  try {
    await client.query(query)
  } finally {
    await client.end()
  }
}

/**
 * CI has neither PostgREST nor the superuser-installed role helpers, so the
 * healthy outcome is 3 (core bootstrapped, a required prerequisite unmet) and
 * 0 once they are present. What must never appear is 1, the unhandled crash.
 */
const BOOTSTRAPPED = [0, 3]

function runBootstrap(env: Record<string, string> = {}): { out: string; code: number } {
  try {
    const out = execFileSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'scripts/bootstrap.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: dbUrl,
          DIRECT_URL: dbUrl,
          BACKENLY_EDITION: 'single-tenant',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    return { out, code: 0 }
  } catch (err: any) {
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 }
  }
}

beforeAll(async () => {
  assertSafeTestDatabase()
  dbUrl = urlForDatabase(ADMIN_URL!, DB_NAME)

  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME}`)
  await adminExec(`CREATE DATABASE ${DB_NAME}`)

  execFileSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'db', 'push', '--accept-data-loss', '--skip-generate'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl }, stdio: 'ignore' },
  )

  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
}, 240_000)

afterAll(async () => {
  await prisma?.$disconnect()
  prisma = null
  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
}, 60_000)

describe('single-tenant ownership', () => {
  let operatorId = ''

  it('bootstraps owner-less when nobody has signed up yet', async () => {
    const r = runBootstrap()
    expect(BOOTSTRAPPED).toContain(r.code)

    const p = await prisma!.project.findFirst({ select: { userId: true } })
    // Not a defect: there is nobody to own it. What matters is that this state
    // is temporary and does not wedge the install.
    expect(p!.userId).toBeNull()
  }, 240_000)

  it('adopts the first operator on the next run, and issues the anon key', async () => {
    const u = await prisma!.user.create({
      data: { email: `op-${randomUUID()}@test.invalid`, name: 'Operator' },
      select: { id: true },
    })
    operatorId = u.id

    const r = runBootstrap()

    // THE regression. Exit 1 is the crash this file exists for, and it is not
    // one of the documented states.
    expect(r.code).not.toBe(1)
    expect(r.out).not.toContain('Argument `user` is missing')
    expect(BOOTSTRAPPED).toContain(r.code)

    const p = await prisma!.project.findFirst({ select: { userId: true, anonKey: true } })
    expect(p!.userId).toBe(operatorId)
    expect(p!.anonKey).toBeTruthy()

    // The key has to belong to somebody: ApiKey.user is a required relation,
    // which is precisely why a NULL owner crashed rather than degraded.
    const key = await prisma!.apiKey.findFirst({ where: { name: 'Anon Key' }, select: { userId: true } })
    expect(key!.userId).toBe(operatorId)
  }, 240_000)

  it('lists THE project for an account that does not own it', async () => {
    // Probed with a NON-owner on purpose.
    //
    // Probing with the owner proved nothing: by this point adoption has set
    // Project.userId, so an ownership filter matches too and the test passed
    // with the bug reintroduced. Verified by mutation — that is how this was
    // caught. On a self-hosted deployment every authenticated account is an
    // operator, so a second account must see THE project as well, and only a
    // clause that ignores ownership can do that.
    const other = await prisma!.user.create({
      data: { email: `viewer-${randomUUID()}@test.invalid`, name: 'Viewer' },
      select: { id: true },
    })
    const probeUserId = other.id
    //
    // Run in a subprocess because the resolver uses the shared Prisma client,
    // which binds to DATABASE_URL at import — the same reason bootstrap itself
    // is exercised as a subprocess in this file rather than imported.
    const probe = path.join(process.cwd(), `.owner-probe-${randomBytes(3).toString('hex')}.ts`)
    fs.writeFileSync(
      probe,
      [
        `import { getProjectResolver } from '@/lib/edition'`,
        `import { prisma } from '@/lib/db'`,
        `getProjectResolver()`,
        `  .accessibleProjectsWhere(process.argv[2])`,
        `  .then(w => prisma.project.findMany({ where: w as any, select: { id: true } }))`,
        `  .then(rows => { console.log('VISIBLE=' + rows.length); return prisma.$disconnect() })`,
        `  .catch(e => { console.log('ERROR=' + e.message); process.exit(1) })`,
        ``,
      ].join('\n'),
      'utf8',
    )
    try {
      const out = execFileSync(
        process.execPath,
        ['node_modules/tsx/dist/cli.mjs', probe, probeUserId],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            DATABASE_URL: dbUrl,
            DIRECT_URL: dbUrl,
            BACKENLY_EDITION: 'single-tenant',
          },
        },
      )
      expect(out).toContain('VISIBLE=1')
    } finally {
      fs.rmSync(probe, { force: true })
    }
  }, 240_000)

  it('never moves ownership once it is set', async () => {
    const before = await prisma!.project.findFirst({ select: { userId: true } })
    expect(before!.userId).toBe(operatorId)

    // A second account is not a takeover attempt, but it must not become one.
    await prisma!.user.create({
      data: { email: `second-${randomUUID()}@test.invalid`, name: 'Second' },
      select: { id: true },
    })

    const r = runBootstrap()
    expect(BOOTSTRAPPED).toContain(r.code)

    const after = await prisma!.project.findFirst({ select: { userId: true } })
    expect(after!.userId).toBe(before!.userId)
  }, 240_000)

  it('reruns without changing the owner or reissuing the key', async () => {
    const before = await prisma!.project.findFirst({ select: { userId: true, anonKey: true } })

    const r = runBootstrap()
    expect(BOOTSTRAPPED).toContain(r.code)

    const after = await prisma!.project.findFirst({ select: { userId: true, anonKey: true } })
    expect(after!.userId).toBe(before!.userId)
    // Reissuing on every rerun would invalidate every frontend that embedded it.
    expect(after!.anonKey).toBe(before!.anonKey)
  }, 240_000)
})
