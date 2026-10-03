/**
 * THE MAINTENANCE PRIMITIVES AGAINST A TABLE THE PRODUCT BUILT
 * ============================================================
 *
 * Every other database-backed suite creates its fixtures with raw DDL, which
 * leaves them without row-level security. The product does not: `CREATE_TABLE`
 * goes through AutoRLS, and the resulting table refuses to show its rows to a
 * session that carries no claim.
 *
 * That difference hid a real defect until production. `reconcile.ts` read
 * tenant data through `queryWorkspaceSchema`, which sets `search_path` but no
 * claim, so it counted **zero rows in a table holding eighty** and reported
 * "table has no rows, so consistency could not be demonstrated". The backfill
 * had the same blindness in the other direction: its UPDATE would match nothing
 * and report `updated: 0` as success.
 *
 * So this suite builds its fixture the way the product does, and pins:
 *
 *   no-claim count      0      the policy working
 *   owner count        80      the same rows, seen through the claim
 *   backfill                   scans, updates, advances its cursor
 *   reconciliation             compares 80 and agrees
 *   and disagrees              when a value is deliberately corrupted
 *
 * The last one is the point. Replacing a blind query with a privileged query
 * that always reports success would satisfy every check above except that one.
 */

import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db'
import { rlsSessionParams, rlsSessionSql } from '@/lib/services/rls-session'

jest.setTimeout(600_000)

const ROWS = 80
let projectId = ''
let schema = ''
let ownerId = ''
let created = false
let probeRole = ''
const PROBE_PASSWORD = 'rls-probe-not-a-real-secret'

/**
 * Count as a role that is genuinely subject to the policy.
 *
 * The local development role is a SUPERUSER, and PostgreSQL exempts superusers
 * from RLS entirely — even FORCE. Production's app role is not one
 * (`superuser: false`, measured), so a superuser-only test would exercise a
 * path production never takes and would have shown nothing about the defect.
 * This creates a throwaway NOSUPERUSER login for the duration of the suite.
 *
 * Roles are cluster-wide, so the name is unique and it is dropped in afterAll.
 */
async function countAsUnprivileged(): Promise<number> {
  const url = new URL(process.env.DATABASE_URL as string)
  const client = new Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, '').split('?')[0],
    user: probeRole,
    password: PROBE_PASSWORD,
    ssl: false,
  })
  await client.connect()
  try {
    const r = await client.query(`SELECT count(*)::bigint AS n FROM "${schema}"."sessions"`)
    return Number(r.rows[0].n)
  } finally {
    await client.end().catch(() => {})
  }
}

const raw = <T = any>(sql: string, ...params: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...params)

/** Run as the service role, the way the platform's own owner-context helper does. */
async function asOwner<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams({ userId: ownerId, isServiceRole: true, userRole: 'service' }))
    return tx.$queryRawUnsafe<T>(sql, ...params) as Promise<T[]>
  })
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'

  const user = await prisma.user.create({
    data: { email: `rls-fixture-${randomUUID()}@example.test`, name: 'rls fixture' },
    select: { id: true },
  })
  ownerId = user.id

  const { createProvisionedProject } = await import('@/lib/projects/provision')
  const { executeAction } = await import('@/lib/ai/minimal-executor')

  const project = await createProvisionedProject({ name: `rls-fixture-${randomUUID()}`, userId: ownerId })
  projectId = project.id
  schema = `workspace_${projectId}`

  const act = async (action: string, params: Record<string, unknown>) => {
    const r = await executeAction({ action, params } as never, projectId, undefined, 0, undefined, false)
    if (!r.success) throw new Error(`${action} failed: ${r.message}`)
  }
  await act('CREATE_TABLE', { tableName: 'users', columns: [{ name: 'email', type: 'text' }] })
  await act('CREATE_TABLE', {
    tableName: 'sessions',
    columns: [
      { name: 'user_id', type: 'uuid' },
      { name: 'status', type: 'text' },
      { name: 'lifecycle_state', type: 'text' },
    ],
  })

  // FORCE, because the local test role OWNS these tables and PostgreSQL exempts
  // a table's owner from its own policies unless forced. Production's app role
  // is not the owner, so the policies bite there and this test would otherwise
  // exercise a path production never takes. Forcing it locally makes the two
  // agree; it does not weaken anything, and the assertion below pins it.
  for (const t of ['users', 'sessions']) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."${t}" FORCE ROW LEVEL SECURITY`)
  }

  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams({ userId: ownerId, isServiceRole: true, userRole: 'service' }))
    await tx.$executeRawUnsafe(`INSERT INTO "${schema}"."users" (id, email) VALUES ($1::uuid, $2)`, ownerId, 'fixture@example.test')
    // user_id supplied explicitly rather than left to the ownership column's
    // default, which reads the claim through a function the PostgREST install
    // provides. The test is about RLS, not about which environments have that
    // function, so it should not depend on it.
    await tx.$executeRawUnsafe(
      `INSERT INTO "${schema}"."sessions" (id, user_id, status)
         SELECT gen_random_uuid(), $1::uuid, (ARRAY['active','archived','pending'])[1 + (g % 3)]
           FROM generate_series(1, ${ROWS}) g`,
      ownerId,
    )
  })
  await prisma.$executeRawUnsafe(`ANALYZE "${schema}"."sessions"`)

  probeRole = `rls_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  await prisma.$executeRawUnsafe(
    `CREATE ROLE "${probeRole}" LOGIN PASSWORD '${PROBE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
  )
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${probeRole}"`)
  await prisma.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${probeRole}"`)

  created = true
})

afterAll(async () => {
  if (projectId) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  // Roles are cluster-wide; leaving one behind pollutes every other database.
  if (probeRole) await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${probeRole}"`).catch(() => {})
  await prisma.$disconnect().catch(() => {})
})

describe('the product-built table really is RLS-protected', () => {
  it('shows zero rows without a claim and eighty with one', async () => {
    expect(created).toBe(true)
    // This is the whole defect in two readings of one table.
    const blind = await countAsUnprivileged()
    const seeing = await asOwner<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM "${schema}"."sessions"`)

    expect(blind).toBe(0)
    expect(Number(seeing[0].n)).toBe(ROWS)
  })

  it('is enabled AND forced, so even the table owner is subject to it', async () => {
    const r = await raw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'sessions'`,
      schema,
    )
    expect(r[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true })
  })
})

describe('the backfill writes through the policy', () => {
  it('scans, updates, and advances its cursor', async () => {
    const { runBackfillBatch } = await import('@/lib/autonomy/maintenance/primitives/backfill')
    const spec = {
      projectId, table: 'sessions', sourceColumn: 'status', targetColumn: 'lifecycle_state',
      transform: { kind: 'upper' as const }, batchRows: 25,
    }

    let cursor: string | null = null
    let updated = 0
    let scanned = 0
    let batches = 0
    const cursors: Array<string | null> = []
    let done = false

    while (!done && batches < 20) {
      const r: any = await runBackfillBatch(spec, cursor)
      expect(r.refusal).toBeNull()
      cursors.push(r.cursor)
      cursor = r.cursor
      updated += r.updated
      scanned += r.scanned
      done = r.done
      batches++
    }

    expect(batches).toBeGreaterThan(1)
    expect(scanned).toBeGreaterThan(0)
    // Without the claim this was 0 while reporting success.
    expect(updated).toBe(ROWS)
    // The cursor moved, rather than re-scanning one window forever.
    expect(new Set(cursors.filter(Boolean)).size).toBeGreaterThan(1)

    const filled = await asOwner<{ n: bigint }>(
      `SELECT count(*)::bigint AS n FROM "${schema}"."sessions" WHERE lifecycle_state = upper(status)`,
    )
    expect(Number(filled[0].n)).toBe(ROWS)
  })
})

describe('reconciliation compares real rows', () => {
  const input = () => ({
    projectId, table: 'sessions', sourceColumn: 'status', targetColumn: 'lifecycle_state',
    transform: { kind: 'upper' as const }, planIdentity: 'rls-fixture-v1',
  })

  it('compares eighty and agrees', async () => {
    const { reconcileSourceTarget } = await import('@/lib/autonomy/maintenance/reconcile')
    const r = await reconcileSourceTarget(input())

    expect(r.verdict).toBe('consistent')
    expect(r.comparedRows).toBe(ROWS)
    expect(r.mismatchedRows).toBe(0)
    expect(r.coverage.complete).toBe(true)
  })

  it('DISAGREES when one value is corrupted', async () => {
    // The check that separates "can see the rows" from "always says yes". Every
    // assertion above would also pass against a privileged query that reported
    // success unconditionally; this one would not.
    const { reconcileSourceTarget } = await import('@/lib/autonomy/maintenance/reconcile')
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams({ userId: ownerId, isServiceRole: true, userRole: 'service' }))
      await tx.$executeRawUnsafe(
        `UPDATE "${schema}"."sessions" SET lifecycle_state = 'WRONG'
          WHERE id = (SELECT id FROM "${schema}"."sessions" ORDER BY id LIMIT 1)`,
      )
    })

    const r = await reconcileSourceTarget(input())
    expect(r.verdict).toBe('inconsistent')
    expect(r.mismatchedRows).toBe(1)
    expect(r.comparedRows).toBe(ROWS)
    expect(r.evidence.mismatchExamples.length).toBeGreaterThan(0)

    // Put it back so later readers see a consistent fixture.
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams({ userId: ownerId, isServiceRole: true, userRole: 'service' }))
      await tx.$executeRawUnsafe(`UPDATE "${schema}"."sessions" SET lifecycle_state = upper(status)`)
    })
  })
})

describe('the structural probe samples real rows', () => {
  // The probe that decides `duplicated_lifecycle_state` needs 50 rows before it
  // will answer. Read without a claim it counts 0 on this full table, throws
  // "insufficient sample", and the diagnosis collapses to `inconclusive` — so
  // no plan can ever be built for an RLS-protected project, which is every
  // project the product creates.
  //
  // Production showed this as a contradiction inside one report:
  // `assessStructuralCoverage` reads `pg_class.reltuples`, which RLS does not
  // filter, and reported 80 rows with the sample sufficient, while this probe
  // reported 0. The blinded reading is the one that decided the verdict.
  //
  // ── What these two tests do NOT prove ──────────────────────────────────────
  //
  // They do not pin that defect. The probe reaches the database through the
  // application pool, which here connects as the local development superuser,
  // and a superuser bypasses RLS entirely — FORCE included. So the unclaimed
  // read sees all 80 rows locally and these assertions hold whether or not the
  // probe carries a claim. Reverting the fix was measured: they still passed.
  //
  // The tests above use `countAsUnprivileged`, a throwaway NOSUPERUSER role,
  // which is why they can tell the difference and these cannot. Pinning this
  // one the same way needs the pool itself pointed at a non-superuser, which is
  // a change to the pool, not to a test.
  //
  // They are kept because a probe that throws for any other reason still fails
  // here. The evidence that the claim is actually carried is the production
  // dry-run, where the role is not a superuser.
  it('finds the covariation instead of refusing for want of rows', async () => {
    const { columnCoVariation } = await import('@/lib/autonomy/hypothesis/structural-probes')
    const out = await columnCoVariation({ projectId, membership: ['sessions'] } as never)

    expect(out.outcome).toBe('co_varying')
    expect(out.detail).toContain('sessions')
  })

  it('reports the sample as sufficient, agreeing with the probe', async () => {
    const { assessStructuralCoverage } = await import('@/lib/autonomy/hypothesis/structural-probes')
    const coverage = await assessStructuralCoverage({ projectId, membership: ['sessions'] } as never)

    // The two readings of one table must not disagree.
    expect(coverage.sampleSufficient).toBe(true)
    expect(coverage.largestSampleRows).toBeGreaterThanOrEqual(50)
  })
})

describe('the elevated context does not leak', () => {
  it('leaves no claim behind for the next borrower of the connection', async () => {
    // `set_config(..., true)` is transaction-local. If it were session-local,
    // the next query on this pooled connection would inherit service-role and
    // every later RLS check in the process would be meaningless.
    await asOwner(`SELECT 1`)
    const after = await raw<{ claims: string | null }>(
      `SELECT current_setting('request.jwt.claims', true) AS claims`,
    )
    expect(after[0].claims === null || after[0].claims === '').toBe(true)

    expect(await countAsUnprivileged()).toBe(0)
  })

  it('still bounds the backfill with a transaction-local lock timeout', async () => {
    // The claim had to join the SAME transaction as the timeout and the UPDATE.
    // A helper that opened its own transaction would have moved the claim onto
    // a different connection from the one SET LOCAL was bounding.
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', 'lib', 'autonomy', 'maintenance', 'primitives', 'backfill.ts'),
      'utf8',
    )
    const tx = src.slice(src.indexOf('prisma.$transaction'))
    expect(tx.indexOf('rlsSessionSql')).toBeGreaterThan(-1)
    expect(tx.indexOf('SET LOCAL lock_timeout')).toBeGreaterThan(tx.indexOf('rlsSessionSql'))
    // Not CALLED — the name appears in a comment explaining why it is not used.
    expect(src).not.toMatch(/queryWorkspaceAsOwner\(/)
  })
})
