/**
 * WHAT A NEW SELF-HOSTER SEES ON THE EXPECTED FIRST RUN
 * ====================================================
 * The first run of `npm run bootstrap` is DOCUMENTED to exit 3. It is not a
 * failure, it is the reconciler reporting which superuser steps remain. But it
 * used to print four raw Prisma error blocks before its summary, because it
 * discovered the optional direct-access helpers were missing by calling them
 * and catching the failure — and Prisma logs every failed query at `error`
 * level before the caller's catch ever runs.
 *
 * So the documented happy path opened with stack-shaped error text and read as
 * a crash. That is the first impression of the whole product for anyone
 * installing it, which is why it is worth a test of its own.
 *
 * This asserts the OUTPUT, not just the exit code, because the exit code was
 * always correct. The defect was entirely in what the operator read.
 *
 * Runs the real script against a real database of its own, for the same reason
 * as the sibling suite: the thing under test is a side effect on Postgres and
 * the text produced while reconciling it. A mocked client reproduces neither.
 */

import { execFileSync } from 'child_process'
import { Client } from 'pg'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const DB_NAME = 'backenly_install_output_jest'

function urlForDatabase(base: string, name: string): string {
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

let bootstrapUrl = ''

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!ADMIN_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = ADMIN_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
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

/**
 * Both streams, kept separate and also joined.
 *
 * The sibling helper returns stdout alone on success, which would have made
 * this defect invisible: Prisma's error log goes to stderr, and the run that
 * carried it exited 3 rather than throwing.
 */
function runBootstrap(): { stdout: string; stderr: string; all: string; code: number } {
  const opts = {
    cwd: process.cwd(),
    encoding: 'utf8' as const,
    env: {
      ...process.env,
      DATABASE_URL: bootstrapUrl,
      DIRECT_URL: bootstrapUrl,
      BACKENLY_EDITION: 'single-tenant',
    },
    stdio: ['ignore', 'pipe', 'pipe'] as const,
  }
  try {
    const stdout = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/bootstrap.ts'], opts)
    return { stdout, stderr: '', all: stdout, code: 0 }
  } catch (err: any) {
    const stdout = String(err.stdout ?? '')
    const stderr = String(err.stderr ?? '')
    return { stdout, stderr, all: stdout + stderr, code: err.status ?? 1 }
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
}, 180_000)

afterAll(async () => {
  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
}, 60_000)

describe('the first bootstrap a self-hoster runs', () => {
  let run: ReturnType<typeof runBootstrap>

  beforeAll(() => {
    run = runBootstrap()
  }, 180_000)

  it('prints no raw Prisma error block on its documented path', () => {
    // The exact shapes Prisma emits. Matched individually so a failure names
    // which one came back rather than just "output changed".
    const prismaNoise = [
      'Invalid `prisma.$queryRaw()` invocation',
      'PrismaClientKnownRequestError',
      'PrismaClientUnknownRequestError',
      'Raw query failed',
      'prisma:error',
    ]
    for (const marker of prismaNoise) {
      expect(run.all).not.toContain(marker)
    }
  })

  it('never surfaces the missing helper as a database error', () => {
    // The underlying Postgres text. Its presence would mean the failing query
    // was issued after all, whatever wrapper printed it.
    expect(run.all).not.toContain('backenly_direct_create_role')
    expect(run.all).not.toMatch(/function .* does not exist/i)
  })

  it('says once, in a sentence, what is missing and how to install it', () => {
    // One advisory, not one per mode. The old code produced two of these and
    // two error blocks; the count is the regression.
    const advisories = run.all.match(/privileged role helpers are not installed/g) ?? []
    expect(advisories).toHaveLength(1)

    expect(run.all).toContain('bash scripts/install-sql.sh scripts/setup-direct-access.sql')
    expect(run.all).toMatch(/READ_ONLY/)
    expect(run.all).toMatch(/READ_WRITE/)
  })

  it('prints the warning that every "skipped (see warning)" line promises', () => {
    // The step lines and the warning block were rendered by different code
    // paths, and the advisory block was inline on the READY path only. So the
    // first run — the one that exits 3 by design, and the only one anybody
    // reads carefully — listed steps as "skipped (see warning)" and then
    // printed no such warning. A pointer to nothing is worse than silence.
    const skipped = run.all.match(/skipped \(see warning\)/g) ?? []
    expect(skipped.length).toBeGreaterThan(0)

    // Every skip is explained by one of the two blocks bootstrap prints.
    expect(run.all).toContain('Optional, not installed:')
    expect(run.all).toContain('NOT yet ready — unmet prerequisites:')
  })

  it('still reports NOT ready, with the documented exit code', () => {
    // The output fix must not have quieted a real state. 3 means prerequisites
    // remain; a 0 here would mean the advisory stopped being tracked.
    expect(run.code).toBe(3)
  })

  it('is a reconciler: the second run says the same thing and changes nothing', () => {
    const again = runBootstrap()
    expect(again.code).toBe(3)
    for (const marker of ['Invalid `prisma.$queryRaw()` invocation', 'prisma:error']) {
      expect(again.all).not.toContain(marker)
    }
    const advisories = again.all.match(/privileged role helpers are not installed/g) ?? []
    expect(advisories).toHaveLength(1)
  }, 180_000)
})
