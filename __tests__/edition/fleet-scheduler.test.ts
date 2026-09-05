/**
 * WHICH PROJECTS DOES A SCHEDULED PASS RUN AGAINST
 * ================================================
 * FleetScheduler is the fourth edition seam. It answers WHICH, never WHAT: the
 * reconciler, the health scan, the baseline collector and the storage sweep are
 * all public product and all unchanged.
 *
 * ---- THE PROPERTY THAT MATTERS ------------------------------------------
 *
 * Single-tenant must not ENUMERATE. Every one of these sweeps used to open with
 *
 *   prisma.project.findMany({ where: activeProjectsWhere() })
 *
 * which returns whatever eligible rows the database holds. On a self-hosted
 * deployment that is the wrong question: there is one project and its id is
 * known. A restore, a copied dump or a Cloud database pointed at by mistake all
 * put extra rows in that table, and the single-tenant resolver treats every
 * authenticated account as an operator of whatever comes back. So the assertion
 * below is not "returns one project" -- it is "returns THE project while a
 * second, equally eligible row sits in the same table".
 *
 * A mock cannot show that. The predicate under test IS a `where` clause.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { getFleetScheduler } from '@/lib/edition'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const createdUserIds: string[] = []
const createdProjectIds: string[] = []

async function makeUser(): Promise<string> {
  const u = await prisma.user.create({
    data: { email: `fleet-${randomUUID()}@test.invalid`, name: 'Fleet Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  return u.id
}

/**
 * A project the activity gate will accept.
 *
 * The gate wants a backend that exists (a table, or an open finding) AND a sign
 * of life inside the window. A freshly created project satisfies the second
 * through `createdAt`, so only the table has to be built.
 */
async function makeEligibleProject(userId: string | null): Promise<string> {
  const p = await prisma.project.create({
    data: { name: `fleet-${randomUUID().slice(0, 8)}`, userId },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  await prisma.table.create({ data: { projectId: p.id, name: `t_${randomUUID().slice(0, 8)}` } })
  return p.id
}

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_PINNED = process.env.BACKENLY_PROJECT_ID

beforeAll(() => {
  assertSafeTestDatabase()
})

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  if (ORIGINAL_PINNED === undefined) delete process.env.BACKENLY_PROJECT_ID
  else process.env.BACKENLY_PROJECT_ID = ORIGINAL_PINNED
  resetSingleTenantCache()
})

afterAll(async () => {
  if (createdProjectIds.length) {
    await prisma.table.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
})

// ============================================================================
// SINGLE-TENANT: THE FLEET IS ONE PROJECT
// ============================================================================

describe('single-tenant: scheduled passes target THE project only', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'single-tenant'
  })

  it('returns THE project while another eligible row sits in the same table', async () => {
    const operatorId = await makeUser()
    const theProject = await makeEligibleProject(operatorId)
    const strayProject = await makeEligibleProject(await makeUser())
    process.env.BACKENLY_PROJECT_ID = theProject

    const targets = await getFleetScheduler().activeTargets()

    expect(targets.map(t => t.id)).toEqual([theProject])
    expect(targets.map(t => t.id)).not.toContain(strayProject)
  })

  it('applies the same eligibility rule, so an empty project is not swept', async () => {
    // The gate is product policy and stays public: a project with no tables and
    // no open findings has no backend to reconcile in EITHER edition. Only the
    // set it runs over is an edition question.
    const p = await prisma.project.create({
      data: { name: `fleet-empty-${randomUUID().slice(0, 8)}`, userId: await makeUser() },
      select: { id: true },
    })
    createdProjectIds.push(p.id)
    process.env.BACKENLY_PROJECT_ID = p.id

    await expect(getFleetScheduler().activeTargets()).resolves.toEqual([])
  })

  it('still covers a quiet project for maintenance, which has no activity gate', async () => {
    // Measurement and cleanup are not healing. A project nobody has touched
    // still occupies disk and still has its storage measured.
    const p = await prisma.project.create({
      data: { name: `fleet-quiet-${randomUUID().slice(0, 8)}`, userId: await makeUser() },
      select: { id: true },
    })
    createdProjectIds.push(p.id)
    process.env.BACKENLY_PROJECT_ID = p.id

    const targets = await getFleetScheduler().maintenanceTargets()

    expect(targets.map(t => t.id)).toEqual([p.id])
  })

  it('targets nothing rather than throwing before bootstrap has run', async () => {
    process.env.BACKENLY_PROJECT_ID = randomUUID()

    await expect(getFleetScheduler().activeTargets()).resolves.toEqual([])
    await expect(getFleetScheduler().maintenanceTargets()).resolves.toEqual([])
  })

  it('carries the owner, so a model-backed sweep needs no second query', async () => {
    const operatorId = await makeUser()
    const theProject = await makeEligibleProject(operatorId)
    process.env.BACKENLY_PROJECT_ID = theProject

    const targets = await getFleetScheduler().activeTargets()

    expect(targets).toEqual([{ id: theProject, userId: operatorId }])
  })
})

// ============================================================================
// CLOUD: THE MANAGED ESTATE
// ============================================================================

describe('cloud: scheduled passes target every eligible project', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
  })

  it('returns more than one project, which is the whole difference', async () => {
    const a = await makeEligibleProject(await makeUser())
    const b = await makeEligibleProject(await makeUser())

    const ids = (await getFleetScheduler().activeTargets()).map(t => t.id)

    expect(ids).toContain(a)
    expect(ids).toContain(b)
  })

  it('honours the activity window it is given', async () => {
    // windowDays is a parameter; the DEFINITION of activity is not. A project
    // created just now is inside every window, so a narrow one must still
    // include it -- this pins that the argument reaches the gate at all.
    const fresh = await makeEligibleProject(await makeUser())

    const ids = (await getFleetScheduler().activeTargets({ windowDays: 1 })).map(t => t.id)

    expect(ids).toContain(fresh)
  })

  it('leaves an empty project out of an active pass and in a maintenance one', async () => {
    const p = await prisma.project.create({
      data: { name: `fleet-cloud-empty-${randomUUID().slice(0, 8)}`, userId: await makeUser() },
      select: { id: true },
    })
    createdProjectIds.push(p.id)

    expect((await getFleetScheduler().activeTargets()).map(t => t.id)).not.toContain(p.id)
    expect((await getFleetScheduler().maintenanceTargets()).map(t => t.id)).toContain(p.id)
  })
})
