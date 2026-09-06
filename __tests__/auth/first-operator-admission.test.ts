/**
 * THE FIRST OPERATOR IS NOT A STRANGER
 * ====================================
 * Cloud's email heuristics keep throwaway and undeliverable addresses out of a
 * PUBLIC signup funnel. Applied to the one account that makes a private
 * deployment usable, they only lock the operator out of their own installation.
 *
 * Measured on a clean acceptance machine, following the README exactly:
 *
 *   operator@acceptance.test  ->  403 "That domain cannot receive email."
 *
 * `admin@company.internal` fails the same way, and on an air-gapped install no
 * address passes at all.
 *
 * Its own database, because the bypass requires a user table with ZERO rows and
 * that cannot be arranged in a shared one — a neighbouring suite's fixture is
 * enough to make it silently untestable. Its own PROCESS too, because
 * assertSignupAllowed reaches the Prisma singleton, which binds to DATABASE_URL
 * at import.
 *
 * The narrowness is the point, so the negative cases are asserted here as well:
 * with an account already present, and on Cloud, the heuristics must still run.
 */

import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { Client } from 'pg'
import * as fs from 'fs'
import * as path from 'path'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const DB_NAME = `backenly_admit_jest_${randomBytes(3).toString('hex')}`
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

async function adminExec(query: string): Promise<void> {
  const client = new Client({ connectionString: urlForDatabase(ADMIN_URL!, 'postgres') })
  await client.connect()
  try {
    await client.query(query)
  } finally {
    await client.end()
  }
}

async function sql(query: string): Promise<void> {
  const client = new Client({ connectionString: dbUrl })
  await client.connect()
  try {
    await client.query(query)
  } finally {
    await client.end()
  }
}

/** Ask the real guard, in a process bound to the scratch database. */
function admits(email: string, edition: string): { ok: boolean; out: string } {
  return probeGuard(email, { BACKENLY_EDITION: edition })
}

/**
 * Ask the guard with BACKENLY_EDITION genuinely ABSENT from the child process.
 *
 * Not `BACKENLY_EDITION: ''`. An empty string and an absent key resolve the
 * same way through `currentEdition()` today, but they are different states and
 * only one of them is what a real unconfigured deployment has. Deleting the key
 * means this proves the DEFAULT rather than proving how an empty value is
 * parsed.
 */
function admitsWithNoEditionSet(
  email: string,
  extra: Record<string, string> = {},
): { ok: boolean; out: string } {
  return probeGuard(email, extra, /* deleteEdition */ true)
}

function probeGuard(
  email: string,
  extra: Record<string, string>,
  deleteEdition = false,
): { ok: boolean; out: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: dbUrl,
    DIRECT_URL: dbUrl,
    BACKENLY_ALLOW_PUBLIC_SIGNUP: '',
    ...extra,
  }
  if (deleteEdition) delete env.BACKENLY_EDITION

  const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', probe, email], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  })
  return { ok: /GUARD_OK=true/.test(out), out }
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

  probe = path.join(process.cwd(), `.admit-probe-${randomBytes(3).toString('hex')}.ts`)
  fs.writeFileSync(
    probe,
    [
      `import { assertSignupAllowed } from '@/lib/platform-controls'`,
      `import { prisma } from '@/lib/db'`,
      `assertSignupAllowed(process.argv[2])`,
      `  .then(g => { console.log('GUARD_OK=' + g.ok + ' STATUS=' + g.status + ' REASON=' + g.reason) })`,
      `  .catch(e => { console.log('GUARD_ERROR=' + e.message) })`,
      `  .finally(() => prisma.$disconnect())`,
      ``,
    ].join('\n'),
    'utf8',
  )
}, 240_000)

afterAll(async () => {
  if (probe) fs.rmSync(probe, { force: true })
  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
}, 60_000)

describe('first self-hosted operator admission', () => {
  it('admits an address no public MX would accept', async () => {
    // The exact address the acceptance machine was refused.
    const r = admits('operator@acceptance.test', 'single-tenant')
    expect(r.ok).toBe(true)
  }, 120_000)

  it('admits an internal domain that cannot resolve at all', async () => {
    const r = admits('admin@company.internal', 'single-tenant')
    expect(r.ok).toBe(true)
  }, 120_000)

  it('stops relaxing once an account exists', async () => {
    await sql(
      `INSERT INTO users (id, email, name, "updatedAt") ` +
        `VALUES ('11111111-1111-4111-8111-111111111111', 'first@acceptance.test', 'First', now())`,
    )

    // Self-hosted registration is CLOSED after the first account, which is the
    // pre-existing rule. The bypass must not have made it permanently open.
    const r = admits('second@acceptance.test', 'single-tenant')
    expect(r.ok).toBe(false)
  }, 120_000)

  it('does not take the self-hosted bypass on Cloud, even with an empty user table', async () => {
    await sql(`DELETE FROM users`)

    // What this proves in THIS repository is that the bypass is edition-gated:
    // with zero users, single-tenant admits via the first-operator branch and
    // Cloud does not take that branch at all. It reaches the admission seam
    // instead.
    //
    // It used to assert the Cloud VERDICT (refused for deliverability), which
    // it can no longer do here: Phase 6 moved the email heuristics to the
    // private overlay, so a public checkout has no scoring to run and the
    // provider admits. Asserting a refusal would now be asserting the absence
    // of code this repository deliberately does not contain. The verdict is a
    // composed-Cloud property and is checked in the private CI, which has the
    // implementation to check.
    const selfHosted = admits('operator@acceptance.test', 'single-tenant')
    expect(selfHosted.ok).toBe(true)
    expect(selfHosted.out).toMatch(/GUARD_OK=true/)

    // Cloud is decided by the seam, not by the first-operator exception.
    const cloud = admits('operator@acceptance.test', 'cloud')
    expect(cloud.out).not.toMatch(/first[- ]operator/i)
  }, 120_000)
})

// ============================================================================
// THE DEFAULT, WITH NOTHING CONFIGURED
// ============================================================================

/**
 * Phase 8 made an unset edition mean single-tenant, and this is the one place
 * that changes RUNTIME PRODUCT BEHAVIOUR rather than merely which provider
 * answers.
 *
 * `selfHostedRegistrationClosed()` reads `currentEdition() === 'single-tenant'`,
 * so a deployment that configures nothing now closes public signup after its
 * first operator. That is the intended self-host posture and it is deliberately
 * NOT gated behind an explicit edition: gating it would mean the default was
 * single-tenant in name only.
 *
 * Because the consequence is a closed signup form, it gets a direct proof
 * against a real database rather than an inference from the edition constant.
 */
describe('with BACKENLY_EDITION absent entirely', () => {
  it('admits the first operator into an empty deployment', async () => {
    await sql(`DELETE FROM users`)

    const r = admitsWithNoEditionSet('operator@acceptance.test')
    expect(r.ok).toBe(true)
  }, 120_000)

  it('closes registration once that first account exists', async () => {
    await sql(`DELETE FROM users`)
    await sql(
      `INSERT INTO users (id, email, name, "updatedAt") ` +
        `VALUES ('22222222-2222-4222-8222-222222222222', 'operator@acceptance.test', 'Operator', now())`,
    )

    // The behaviour change the flip actually ships. Before Phase 8 an unset
    // edition resolved to cloud and this second signup was admitted.
    const r = admitsWithNoEditionSet('second@acceptance.test')
    expect(r.ok).toBe(false)
  }, 120_000)

  it('still honours BACKENLY_ALLOW_PUBLIC_SIGNUP as the operator override', async () => {
    await sql(`DELETE FROM users`)
    await sql(
      `INSERT INTO users (id, email, name, "updatedAt") ` +
        `VALUES ('33333333-3333-4333-8333-333333333333', 'operator@acceptance.test', 'Operator', now())`,
    )

    // The escape hatch must not have been lost along with the default. An
    // operator who wants an open self-hosted instance still has one switch.
    const r = admitsWithNoEditionSet('second@acceptance.test', {
      BACKENLY_ALLOW_PUBLIC_SIGNUP: 'true',
    })
    expect(r.ok).toBe(true)
  }, 120_000)

  it('leaves explicit cloud on the Cloud path, not the first-operator one', async () => {
    await sql(`DELETE FROM users`)

    // Explicit intent still wins over the default in both directions.
    const cloud = admits('operator@acceptance.test', 'cloud')
    expect(cloud.out).not.toMatch(/first[- ]operator/i)
  }, 120_000)
})
