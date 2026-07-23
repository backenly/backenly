/**
 * Proof that `run_query`'s read-only role is actually a boundary.
 *
 * run_query exposes standard SQL to an agent. Its syntactic guards are defence
 * in depth and are unit-tested separately; THIS suite tests the thing that has
 * to hold even if every one of those guards is bypassed — the grants on the
 * `bkn_ro_` role.
 *
 * The distinction matters. A SQL parser can always be out-argued: quoting
 * tricks, unicode escapes, dialect corners. Postgres privileges cannot. So the
 * design puts the boundary in the database, and this suite is what says so
 * out loud:
 *
 *   · a read-only role CANNOT write, even given a valid write statement
 *   · it CANNOT reach another project's schema, even fully qualified
 *   · it CANNOT reach the platform's own `public` tables
 *   · it CAN read its own schema — or the tool would be useless
 *
 * Every case asserts both directions. A role that can read nothing passes any
 * test that only checks that it cannot read the wrong thing.
 *
 * Runs against the real Postgres service container in CI (`probes` job). The
 * database is never mocked: what is under test is privilege enforcement, which
 * only exists in a real server.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

const prisma = new PrismaClient()

const suffix = randomUUID().replace(/-/g, '').slice(0, 10)
const MINE = `workspace_rq_mine_${suffix}`
const THEIRS = `workspace_rq_theirs_${suffix}`
const RO_ROLE = `bkn_ro_test_${suffix}`

/** Run a statement with the session switched to the read-only role. */
async function asReadOnlyRole<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(`SET ROLE "${RO_ROLE}"`)
  try {
    return await fn()
  } finally {
    await prisma.$executeRawUnsafe(`RESET ROLE`)
  }
}

async function expectDenied(sql: string): Promise<string> {
  let message = ''
  try {
    await asReadOnlyRole(() => prisma.$executeRawUnsafe(sql))
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message).not.toBe('')
  return message
}

beforeAll(async () => {
  for (const s of [MINE, THEIRS]) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`)
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${s}"`)
    await prisma.$executeRawUnsafe(`CREATE TABLE "${s}".notes (id int primary key, body text)`)
    await prisma.$executeRawUnsafe(`INSERT INTO "${s}".notes VALUES (1, 'row in ${s}')`)
  }

  // A stand-in for the platform's own tables, which live in `public` and hold
  // every platform user's password hash. A workspace role reaching these would
  // be the worst possible outcome of exposing SQL.
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS public.rq_platform_secrets_${suffix}`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE public.rq_platform_secrets_${suffix} (id int primary key, password_hash text)`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.rq_platform_secrets_${suffix} VALUES (1, '$2b$10$notarealhash')`,
  )

  await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${RO_ROLE}"`)
  // Mirrors backenly_direct_create_role: no superuser, no RLS bypass.
  await prisma.$executeRawUnsafe(
    `CREATE ROLE "${RO_ROLE}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
  )
  // Mirrors backenly_direct_sync_schema for READ_ONLY: usage + select on ONE
  // schema. Nothing is granted for THEIRS or for public — that omission is the
  // entire boundary, so the test grants exactly what production grants.
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${MINE}" TO "${RO_ROLE}"`)
  await prisma.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA "${MINE}" TO "${RO_ROLE}"`)
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`RESET ROLE`).catch(() => {})
  for (const s of [MINE, THEIRS]) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
  }
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS public.rq_platform_secrets_${suffix}`).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${RO_ROLE}"`).catch(() => {})
  await prisma.$disconnect()
}, 60_000)

describe('read-only role — can do its job', () => {
  it('reads its own schema', async () => {
    const rows = await asReadOnlyRole(() =>
      prisma.$queryRawUnsafe<Array<{ body: string }>>(`SELECT body FROM "${MINE}".notes`),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].body).toContain('mine')
  })

  it('runs the set-based SQL that db_query could not express', async () => {
    const rows = await asReadOnlyRole(() =>
      prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "${MINE}".notes GROUP BY body`,
      ),
    )
    expect(Number(rows[0].n)).toBe(1)
  })
})

describe('read-only role — cannot write', () => {
  it('refuses INSERT', async () => {
    const msg = await expectDenied(`INSERT INTO "${MINE}".notes VALUES (99, 'nope')`)
    expect(msg).toMatch(/permission denied/i)
  })

  it('refuses UPDATE', async () => {
    expect(await expectDenied(`UPDATE "${MINE}".notes SET body = 'nope'`)).toMatch(/permission denied/i)
  })

  it('refuses DELETE', async () => {
    expect(await expectDenied(`DELETE FROM "${MINE}".notes`)).toMatch(/permission denied/i)
  })

  it('refuses DDL', async () => {
    expect(await expectDenied(`CREATE TABLE "${MINE}".sneaky (id int)`)).toMatch(/permission denied/i)
  })

  it('leaves the data untouched after every refused write', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "${MINE}".notes`,
    )
    expect(Number(rows[0].n)).toBe(1)
  })
})

describe('read-only role — cannot cross the tenant boundary', () => {
  it('refuses another project schema even when fully qualified', async () => {
    // search_path is a convenience, never the boundary — so the attack that
    // matters is the one that ignores it entirely.
    const msg = await expectDenied(`SELECT * FROM "${THEIRS}".notes`)
    expect(msg).toMatch(/permission denied/i)
  })

  it('refuses the platform tables in public', async () => {
    const msg = await expectDenied(`SELECT password_hash FROM public.rq_platform_secrets_${suffix}`)
    expect(msg).toMatch(/permission denied/i)
  })

  it('refuses a cross-schema join, not just a direct select', async () => {
    await expectDenied(
      `SELECT a.body FROM "${MINE}".notes a JOIN "${THEIRS}".notes b ON b.id = a.id`,
    )
  })

  it('refuses to reach another schema through a CTE', async () => {
    await expectDenied(`WITH x AS (SELECT * FROM "${THEIRS}".notes) SELECT * FROM x`)
  })

  it('cannot widen its own access', async () => {
    await expectDenied(`GRANT USAGE ON SCHEMA "${THEIRS}" TO "${RO_ROLE}"`)
  })
})
