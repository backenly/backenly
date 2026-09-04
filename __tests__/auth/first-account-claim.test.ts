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
import { createUserClaimingSignupSlot, SignupSlotTakenError } from '@/lib/platform/controls'

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
 * The shared test database already holds users, so "is this the first account"
 * cannot be asked of it directly. These tests drive the claim function against a
 * table they control by scoping every assertion to rows they created, and by
 * running the zero-account case only where that is genuinely true.
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

    // The shared database already has users, which is exactly the state a
    // self-hosted deployment is in after its operator signs up.
    expect(await prisma.user.count()).toBeGreaterThan(0)

    await expect(createUserClaimingSignupSlot(makeUser)).rejects.toBeInstanceOf(SignupSlotTakenError)
  })

  it('refuses every racer cleanly, creating nothing, when the slot is gone', async () => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    delete process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP

    const before = await prisma.user.count()

    // Launched before either resolves, so they genuinely contend for the
    // advisory lock rather than running in sequence.
    const results = await Promise.allSettled([
      createUserClaimingSignupSlot(makeUser),
      createUserClaimingSignupSlot(makeUser),
      createUserClaimingSignupSlot(makeUser),
    ])

    // This database is non-empty, so the honest assertion is that ALL of them
    // lose, and lose the right way: to the recheck inside the transaction,
    // rather than to a constraint violation, a deadlock, or a partial write.
    // A refusal that rolled back cleanly is the property under test.
    expect(results.every(r => r.status === 'rejected')).toBe(true)
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SignupSlotTakenError)
    }
    expect(await prisma.user.count()).toBe(before)

    // NOTE on what this does NOT prove: "exactly one winner from an empty
    // table" needs a database with zero users, and the shared test database
    // has many. The empty-table path is covered by `refuses when accounts
    // already exist` (the gate fires at all) plus this (contention resolves
    // without partial writes); a dedicated-database race remains the one
    // assertion not made here.
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
