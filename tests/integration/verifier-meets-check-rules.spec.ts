/**
 * BACKENLY'S OWN TEST ROW NEVER BLOCKS A PUBLISH
 * ==============================================
 * Production QA, 2026-11-21, N1: a store could not be published because the
 * behavioral verifier's test row put 0 into reviews.rating, which must be 1 to
 * 5. The checks wrote 0 into every number, took the first quoted text of a
 * CHECK as its allowed value whatever the rule was, and tested whichever table
 * an unordered query returned first, so the same project passed or failed by
 * the order of a query.
 *
 * Now a test row's values are ones PostgreSQL says the column's rules accept
 * (lib/ai/checked-values.ts), tables are tried in name order, and a table the
 * test cannot build a row for is passed over and named, never failed. A table
 * no row at all can be written to is still a failure.
 *
 * Real provisioned project, real users table, the real verifier.
 */
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { runBehavioralVerification, type BehavioralVerificationResult } from '@/lib/ai/behavioral-verifier'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'

let ownerId: string
let projectId: string
let schema: string
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL

const q = (name: string) => `"${schema}"."${name}"`
const sql = (statement: string) => prisma.$executeRawUnsafe(statement)

async function count(table: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${q(table)}`)
  return rows[0].n
}

const checkOf = (result: BehavioralVerificationResult, id: string) => result.checks.find((c) => c.id === id)!

/**
 * The checks that failed, apart from the RLS check's verdict: the test
 * database connects as a superuser, which row-level security never applies to,
 * so there user B always sees user A's row. That it could write its row is
 * asserted on its own.
 */
const failedChecks = (result: BehavioralVerificationResult) =>
  result.checks.filter((c) => c.id !== 'rls_isolation' && !c.skipped && !c.passed).map((c) => `${c.id}: ${c.error}`)

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  // Nothing listens here, so the live HTTP check skips rather than signing anyone up.
  process.env.NEXT_PUBLIC_APP_URL = 'http://127.0.0.1:9'

  const email = `check-rules-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'Check rules' } })).id
  const project = await createProvisionedProject({ name: 'verifier-meets-check-rules', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema

  await sql(jwtClaimFunctionSql(schema))
  await ensureAuthUsersTable(projectId, { email })
  // A users table a developer extended: required columns of their own, under rules.
  await sql(`ALTER TABLE ${q('users')} ADD COLUMN plan text NOT NULL CHECK (plan IN ('free', 'pro'))`)
  await sql(`ALTER TABLE ${q('users')} ADD COLUMN age integer NOT NULL CHECK (age >= 13)`)

  // First in name order, and no value the test tries meets its rule.
  await sql(`CREATE TABLE ${q('aa_sealed')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token text NOT NULL CHECK (token = md5('nothing the test tries'))
  )`)
  // Second, with a rule over two columns, which the test does not search.
  await sql(`CREATE TABLE ${q('ab_bookings')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    CHECK (ends_at > starts_at)
  )`)
  // QA's store. Every required column is under a rule the old values broke:
  // 0 for the numbers, the pattern itself for the patterned texts.
  await sql(`CREATE TABLE ${q('products')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sku text NOT NULL CHECK (sku ~ '^[a-z0-9-]+$'),
    title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
    price_cents integer NOT NULL CHECK (price_cents >= 100),
    currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    status text NOT NULL CHECK (status IN ('draft', 'active'))
  )`)
  await sql(`CREATE TABLE ${q('reviews')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL REFERENCES ${q('products')}(id),
    user_id uuid NOT NULL DEFAULT (${q('backenly_jwt_claim')}('sub'))::uuid,
    rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
    body text NOT NULL CHECK (char_length(body) >= 3)
  )`)
  await sql(`ALTER TABLE ${q('reviews')} ENABLE ROW LEVEL SECURITY`)
  await sql(`CREATE POLICY backenly_own_rows ON ${q('reviews')} USING (user_id::text = ${q('backenly_jwt_claim')}('sub'))`)
  for (const name of ['aa_sealed', 'ab_bookings', 'products', 'reviews']) {
    await prisma.table.create({ data: { name, projectId } })
  }
}, 180_000)

afterAll(async () => {
  const schemas = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}%'`,
  ).catch(() => [])
  for (const s of schemas) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s.nspname}" CASCADE`).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
  process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
}, 120_000)

describe('a project whose tables have CHECK rules', () => {
  let result: BehavioralVerificationResult

  beforeAll(async () => {
    result = await runBehavioralVerification(projectId)
  }, 120_000)

  it('is not failed by a check that could not write its own test row', () => {
    expect(failedChecks(result)).toEqual([])
  })

  it('has its CRUD lifecycle proved on the first table a test row can be written to', () => {
    const crud = checkOf(result, 'crud_lifecycle')
    expect(crud).toMatchObject({ passed: true, skipped: false })
    expect(crud.details).toEqual(
      expect.arrayContaining([
        '✓ INSERT succeeded on "products"',
        '✓ READ returned inserted row',
        '✓ UPDATE succeeded',
        '✓ DELETE succeeded',
        '✓ Post-delete read returns 0 rows',
      ]),
    )
  })

  it('names each table it passed over, and the rule that stood in the way', () => {
    const { details } = checkOf(result, 'crud_lifecycle')
    expect(details[0]).toBe(
      `⏭ Couldn't test "aa_sealed": none of the values the test tries for "aa_sealed"."token" is allowed by its rule "aa_sealed_token_check"`,
    )
    expect(details[1]).toMatch(/^⏭ Couldn't test "ab_bookings": a test row could not be written to "ab_bookings" \(.*check rule.*\)$/i)
  })

  it('signs a test user up on a users table with required columns under rules', () => {
    const auth = checkOf(result, 'auth_flow')
    expect(auth.error).toBeUndefined()
    expect(auth).toMatchObject({ passed: true, skipped: false })
  })

  it('writes the row for the RLS check, with its parent, though both are under rules', () => {
    const rls = checkOf(result, 'rls_isolation')
    expect(rls.skipped).toBe(false)
    expect(rls.details[0]).toMatch(/^✓ User A \(.+\) inserted a row into "reviews"$/)
  })

  it('leaves no test row and no test user behind', async () => {
    for (const table of ['aa_sealed', 'ab_bookings', 'products', 'reviews', 'users']) expect(await count(table)).toBe(0)
  })
})

describe('a table no row at all can be written to', () => {
  // Third in name order: reached after the two tables the test cannot build a
  // row for, and before the one it can.
  beforeAll(async () => {
    await sql(`CREATE TABLE ${q('ac_broken')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text NOT NULL)`)
    await sql(`CREATE FUNCTION ${q('stamp_broken')}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM ${q('a_function_that_was_dropped')}();
        RETURN NEW;
      END $$`)
    await sql(`CREATE TRIGGER stamp BEFORE INSERT ON ${q('ac_broken')} FOR EACH ROW EXECUTE FUNCTION ${q('stamp_broken')}()`)
    await prisma.table.create({ data: { name: 'ac_broken', projectId } })
  }, 60_000)

  afterAll(async () => {
    await sql(`DROP TABLE ${q('ac_broken')} CASCADE`)
    await prisma.table.deleteMany({ where: { projectId, name: 'ac_broken' } })
  }, 60_000)

  it('still fails the CRUD check: that is the backend, not the test row', async () => {
    const crud = checkOf(await runBehavioralVerification(projectId), 'crud_lifecycle')
    expect(crud).toMatchObject({ passed: false, skipped: false })
    expect(crud.error).toMatch(/^INSERT failed: a test row could not be written to "ac_broken"/)
    expect(crud.details).toContain('✗ INSERT failed')
  }, 120_000)
})

describe('a project where no table takes a test row', () => {
  beforeAll(async () => {
    await prisma.table.deleteMany({ where: { projectId, name: { in: ['products', 'reviews'] } } })
  })

  it('has its CRUD check reported as not run, with the reason, and is not failed', async () => {
    const run = await runBehavioralVerification(projectId)
    const crud = checkOf(run, 'crud_lifecycle')
    expect(crud).toMatchObject({ passed: false, skipped: true })
    expect(crud.skipReason).toMatch(/^CRUD lifecycle not exercised: a test row could not be written to any of the 2 tables tried\./)
    expect(crud.skipReason).toContain('"aa_sealed"')
    expect(crud.skipReason).toContain('"ab_bookings"')
    expect(crud.skipReason).toMatch(/This is a limit of Backenly's test, not a fault in the backend\.$/)
    expect(failedChecks(run)).toEqual([])
  }, 120_000)
})
