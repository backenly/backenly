/**
 * PHASE 3 — proof that the translated RLS policies actually isolate tenants.
 *
 * This is the test the migration hangs on. Translating policies from the
 * `app.*` GUCs to `request.jwt.claims` is the one step where being wrong does
 * not fail loudly: a mistranslated predicate silently WIDENS a policy, and a
 * widened own-rows policy is cross-tenant data exposure that every dashboard
 * still renders green.
 *
 * PostgREST is not needed to prove this. PostgREST's only contribution is
 * setting `request.jwt.claims`, so the fixtures set that GUC directly and
 * assert real row visibility against a real PostgreSQL. What is under test is
 * the SQL, so the database is never mocked.
 *
 * Every case asserts BOTH directions — that the owner CAN see their rows and
 * that another user CANNOT. A policy that returns everything passes any
 * test that only checks the first half.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import {
  jwtClaimFunctionSql,
  ownRowsPolicies,
  translatePolicyExpression,
  usesLegacyGucs,
  SERVICE_ROLE,
} from '@/lib/postgrest/rls-translation'

const prisma = new PrismaClient()

const schema = `pgrst_iso_${randomUUID().replace(/-/g, '').slice(0, 10)}`
const TABLE = 'notes'

const USER_A = randomUUID()
const USER_B = randomUUID()

/** Impersonate a JWT holder for the duration of one callback. */
async function asClaims<T>(
  claims: Record<string, string> | null,
  fn: () => Promise<T>,
): Promise<T> {
  // Non-superuser context: FORCE RLS applies to the table owner too, but a
  // superuser still bypasses. The suite therefore runs as a dedicated role.
  await prisma.$executeRawUnsafe(`SET ROLE ${ROLE_NAME}`)
  await prisma.$executeRawUnsafe(
    `SELECT set_config('request.jwt.claims', $1, false)`,
    claims ? JSON.stringify(claims) : '',
  )
  try {
    return await fn()
  } finally {
    await prisma.$executeRawUnsafe(`RESET ROLE`)
  }
}

const ROLE_NAME = 'pgrst_test_authenticated'

async function rowCount(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM "${schema}"."${TABLE}"`,
  )
  return Number(rows[0]?.n ?? 0)
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)

  // A non-superuser role, because FORCE RLS does not constrain a superuser and
  // testing as one would prove nothing.
  await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE_NAME}`).catch(() => {})
  await prisma.$executeRawUnsafe(`CREATE ROLE ${ROLE_NAME} NOLOGIN`)
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO ${ROLE_NAME}`)

  await prisma.$executeRawUnsafe(jwtClaimFunctionSql(schema))
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."${TABLE}" (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL,
       body text
     )`,
  )
  await prisma.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}"."${TABLE}" TO ${ROLE_NAME}`,
  )
  await prisma.$executeRawUnsafe(
    `GRANT EXECUTE ON FUNCTION "${schema}"."backenly_jwt_claim"(text) TO ${ROLE_NAME}`,
  )

  for (const stmt of ownRowsPolicies(schema, TABLE, 'user_id').statements) {
    await prisma.$executeRawUnsafe(stmt)
  }

  // Seed one row per user as the owner (policies do not constrain the seed
  // because the suite connection is superuser here — deliberately).
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."${TABLE}" (user_id, body) VALUES ($1::uuid, 'A private'), ($2::uuid, 'B private')`,
    USER_A, USER_B,
  )
}, 120_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`RESET ROLE`).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE_NAME}`).catch(() => {})
  await prisma.$disconnect()
}, 120_000)

describe('translated own-rows policies isolate tenants', () => {
  it('a user sees exactly their own row', async () => {
    const n = await asClaims({ sub: USER_A, role: 'authenticated' }, rowCount)
    expect(n).toBe(1)
  }, 60_000)

  it('a user CANNOT see another user\'s row — the exposure case', async () => {
    const rows = await asClaims({ sub: USER_A, role: 'authenticated' }, async () =>
      prisma.$queryRawUnsafe<Array<{ body: string }>>(
        `SELECT body FROM "${schema}"."${TABLE}"`,
      ),
    )
    expect(rows.map((r) => r.body)).toEqual(['A private'])
    expect(JSON.stringify(rows)).not.toContain('B private')
  }, 60_000)

  it('the other user symmetrically sees only theirs', async () => {
    const rows = await asClaims({ sub: USER_B, role: 'authenticated' }, async () =>
      prisma.$queryRawUnsafe<Array<{ body: string }>>(
        `SELECT body FROM "${schema}"."${TABLE}"`,
      ),
    )
    expect(rows.map((r) => r.body)).toEqual(['B private'])
  }, 60_000)

  it('an anonymous request (empty claims) sees nothing and does not error', async () => {
    // The empty-string GUC is why nullif() exists: ''::json raises 22P02, which
    // would turn an unauthenticated read into a 500 instead of an empty result.
    const n = await asClaims(null, rowCount)
    expect(n).toBe(0)
  }, 60_000)

  it('the service role sees every row — owner tooling must keep working', async () => {
    const n = await asClaims({ role: SERVICE_ROLE }, rowCount)
    expect(n).toBe(2)
  }, 60_000)

  it('a user cannot INSERT a row owned by someone else', async () => {
    await expect(
      asClaims({ sub: USER_A, role: 'authenticated' }, async () =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "${schema}"."${TABLE}" (user_id, body) VALUES ($1::uuid, 'forged')`,
          USER_B,
        ),
      ),
    ).rejects.toThrow()
  }, 60_000)

  it('a user cannot UPDATE another user\'s row', async () => {
    const updated = await asClaims({ sub: USER_A, role: 'authenticated' }, async () =>
      prisma.$executeRawUnsafe(
        `UPDATE "${schema}"."${TABLE}" SET body = 'hijacked' WHERE user_id = $1::uuid`,
        USER_B,
      ),
    )
    expect(updated).toBe(0)
  }, 60_000)

  it('a user cannot DELETE another user\'s row', async () => {
    const deleted = await asClaims({ sub: USER_A, role: 'authenticated' }, async () =>
      prisma.$executeRawUnsafe(
        `DELETE FROM "${schema}"."${TABLE}" WHERE user_id = $1::uuid`,
        USER_B,
      ),
    )
    expect(deleted).toBe(0)
  }, 60_000)
})

describe('translatePolicyExpression', () => {
  const s = 'workspace_x'

  it('rewrites the exact predicate currently in production', () => {
    const live =
      "((current_setting('app.is_service_role'::text, true) = 'true'::text) " +
      "OR ((user_id)::text = current_setting('app.current_user_id'::text, true)))"
    const out = translatePolicyExpression(live, s)

    expect(out).not.toBeNull()
    expect(usesLegacyGucs(out)).toBe(false)
    expect(out).toContain('backenly_jwt_claim')
    expect(out).toContain("'sub'")
    expect(out).toContain("'service_role'")
  })

  it('returns null when there is nothing to translate, rather than pretending', () => {
    // Silently "translating" an unrecognised policy is how half a schema ends
    // up on the old contract, matching nothing, looking secure.
    expect(translatePolicyExpression('(true)', s)).toBeNull()
    expect(translatePolicyExpression('', s)).toBeNull()
  })

  it('flags any expression still bound to the app.* GUCs', () => {
    expect(usesLegacyGucs("current_setting('app.current_user_id', true)")).toBe(true)
    expect(usesLegacyGucs('(true)')).toBe(false)
  })
})
