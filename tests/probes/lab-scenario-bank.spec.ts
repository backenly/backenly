/**
 * THE VALIDATION LAB MUST ITSELF BE CORRECT
 * =========================================
 *
 * Every phase suite from here on asserts behaviour against the scenario bank.
 * That makes the bank a shared dependency, and a wrong fixture is worse than a
 * missing one: it produces confident green results about a backend that does
 * not exist.
 *
 * So this suite tests the LAB, not the product. It proves each scenario
 * materialises the topology it claims, that the clusterer agrees with the
 * expectation written next to it, and that the awkward scenarios (no
 * constraints, view-heavy, hub-dominated) really do have the shapes they were
 * added to represent.
 *
 * This is the gate that replaced "watch production". It can answer whether the
 * machinery is correct. It deliberately cannot answer whether the pattern is
 * common in real customer systems — there are no real customers yet, and
 * pretending otherwise is the failure this whole redesign exists to avoid.
 */

import { PrismaClient } from '@prisma/client'

import { SCENARIOS, scenario } from '../lab/scenarios'
import { seedScenario, teardownScenario, type SeededProject } from '../lab/seed'
import { computeSubsystems, invalidateSubsystemCache } from '@/lib/autonomy/subsystem'

const prisma = new PrismaClient()
const seeded: SeededProject[] = []

async function seed(id: string, ledger = {}): Promise<SeededProject> {
  const s = await seedScenario(prisma, scenario(id), ledger)
  seeded.push(s)
  invalidateSubsystemCache(s.projectId)
  return s
}

afterAll(async () => {
  for (const s of seeded) await teardownScenario(prisma, s)
  await prisma.$disconnect()
})

/** Components with more than one member, sorted — singletons carry no claim. */
const components = (subsystems: Array<{ membership: string[] }>) =>
  subsystems
    .map(s => s.membership)
    .filter(m => m.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]))

describe('the bank is internally consistent', () => {
  it('every scenario has a unique id', () => {
    const ids = SCENARIOS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every declared foreign key points at a table in the same scenario', () => {
    for (const sc of SCENARIOS) {
      const names = new Set(sc.tables.map(t => t.name))
      for (const t of sc.tables) {
        for (const [, ref] of t.foreignKeys ?? []) {
          expect(names.has(ref)).toBe(true)
        }
      }
    }
  })

  it('covers the shapes the roadmap depends on', () => {
    // A bank of six healthy schemas would validate nothing. The awkward cases
    // are the reason it exists.
    const ids = SCENARIOS.map(s => s.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'auth-heavy', // the target shape
        'messy-legacy', // no constraints at all
        'view-heavy', // topology distortion
        'multi-tenant-saas', // hub-dominated blob
        'content-community', // healthy control
      ]),
    )
  })
})

describe('each scenario materialises the topology it claims', () => {
  it.each(SCENARIOS.map(s => [s.id] as const))('%s', async id => {
    const s = await seed(id)
    const map = await computeSubsystems(s.projectId, 'skeleton')
    expect(components(map.subsystems)).toEqual(s.scenario.expectedSkeletonComponents)
  })
})

describe('the awkward scenarios really are awkward', () => {
  it('messy-legacy has no constraint skeleton at all', async () => {
    const s = await seed('messy-legacy')
    const map = await computeSubsystems(s.projectId, 'skeleton')

    expect(map.noConstraintSkeleton).toBe(true)
    expect(map.subsystems.every(x => !x.eligible)).toBe(true)
    // The honest result: the feature declines to reason about this backend
    // rather than guessing from column names.
  })

  it('view-heavy reports the physical model only', async () => {
    const s = await seed('view-heavy')
    const map = await computeSubsystems(s.projectId, 'attached')

    // Four base tables, despite ten views and a materialized view.
    expect(map.tables).toEqual(['product_images', 'products', 'sessions', 'users'])
    expect(JSON.stringify(map.subsystems)).not.toMatch(/v_report|mv_user_count/)
  })

  it('multi-tenant-saas produces a blob the breadth guard refuses', async () => {
    const s = await seed('multi-tenant-saas')
    const map = await computeSubsystems(s.projectId, 'skeleton')

    const blob = map.subsystems.find(x => x.membership.includes('organizations'))!
    expect(blob.membership).toHaveLength(5)
    expect(blob.eligible).toBe(false)
    expect(blob.ineligibleReason).toMatch(/too broad/)
  })

  it('ecommerce keeps orders and catalogue apart despite the shared users hub', async () => {
    const s = await seed('ecommerce')
    const map = await computeSubsystems(s.projectId, 'attached')

    const orders = map.subsystems.find(x => x.membership.includes('orders'))!
    const products = map.subsystems.find(x => x.membership.includes('products'))!
    expect(orders.fingerprint).not.toBe(products.fingerprint)
    expect(orders.membership).not.toContain('products')
    expect(products.membership).not.toContain('orders')
  })
})

describe('seeded rows and statistics are real', () => {
  /**
   * Several probes gate on `reltuples`, which is -1 until a table is analysed.
   * An un-analysed lab project reports clean for the wrong reason, and a suite
   * built on it would assert silence that proves nothing.
   */
  it('tables carry rows and analysed statistics', async () => {
    const s = await seed('auth-heavy')
    const rows = await prisma.$queryRawUnsafe<Array<{ relname: string; reltuples: number }>>(
      `SELECT c.relname, c.reltuples::float8 AS reltuples
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r'`,
      s.schema,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.reltuples).toBeGreaterThan(0)
    }
  })
})

describe('the ledger seeder writes the shapes production writes', () => {
  it('stamps confirmed repairs where the kernel stamps them', async () => {
    const s = await seed('auth-heavy', {
      confirmedRepairs: [{ type: 'missing_rls', table: 'users' }],
      unverifiedRepairs: [{ type: 'missing_fk_index', table: 'sessions', column: 'user_id' }],
    })

    const rows = await prisma.healthFinding.findMany({
      where: { projectId: s.projectId },
      select: { type: true, details: true },
    })
    const byType = Object.fromEntries(rows.map(r => [r.type, r.details as any]))

    // The exact accessor trust-report and the recurrence evaluator both read.
    expect(byType['missing_rls'].rollbackData.verification).toBe('confirmed')
    expect(byType['missing_fk_index'].rollbackData.verification).toBe('unverified')
  })

  it('writes request logs on the generated data-plane path', async () => {
    const s = await seed('ecommerce', { serverErrors: [{ table: 'orders' }] })
    const log = await prisma.apiRequestLog.findFirst({ where: { projectId: s.projectId } })
    expect(log?.path).toContain('/db/orders')
    expect(log?.statusCode).toBe(500)
  })

  it('writes change events with resource identity where the executor puts it', async () => {
    const s = await seed('ecommerce', { changes: [{ table: 'orders' }] })
    const ev = await prisma.backendEvent.findFirst({ where: { projectId: s.projectId } })
    expect((ev?.beforeState as any).resource).toBe('orders')
  })
})

describe('teardown is complete', () => {
  it('drops the schema and the project rows', async () => {
    const s = await seedScenario(prisma, scenario('content-community'))
    await teardownScenario(prisma, s)

    const left = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = $1`,
      s.schema,
    )
    expect(left[0].n).toBe(0)
    expect(await prisma.project.count({ where: { id: s.projectId } })).toBe(0)
  })
})
