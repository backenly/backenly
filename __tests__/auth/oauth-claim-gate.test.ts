/**
 * AN OAUTH SIGN-IN CANNOT CLAIM A SELF-HOSTED DEPLOYMENT
 * ======================================================
 * A self-hosted install is claimed by the first account that presents the
 * setup token `npm run selfhost` printed. The email signup has enforced that
 * since #50. The Google and GitHub callbacks never asked: on an install with
 * OAuth configured, the first "Sign up with Google" created the account, and a
 * single-tenant deployment treats any signed-in account as its operator. The
 * administrator slot went to whoever clicked first - the exact outcome the
 * token exists to prevent.
 *
 * `oauthMayCreateAccount` is the gate every callback now consults before
 * creating an account (the ordering is pinned in
 * tests/unit/oauth-verified-email.spec.ts). What it decides is asserted here.
 *
 * Its own database, because the case that matters needs a users table with
 * ZERO rows, which a shared database cannot guarantee. Its own process too,
 * because the gate reaches the Prisma singleton, which binds to DATABASE_URL
 * at import. Same shape as first-operator-admission.test.ts, for the same
 * reasons.
 *
 * Two-sided: the refusal sits beside the three states where creating an
 * account must still work, so it cannot pass by refusing everything.
 */
import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { Client } from 'pg'
import * as fs from 'fs'
import * as path from 'path'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const DB_NAME = `backenly_oauthgate_jest_${randomBytes(3).toString('hex')}`
const TOKEN = randomBytes(32).toString('hex')
let dbUrl = ''
let probe = ''

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

async function run(connectionString: string, query: string): Promise<void> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query(query)
  } finally {
    await client.end()
  }
}

/** Ask the real gate, in a process bound to the scratch database. */
function mayCreate(env: { edition: string; token: string | null }): boolean {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: dbUrl,
    DIRECT_URL: dbUrl,
    BACKENLY_EDITION: env.edition,
  }
  // Absent, not empty: a real install without a token has no such key.
  if (env.token === null) delete childEnv.BACKENLY_SETUP_TOKEN
  else childEnv.BACKENLY_SETUP_TOKEN = env.token

  const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', probe], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: childEnv,
  })
  const m = out.match(/MAY_CREATE=(true|false)/)
  if (!m) throw new Error(`the probe did not answer: ${out}`)
  return m[1] === 'true'
}

beforeAll(async () => {
  assertSafeTestDatabase()
  dbUrl = urlForDatabase(ADMIN_URL!, DB_NAME)

  const admin = urlForDatabase(ADMIN_URL!, 'postgres')
  await run(admin, `DROP DATABASE IF EXISTS ${DB_NAME}`)
  await run(admin, `CREATE DATABASE ${DB_NAME}`)
  execFileSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'db', 'push', '--accept-data-loss', '--skip-generate'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl }, stdio: 'ignore' },
  )

  probe = path.join(process.cwd(), `.oauth-gate-probe-${randomBytes(3).toString('hex')}.ts`)
  fs.writeFileSync(
    probe,
    [
      `import { oauthMayCreateAccount } from '@/lib/auth/setup-token'`,
      `import { prisma } from '@/lib/db'`,
      `oauthMayCreateAccount()`,
      `  .then(v => { console.log('MAY_CREATE=' + v) })`,
      `  .catch(e => { console.log('GATE_ERROR=' + e.message) })`,
      `  .finally(() => prisma.$disconnect())`,
      ``,
    ].join('\n'),
    'utf8',
  )
}, 240_000)

afterAll(async () => {
  if (probe) fs.rmSync(probe, { force: true })
  await run(urlForDatabase(ADMIN_URL!, 'postgres'), `DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
}, 60_000)

describe('an unclaimed, token-gated self-hosted deployment', () => {
  it('refuses to let OAuth create the first account', () => {
    // The attack: zero users, a token configured, and a stranger with a
    // Google account. Before this gate, they became the operator.
    expect(mayCreate({ edition: 'single-tenant', token: TOKEN })).toBe(false)
  }, 120_000)
})

describe('where OAuth may still create accounts', () => {
  it('allows it on an install that configured no token', () => {
    // Installs predating the token keep working, and there a provider-verified
    // address is the same proof an emailed code would be.
    expect(mayCreate({ edition: 'single-tenant', token: null })).toBe(true)
  }, 120_000)

  it('allows it on Cloud, which has no single slot to protect', () => {
    expect(mayCreate({ edition: 'cloud', token: TOKEN })).toBe(true)
  }, 120_000)

  it('allows it once the deployment is claimed', async () => {
    // The operator exists. Whether a SECOND account may be created is the
    // ordinary admission question (closed unless BACKENLY_ALLOW_PUBLIC_SIGNUP),
    // decided by assertSignupAllowed, not by the claim.
    await run(
      dbUrl,
      `INSERT INTO users (id, email, name, "updatedAt") ` +
        `VALUES ('22222222-2222-4222-8222-222222222222', 'operator@acceptance.test', 'Operator', now())`,
    )
    expect(mayCreate({ edition: 'single-tenant', token: TOKEN })).toBe(true)
  }, 120_000)
})
