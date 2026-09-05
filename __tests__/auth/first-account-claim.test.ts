/**
 * ONE OPERATOR, EVEN UNDER A RACE
 * ===============================
 * A self-hosted deployment allows the first account and then closes
 * registration, because Turnstile, the email-trust heuristics and the blocklist
 * are all inert until an operator configures them: an open default means anyone
 * who finds the URL gets an account on somebody's infrastructure.
 *
 * The pre-flight check in `assertSignupAllowed` cannot be the enforcement. It
 * runs about fifty lines before the insert, so two concurrent first signups both
 * read zero accounts, both proceed, and a single-operator install quietly ends
 * up with two operators. A count followed by an insert is not a decision, it is
 * a race.
 *
 * So the claim is made inside the transaction that inserts, behind a
 * transaction-scoped advisory lock, and this asserts that under genuine
 * concurrency rather than in sequence — running these one after another would
 * pass even with the bug.
 *
 * Real database, because the whole mechanism is a Postgres lock.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { assertSignupAllowed, createUserClaimingSignupSlot, SignupSlotTakenError } from '@/lib/platform-controls'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const created: string[] = []

/**
 * Every test here builds its own precondition and never assumes one.
 *
 * "Is this the first account" is a question about the WHOLE users table, and
 * that table differs between a developer machine (accumulated rows) and a CI
 * container (fresh). An earlier version asserted `count > 0` and passed locally
 * while failing on CI for exactly that reason — the same ambient-state trap
 * that had already broken the billing suite once.
 */
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_ALLOW = process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP

beforeAll(() => {
  assertSafeTestDatabase()
})

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  if (ORIGINAL_ALLOW === undefined) delete process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP
  else process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP = ORIGINAL_ALLOW
})

afterAll(async () => {
  if (created.length) await prisma.user.deleteMany({ where: { id: { in: created } } })
})

/** The state a self-hosted deployment is in once its operator has signed up. */
async function seedOperator(): Promise<void> {
  const u = await prisma.user.create({
    data: { email: `operator-${randomUUID()}@test.invalid`, name: 'Operator' },
    select: { id: true },
  })
  created.push(u.id)
}

function makeUser(tx: any) {
  return tx.user.create({
    data: { email: `claim-${randomUUID()}@test.invalid`, name: 'Claim Test' },
    select: { id: true },
  })
}

describe('self-hosted first-account claim', () => {
  it('refuses when accounts already exist', async () => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    delete process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP

    // Build the precondition rather than assuming it. A developer database has
    // accumulated users and CI's is fresh, so asserting "some user exists"
    // passes locally and fails on a clean container — the ambient-state trap
    // that already bit the billing suite once.
    await seedOperator()

    await expect(createUserClaimingSignupSlot(makeUser)).rejects.toBeInstanceOf(SignupSlotTakenError)
  })

  it('refuses every racer cleanly, creating nothing, when the slot is gone', async () => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    delete process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP

    await seedOperator()
    const before = await prisma.user.count()

    // Launched before either resolves, so they genuinely contend for the
    // advisory lock rather than running in sequence.
    const results = await Promise.allSettled([
      createUserClaimingSignupSlot(makeUser),
      createUserClaimingSignupSlot(makeUser),
      createUserClaimingSignupSlot(makeUser),
    ])

    // The slot is taken by construction, so the honest assertion is that ALL
    // of them lose, and lose the right way: to the recheck inside the
    // transaction, rather than to a constraint violation, a deadlock, or a
    // partial write. A refusal that rolled back cleanly is the property under
    // test.
    expect(results.every(r => r.status === 'rejected')).toBe(true)
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SignupSlotTakenError)
    }
    expect(await prisma.user.count()).toBe(before)

    // NOTE on what this does NOT prove: "exactly one winner from an empty
    // table" needs a database with zero users, which cannot be arranged inside
    // a shared suite without deleting other tests' rows. The empty-table path
    // is covered by `refuses when accounts already exist` (the gate fires at
    // all) plus this (contention resolves without partial writes); a
    // dedicated-database race remains the one assertion not made here.
  })

  it('does not lock or refuse on Cloud, where there is no slot to contend for', async () => {
    process.env.BACKENLY_EDITION = 'cloud'

    // Serialising every signup in the product behind one advisory lock would be
    // a self-inflicted bottleneck, so Cloud inserts directly.
    const results = await Promise.all([
      createUserClaimingSignupSlot(makeUser),
      createUserClaimingSignupSlot(makeUser),
    ])

    for (const u of results) created.push(u.id)
    expect(results).toHaveLength(2)
    expect(new Set(results.map(u => u.id)).size).toBe(2)
  })

  it('does not refuse when the operator has opened registration', async () => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP = 'true'

    const user = await createUserClaimingSignupSlot(makeUser)
    created.push(user.id)
    expect(user.id).toBeTruthy()
  })
})

/**
 * THE FIRST OPERATOR IS NOT A STRANGER
 * ====================================
 * Cloud's email heuristics keep throwaway and undeliverable addresses out of a
 * PUBLIC signup funnel. Applied to the one account that makes a private
 * deployment usable, they only lock the operator out of their own installation.
 *
 * Measured on a clean acceptance machine:
 *
 *   operator@acceptance.test  ->  403 "That domain cannot receive email."
 *
 * `admin@company.internal` fails the same way, and on an air-gapped install no
 * address passes at all.
 *
 * The relaxation is deliberately narrow: single-tenant edition AND an empty
 * user table, so it can happen once per deployment.
 *
 * The bypass itself needs a database with NO accounts, which cannot be
 * arranged in this shared test database, so it lives in
 * __tests__/auth/first-operator-admission.test.ts against its own. What is
 * asserted here is the other half: that the bypass did not leave self-hosted
 * signup permanently open, and that Cloud is untouched.
 */
describe('first self-hosted operator admission', () => {
  it('applies the normal policy again once the operator exists', async () => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    delete process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP
    await seedOperator()

    const guard = await assertSignupAllowed('someone-else@acceptance.test')
    expect(guard.ok).toBe(false)
    // Closed because the slot is taken, which is the pre-existing rule. The
    // bypass must not have made self-hosted signup permanently open.
    expect(guard.status).toBe(403)
  })

  it('does not take the self-hosted bypass on Cloud', async () => {
    process.env.BACKENLY_EDITION = 'cloud'

    // This used to assert that the heuristics still RUN by checking that a
    // syntactically invalid address was refused. Phase 6 moved those heuristics
    // to the private overlay, so a public checkout has none to run and the
    // provider admits; the refusal is now a composed-Cloud property, checked
    // where the implementation lives.
    //
    // What remains provable here, and what the test was really about, is that
    // the first-operator exception is edition-gated: Cloud must not consult the
    // user count and must not admit through that branch.
    // With accounts already present, single-tenant is CLOSED and says so.
    // Cloud must not reach that branch at all, whatever it then decides.
    const cloud = await assertSignupAllowed('someone@acceptance.test')
    expect(cloud.reason).not.toMatch(/BACKENLY_ALLOW_PUBLIC_SIGNUP/)

    process.env.BACKENLY_EDITION = 'single-tenant'
    const selfHosted = await assertSignupAllowed('someone@acceptance.test')
    expect(selfHosted.ok).toBe(false)
    expect(selfHosted.reason).toMatch(/BACKENLY_ALLOW_PUBLIC_SIGNUP/)
  })
})
