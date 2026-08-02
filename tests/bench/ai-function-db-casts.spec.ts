/**
 * The AI-function `db.*` proxy must cast placeholders from the COLUMN type.
 *
 * ── The production bug ──────────────────────────────────────────────────────
 * `lib/services/ai-functions/executor.ts` built INSERT placeholders as a bare
 * `$1, $2, …`, and cast WHERE placeholders only when the VALUE looked like a
 * uuid (`dbUuidCast`). Prisma binds string params explicitly as `text`, so a
 * bare placeholder into a strictly-typed column raises 42804 no matter how
 * well-formed the value is.
 *
 * Observed in production: an AI function invoked by the quarter-hourly contract
 * sweep inserted into `<workspace>.profiles` every 15 minutes and failed 42804
 * every single time, for six days, from 2026-07-26. The caller was identified
 * from a stack-logging diagnostic, after five rounds of static analysis each
 * named a different, wrong caller.
 *
 * The value-shape test also silently did nothing for timestamp, numeric and
 * boolean columns — so those were not merely mis-cast, they were unwritable
 * through an AI function.
 *
 * These tests reproduce the failing statement's exact column shape and assert
 * both directions: the old bare form fails, the new cast form succeeds.
 */

import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'
import { castTarget, coerceValue } from '@/lib/mcp/runtime-db'

const prisma = new PrismaClient()
let schema: string

// The column set of the real failing production statement, plus the types the
// value-shape test used to skip entirely.
const COLUMNS: Array<{ name: string; ddl: string; dataType: string; value: unknown }> = [
  { name: 'user_id',      ddl: 'uuid NOT NULL',               dataType: 'uuid',                     value: crypto.randomUUID() },
  { name: 'display_name', ddl: 'text',                        dataType: 'text',                     value: 'Tenant A' },
  { name: 'joined_at',    ddl: 'timestamptz',                 dataType: 'timestamp with time zone', value: '2026-08-02T03:00:00.000Z' },
  { name: 'balance',      ddl: 'numeric(12,2)',               dataType: 'numeric',                  value: '2500.00' },
  { name: 'is_active',    ddl: 'boolean',                     dataType: 'boolean',                  value: 'true' },
  { name: 'prefs',        ddl: 'jsonb',                       dataType: 'jsonb',                    value: { theme: 'dark' } },
]

beforeAll(async () => {
  schema = 'aifncast_' + crypto.randomBytes(4).toString('hex')
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."profiles" (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       ${COLUMNS.map((c) => `"${c.name}" ${c.ddl}`).join(',\n       ')}
     )`,
  )
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.$disconnect()
}, 60_000)

const colList = COLUMNS.map((c) => `"${c.name}"`).join(', ')

describe('AI-function db proxy — column-type casts', () => {
  it('the OLD bare-placeholder INSERT fails 42804 (the production statement)', async () => {
    // Verified to fail: a regression test that passes before the fix guards
    // nothing. This is the byte-shape of the statement pulled from the prod
    // Postgres log.
    const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(', ')
    await expect(
      prisma.$queryRawUnsafe(
        `INSERT INTO "${schema}"."profiles" (${colList}) VALUES (${placeholders}) RETURNING id`,
        ...COLUMNS.map((c) => (typeof c.value === 'object' ? JSON.stringify(c.value) : c.value)),
      ),
    ).rejects.toThrow(/42804|is of type/)
  }, 30_000)

  it('the NEW column-type cast INSERT succeeds for every type', async () => {
    const types = new Map(COLUMNS.map((c) => [c.name, c.dataType]))
    const placeholders = COLUMNS.map((c, i) => {
      const target = castTarget(types.get(c.name))
      return target ? `$${i + 1}::${target}` : `$${i + 1}`
    }).join(', ')

    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "${schema}"."profiles" (${colList}) VALUES (${placeholders}) RETURNING id`,
      ...COLUMNS.map((c) => coerceValue(types.get(c.name), c.value)),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/i)
  }, 30_000)

  it('round-trips the values rather than merely accepting them', async () => {
    // A cast that silently corrupted the value would pass the test above.
    const row = await prisma.$queryRawUnsafe<Array<Record<string, any>>>(
      `SELECT "user_id"::text AS user_id, "balance"::text AS balance,
              "is_active", "prefs"
         FROM "${schema}"."profiles" LIMIT 1`,
    )
    expect(row[0].user_id).toBe(COLUMNS[0].value)
    expect(row[0].balance).toBe('2500.00')
    expect(row[0].is_active).toBe(true)
    expect(row[0].prefs).toEqual({ theme: 'dark' })
  }, 30_000)

  it('leaves text columns uncast, so no needless conversion is introduced', () => {
    expect(castTarget('text')).toBe('')
    expect(castTarget('character varying')).toBe('')
    // ARRAY must stay uncast — pg builds the array literal itself and a text
    // cast would corrupt it.
    expect(castTarget('ARRAY')).toBe('')
  })
})
