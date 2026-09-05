/**
 * WHICH PROJECTS EXIST, AND MAY ANOTHER BE CREATED
 * ================================================
 * ProjectLifecycle is the second edition seam. The first (ProjectResolver)
 * answers "may this caller reach THIS project"; this one answers "which
 * projects are there at all", and the two editions answer it differently
 * enough that a shared implementation is what produced the bugs below.
 *
 * ---- WHY A REAL DATABASE -------------------------------------------------
 *
 * Every property here is a property of rows. "Creating a project cannot create
 * a second Project row" is not observable against a mock, and neither is
 * "creation provisions a workspace, a graph, a schema registration and a
 * signing secret" -- which is the whole difference between a project and a
 * Project row. A mocked client would report success for a creation path that
 * writes one row and nothing else, which is exactly the defect
 * lib/projects/provision.ts exists to prevent.
 *
 * ---- WHAT SINGLE-TENANT MUST NOT DO -------------------------------------
 *
 * It must not enumerate. A self-hosted deployment that answers "which
 * projects" with a table scan will show whatever rows are in the database, and
 * its resolver treats every authenticated account as an operator of what it
 * returns. So the assertion is not merely "returns one project"; it is
 * "returns THE pinned project, while another row sits in the same table".
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { getProjectLifecycle } from '@/lib/edition'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { ProjectCreationUnsupportedError } from '@/lib/projects/provision'

const DB_URL = process.env.TEST_DATABASE_URL

/** Cleanup is scoped to this file own rows: suites share one database. */
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
    data: { email: `lifecycle-${randomUUID()}@test.invalid`, name: 'Lifecycle Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  return u.id
}

async function makeProject(userId: string | null): Promise<string> {
  const p = await prisma.project.create({
    data: { name: `lifecycle-${randomUUID().slice(0, 8)}`, userId },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  return p.id
}

/** Drop a project workspace schema as well as its rows. */
async function dropWorkspaceSchema(projectId: string): Promise<void> {
  const schema = `workspace_${projectId.replace(/-/g, '_')}`
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
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
  for (const id of createdProjectIds) await dropWorkspaceSchema(id)
  if (createdProjectIds.length) {
    await prisma.apiKey.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.backendGraph.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.workspace.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
})

// ============================================================================
// SINGLE-TENANT: ONE DEPLOYMENT IS ONE PROJECT
// ============================================================================

describe('single-tenant: listing resolves THE project', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'single-tenant'
  })

  it('returns the pinned project and ignores every other row in the table', async () => {
    const operatorId = await makeUser()
    const theProject = await makeProject(operatorId)
    // A second row that must stay invisible. On a self-hosted deployment every
    // authenticated account is an operator of whatever the listing returns, so
    // enumerating here would hand this row to everyone with a login.
    const strayProject = await makeProject(await makeUser())
    process.env.BACKENLY_PROJECT_ID = theProject

    const listed = await getProjectLifecycle().list(operatorId)

    expect(listed.map(p => p.id)).toEqual([theProject])
    expect(listed.map(p => p.id)).not.toContain(strayProject)
  })

  it('lists THE project for an operator who does not own it', async () => {
    // Bootstrap creates the project before anyone has signed up, so an
    // ownership filter here showed the operator an empty dashboard on every
    // fresh install while GET /api/projects/<id> returned that same project.
    const theProject = await makeProject(null)
    process.env.BACKENLY_PROJECT_ID = theProject

    const listed = await getProjectLifecycle().list(await makeUser())

    expect(listed.map(p => p.id)).toEqual([theProject])
  })

  it('lists nothing rather than throwing before bootstrap has run', async () => {
    // The pinned id names a project that does not exist. A listing renders an
    // empty dashboard; the paths that RESOLVE a project still refuse, which is
    // where refusing is the safe outcome.
    process.env.BACKENLY_PROJECT_ID = randomUUID()

    await expect(getProjectLifecycle().list(await makeUser())).resolves.toEqual([])
  })
})

describe('single-tenant: a second project cannot be created', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'single-tenant'
  })

  it('refuses, and writes no row', async () => {
    const userId = await makeUser()
    const theProject = await makeProject(userId)
    process.env.BACKENLY_PROJECT_ID = theProject

    const before = await prisma.project.count()

    const err = await getProjectLifecycle()
      .create({ name: 'a second project', userId })
      .then(() => null, e => e)

    expect(err).toBeInstanceOf(ProjectCreationUnsupportedError)
    expect(err.code).toBe('PROJECT_CREATION_UNSUPPORTED')

    // The refusal is only worth anything if it happened BEFORE the insert.
    expect(await prisma.project.count()).toBe(before)
  })
})

// ============================================================================
// CLOUD: MULTI-PROJECT, FILTERED BY ACCESS
// ============================================================================

describe('cloud: listing is filtered by access', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
  })

  it('returns the projects the caller owns', async () => {
    const userId = await makeUser()
    const mine = await makeProject(userId)

    const listed = await getProjectLifecycle().list(userId)

    expect(listed.map(p => p.id)).toContain(mine)
  })

  it('never returns a project belonging to a stranger', async () => {
    const strangerId = await makeUser()
    const theirs = await makeProject(await makeUser())

    const listed = await getProjectLifecycle().list(strangerId)

    expect(listed.map(p => p.id)).not.toContain(theirs)
  })
})

describe('cloud: creation provisions a project, not a row', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
  })

  it('creates the row, the graph, the schema, the registration and the secret', async () => {
    const userId = await makeUser()

    const { project, apiKey } = await getProjectLifecycle().create({
      name: `lifecycle create ${randomUUID().slice(0, 8)}`,
      description: 'provisioning proof',
      userId,
    })
    createdProjectIds.push(project.id)

    // 1. The row, owned by the caller, with the presentation fields the route
    //    used to patch on afterwards.
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { userId: true, slug: true, environment: true, activeGraphId: true, jwtSecret: true },
    })
    expect(row.userId).toBe(userId)
    expect(row.slug).toBeTruthy()
    expect(row.environment).toBe('development')

    // 2. The backend graph, and the pointer to it. Without the pointer the
    //    brain and the autonomy loop have no state to reconcile against.
    expect(row.activeGraphId).toBeTruthy()
    expect(await prisma.backendGraph.count({ where: { projectId: project.id } })).toBe(1)

    // 3. Exactly ONE workspace. The route used to run its workspace block
    //    twice; the second copy always threw on @@unique([projectId]) and was
    //    swallowed, logging a failure on every successful creation.
    const workspaces = await prisma.workspace.findMany({
      where: { projectId: project.id },
      select: { postgresSchema: true, databaseProvisioned: true },
    })
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0].databaseProvisioned).toBe(true)

    // 4. The schema really exists in Postgres, not merely in a workspace row.
    const schema = workspaces[0].postgresSchema!
    const found = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM information_schema.schemata WHERE schema_name = $1`,
      schema,
    )
    expect(Number(found[0].n)).toBe(1)

    // 5. The end-user auth signing secret, so built-in auth works from day zero.
    expect(row.jwtSecret).toBeTruthy()

    // 6. The default key, returned once and never persisted in plaintext.
    expect(apiKey).toMatch(/^sk_live_[0-9a-f]{64}$/)
    const keys = await prisma.apiKey.findMany({
      where: { projectId: project.id },
      select: { key: true, keyHash: true },
    })
    expect(keys).toHaveLength(1)
    expect(keys[0].key).not.toBe(apiKey)
    expect(keys[0].keyHash).toHaveLength(64)
  })

  it('shows the new project to its creator and to nobody else', async () => {
    const userId = await makeUser()
    const strangerId = await makeUser()

    const { project } = await getProjectLifecycle().create({
      name: `lifecycle visible ${randomUUID().slice(0, 8)}`,
      userId,
    })
    createdProjectIds.push(project.id)

    expect((await getProjectLifecycle().list(userId)).map(p => p.id)).toContain(project.id)
    expect((await getProjectLifecycle().list(strangerId)).map(p => p.id)).not.toContain(project.id)
  })
})
