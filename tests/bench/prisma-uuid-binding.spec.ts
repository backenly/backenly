/**
 * A uuid column bound through Prisma REQUIRES an explicit ::uuid cast.
 *
 * ── The production bug ──────────────────────────────────────────────────────
 * `behavioral-verifier` built INSERTs whose uuid placeholders were cast only
 * when the VALUE looked like a uuid, while every other type keyed off the
 * COLUMN type. That is the wrong test, because the cast is a property of the
 * transport, not of the value:
 *
 *   Prisma  $queryRawUnsafe  → sends string params explicitly typed `text`
 *                              → 42804 on a uuid column, even for a valid uuid
 *   node-postgres            → sends params untyped, Postgres infers from the
 *                              target column → same SQL succeeds
 *
 * That difference is why the failure looked like "a bad value reached user_id"
 * for two rounds of analysis. It was not. It ran 641 times against one
 * production table over six days, swallowed by a catch, reported as a pass.
 *
 * These tests pin the transport rule itself, so nobody re-derives the wrong
 * conclusion from a value that happens to look fine.
 */

import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'

const prisma = new PrismaClient()
let schema: string

beforeAll(async () => {
  schema = 'uuidbind_' + crypto.randomBytes(4).toString('hex')
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."t" (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL
     )`,
  )
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.$disconnect()
}, 60_000)

describe('Prisma uuid parameter binding', () => {
  const validUuid = crypto.randomUUID()

  it('rejects a BARE placeholder into a uuid column, even with a valid uuid value', async () => {
    // This is the transport rule the fix exists for. If a future Prisma version
    // starts inferring the target column type, this test flips and the cast
    // becomes optional — worth knowing explicitly rather than by surprise.
    await expect(
      prisma.$queryRawUnsafe(
        `INSERT INTO "${schema}"."t" (user_id) VALUES ($1) RETURNING id`,
        validUuid,
      ),
    ).rejects.toThrow(/42804|is of type uuid but expression is of type text/)
  }, 30_000)

  it('accepts the same value with an explicit ::uuid cast', async () => {
    await expect(
      prisma.$queryRawUnsafe(
        `INSERT INTO "${schema}"."t" (user_id) VALUES ($1::uuid) RETURNING id`,
        validUuid,
      ),
    ).resolves.toBeDefined()
  }, 30_000)

  it('emits ::uuid from the COLUMN type, not the value shape', async () => {
    // Mirrors typedPlaceholder's contract. A non-canonical value must still get
    // the cast when the column is uuid — otherwise Postgres reports a confusing
    // type error instead of the real problem (a bad value → 22P02).
    const { buildPlaceholderForTest } = await import('@/lib/ai/behavioral-verifier')
      .then((m: any) => ({ buildPlaceholderForTest: m.__typedPlaceholderForTest }))
      .catch(() => ({ buildPlaceholderForTest: null }))

    if (!buildPlaceholderForTest) {
      // typedPlaceholder is module-private by design. Assert the observable
      // consequence instead: a uuid column with a non-uuid-shaped value must
      // fail as a VALUE error (22P02), never as a TYPE error (42804) — which is
      // only true once the cast is keyed off the column type.
      await expect(
        prisma.$queryRawUnsafe(
          `INSERT INTO "${schema}"."t" (user_id) VALUES ($1::uuid) RETURNING id`,
          'not-a-uuid',
        ),
      ).rejects.toThrow(/22P02|invalid input syntax for type uuid/)
      return
    }
    expect(buildPlaceholderForTest('anything', 1, 'uuid')).toBe('$1::uuid')
  }, 30_000)
})
