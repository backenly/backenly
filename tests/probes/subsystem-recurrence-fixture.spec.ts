/**
 * SUBSYSTEM RECURRENCE — prove it can FIRE against a real database
 * ================================================================
 *
 * The unit tests pin the firing predicate. They cannot pin the half that
 * actually breaks: Prisma field names, JSON-path access into `details`, the
 * `/db/{table}` path parse, and whether the foreign keys this clusters on are
 * read back out of the catalog at all.
 *
 * That distinction is not theoretical here. `detectMissingRls` sat dead in
 * every environment for months behind a duplicate bind parameter, with a green
 * dashboard above it, because its unit coverage asserted the shape of a result
 * rather than the result of a query. AGENTS.md's rule follows from that: the
 * database is never mocked.
 *
 * So this builds the violating state for real — a foreign-key-connected auth
 * subsystem, three confirmed repairs spanning two distinct gap identities, and
 * one harm signal the loop did not produce itself — and asserts the evaluator
 * fires on it. Then it removes one clause at a time and asserts it goes quiet.
 * Both halves are load-bearing: a detector that always fires is as useless as
 * one that never does.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import {
  evaluateSubsystemRecurrence,
  SUBSYSTEM_REPAIR_THRESHOLD,
} from '@/lib/autonomy/subsystem-recurrence'
import { invalidateSubsystemCache } from '@/lib/autonomy/subsystem'

const prisma = new PrismaClient()

let projectId: string
let userId: string
let schema: string

const q = (sql: string) => prisma.$executeRawUnsafe(sql)

/** A confirmed auto-fix, stamped the way the kernel stamps one. */
async function confirmedRepair(type: string, tableName: string, columnName?: string) {
  return prisma.healthFinding.create({
    data: {
      projectId,
      type,
      severity: 'warning',
      status: 'auto_fixed',
      autoFixed: true,
      fixAppliedAt: new Date(Date.now() - 60 * 60 * 1000),
      details: {
        tableName,
        ...(columnName ? { columnName } : {}),
        // The exact accessor the trust scoreboard reads. Anything else means
        // nothing re-probed the gap.
        rollbackData: { verification: 'confirmed' },
      },
    },
    select: { id: true },
  })
}

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `subsystem-recurrence+${userId.slice(0, 8)}@backenly.test`,
      name: 'subsystem recurrence fixture',
      password: 'not-a-real-hash',
    },
  })
  await prisma.project.create({
    data: { id: projectId, name: 'subsystem-recurrence-fixture', userId },
  })

  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)

  // A real auth subsystem: three tables joined by real foreign keys, so the
  // clustering under test is reading actual catalog constraints.
  await q(`CREATE TABLE "${schema}"."users" (id uuid PRIMARY KEY, email text)`)
  await q(`CREATE TABLE "${schema}"."sessions" (
    id uuid PRIMARY KEY,
    user_id uuid REFERENCES "${schema}"."users"(id)
  )`)
  await q(`CREATE TABLE "${schema}"."verification_tokens" (
    id uuid PRIMARY KEY,
    user_id uuid REFERENCES "${schema}"."users"(id),
    token text
  )`)

  // A second, unrelated subsystem. Without it the auth component would be the
  // whole schema and the breadth guard would make this fixture ineligible for
  // reasons unrelated to what it is testing.
  await q(`CREATE TABLE "${schema}"."products" (id uuid PRIMARY KEY, sku text)`)
  await q(`CREATE TABLE "${schema}"."product_images" (
    id uuid PRIMARY KEY,
    product_id uuid REFERENCES "${schema}"."products"(id)
  )`)

  invalidateSubsystemCache(projectId)
})

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.healthFinding.deleteMany({ where: { projectId } })
  await prisma.apiRequestLog.deleteMany({ where: { projectId } })
  invalidateSubsystemCache(projectId)
})

describe('clustering reads the real catalog', () => {
  it('groups the three FK-connected auth tables and separates products', async () => {
    const report = await evaluateSubsystemRecurrence(projectId, { kind: 'skeleton' })

    expect(report.noConstraintSkeleton).toBe(false)
    const auth = report.subsystems.find(s => s.membership.includes('users'))!
    expect(auth.membership).toEqual(['sessions', 'users', 'verification_tokens'])
    expect(auth.eligible).toBe(true)

    const products = report.subsystems.find(s => s.membership.includes('products'))!
    expect(products.membership).toEqual(['product_images', 'products'])
  })
})

describe('the firing case', () => {
  /**
   * The positive fixture. Everything below it asserts silence, and silence is
   * trivially achievable by a broken evaluator — so this one has to pass first
   * for any of the others to mean anything.
   */
  it('FIRES on three confirmed repairs across two gaps plus independent harm', async () => {
    await confirmedRepair('missing_rls', 'users')
    await confirmedRepair('missing_fk_index', 'sessions', 'user_id')
    await confirmedRepair('missing_fk_index', 'verification_tokens', 'user_id')

    // Harm the loop did not produce: a 5xx on one of the member tables.
    await prisma.apiRequestLog.create({
      data: {
        projectId,
        userId,
        method: 'GET',
        path: `/api/v1/${projectId}/db/sessions`,
        statusCode: 500,
        duration: 42,
        timestamp: new Date(Date.now() - 30 * 60 * 1000),
      },
    })

    const report = await evaluateSubsystemRecurrence(projectId, { kind: 'skeleton' })
    const auth = report.firing.find(s => s.membership.includes('users'))

    expect(auth).toBeDefined()
    expect(auth!.confirmedRepairs).toHaveLength(SUBSYSTEM_REPAIR_THRESHOLD)
    expect(auth!.distinctGapIdentities.length).toBeGreaterThanOrEqual(2)
    expect(auth!.independentHarm).toHaveLength(1)
    expect(auth!.independentHarm[0].kind).toBe('server_error')
  })
})

describe('each clause is genuinely required', () => {
  const threeRepairs = async () => {
    await confirmedRepair('missing_rls', 'users')
    await confirmedRepair('missing_fk_index', 'sessions', 'user_id')
    await confirmedRepair('missing_fk_index', 'verification_tokens', 'user_id')
  }

  const harm = () =>
    prisma.apiRequestLog.create({
      data: {
        projectId,
        userId,
        method: 'GET',
        path: `/api/v1/${projectId}/db/sessions`,
        statusCode: 500,
        duration: 42,
        timestamp: new Date(),
      },
    })

  it('stays quiet with no independent harm', async () => {
    await threeRepairs()
    const report = await evaluateSubsystemRecurrence(projectId, { kind: 'skeleton' })
    expect(report.firing).toHaveLength(0)
  })

  it('stays quiet when all repairs share one gap identity', async () => {
    // Same type AND same location three times: this is the flap that
    // reconciler.ts already escalates, and reporting it here is the same fact
    // told twice.
    await confirmedRepair('missing_fk_index', 'sessions', 'user_id')
    await confirmedRepair('missing_fk_index', 'sessions', 'user_id')
    await confirmedRepair('missing_fk_index', 'sessions', 'user_id')
    await harm()

    const report = await evaluateSubsystemRecurrence(projectId, { kind: 'skeleton' })
    expect(report.firing).toHaveLength(0)
  })

  it('stays quiet when the repairs were never verified', async () => {
    for (const [table, col] of [
      ['users', undefined],
      ['sessions', 'user_id'],
      ['verification_tokens', 'user_id'],
    ] as const) {
      await prisma.healthFinding.create({
        data: {
          projectId,
          type: 'missing_fk_index',
          severity: 'warning',
          status: 'auto_fixed',
          autoFixed: true,
          fixAppliedAt: new Date(),
          details: {
            tableName: table,
            ...(col ? { columnName: col } : {}),
            rollbackData: { verification: 'unverified' },
          },
        },
      })
    }
    await harm()

    const report = await evaluateSubsystemRecurrence(projectId, { kind: 'skeleton' })
    expect(report.firing).toHaveLength(0)
  })

  it('stays quiet below the repair threshold', async () => {
    await confirmedRepair('missing_rls', 'users')
    await confirmedRepair('missing_fk_index', 'sessions', 'user_id')
    await harm()

    const report = await evaluateSubsystemRecurrence(projectId, { kind: 'skeleton' })
    expect(report.firing).toHaveLength(0)
  })

  it('stays quiet when the repairs fall outside the window', async () => {
    await threeRepairs()
    await prisma.healthFinding.updateMany({
      where: { projectId },
      data: { fixAppliedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    })
    await harm()

    const report = await evaluateSubsystemRecurrence(projectId, { kind: 'skeleton' })
    expect(report.firing).toHaveLength(0)
  })

  /**
   * Repairs spread across two different subsystems are two ordinary stories,
   * not one structural one. If this fires, the grouping is not doing anything.
   */
  it('stays quiet when the repairs are spread across different subsystems', async () => {
    await confirmedRepair('missing_rls', 'users')
    await confirmedRepair('missing_fk_index', 'products', 'sku')
    await confirmedRepair('missing_fk_index', 'product_images', 'product_id')
    await harm()

    const report = await evaluateSubsystemRecurrence(projectId, { kind: 'skeleton' })
    expect(report.firing).toHaveLength(0)
  })
})

describe('the reconciler hook', () => {
  const setFlag = (on: boolean) => {
    process.env.ENABLE_SUBSYSTEM_RECURRENCE_SHADOW = on ? 'true' : 'false'
  }

  afterEach(async () => {
    delete process.env.ENABLE_SUBSYSTEM_RECURRENCE_SHADOW
    await prisma.auditLog.deleteMany({
      where: { projectId, action: 'AUTONOMY_SUBSYSTEM_RECURRENCE_SHADOW' },
    })
  })

  it('writes nothing while the flag is off', async () => {
    const { recordSubsystemRecurrenceShadow } = await import('@/lib/autonomy/reconciler')
    setFlag(false)
    await recordSubsystemRecurrenceShadow(projectId)
    expect(
      await prisma.auditLog.count({
        where: { projectId, action: 'AUTONOMY_SUBSYSTEM_RECURRENCE_SHADOW' },
      }),
    ).toBe(0)
  })

  it('writes one row carrying both clusterings when the flag is on', async () => {
    const { recordSubsystemRecurrenceShadow } = await import('@/lib/autonomy/reconciler')
    setFlag(true)
    await recordSubsystemRecurrenceShadow(projectId)

    const rows = await prisma.auditLog.findMany({
      where: { projectId, action: 'AUTONOMY_SUBSYSTEM_RECURRENCE_SHADOW' },
      select: { details: true },
    })
    expect(rows).toHaveLength(1)

    const d = JSON.parse(rows[0].details as string)
    // Both clusterings, because which one is useful is the question the shadow
    // run exists to settle.
    for (const kind of ['skeleton', 'attached'] as const) {
      expect(d[kind]).toMatchObject({
        kind,
        firedCount: expect.any(Number),
        noConstraintSkeleton: expect.any(Boolean),
        largestComponentShare: expect.any(Number),
        attributionCoverage: expect.any(Number),
      })
    }
  })

  /**
   * One project with an unreadable catalog must not stop the fleet being
   * measured, and — far more importantly — must not stop that project being
   * HEALED. The hook is awaited inside the tick, so an unhandled throw here
   * would take the reconciler down with it.
   */
  it('does not throw for a project whose schema does not exist', async () => {
    const { recordSubsystemRecurrenceShadow } = await import('@/lib/autonomy/reconciler')
    setFlag(true)
    await expect(recordSubsystemRecurrenceShadow(randomUUID())).resolves.toBeUndefined()
  })
})

describe('reported telemetry is honest', () => {
  it('reports attribution coverage below 1 when findings carry no table', async () => {
    await confirmedRepair('missing_rls', 'users')
    await prisma.healthFinding.create({
      data: {
        projectId,
        type: 'workflow_broken',
        severity: 'warning',
        status: 'auto_fixed',
        autoFixed: true,
        fixAppliedAt: new Date(),
        // Located by workflow, not by table: unattributable by construction.
        details: { workflow: 'signup', rollbackData: { verification: 'confirmed' } },
      },
    })

    const report = await evaluateSubsystemRecurrence(projectId, { kind: 'skeleton' })
    expect(report.attributionCoverage).toBeCloseTo(0.5, 5)
  })

  it('reports the largest component share', async () => {
    const report = await evaluateSubsystemRecurrence(projectId, { kind: 'skeleton' })
    // 3 of 5 tables in the auth component.
    expect(report.tableCount).toBe(5)
    expect(report.largestComponentShare).toBeCloseTo(0.6, 5)
  })
})
