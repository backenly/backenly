/**
 * A PROJECT IS RECORDED AT HOME ONLY ONCE ITS SCHEMA EXISTS
 * ========================================================
 * createProvisionedProject (lib/projects/provision.ts) creates the workspace
 * schema in the database of the project's region first, and only then writes
 * the project row, its backend graph and its workspace row at home, in one
 * transaction. This suite pins what that order is for:
 *
 *   region configured, database unreachable    throws, and leaves no project,
 *                                               graph or workspace row at home
 *   home region, nothing failing                every row, and the schema
 *   region reachable                            the schema there and only there
 *   home rows refused after the schema exists   the schema is dropped from the
 *                                               region's database, and the
 *                                               transaction's own error thrown
 *
 * A second database stands in for another region's, as in
 * project-region.spec.ts, so every workspace schema in it is one this suite
 * made. Rows and schemas are the property, so it needs a real Postgres.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { createProvisionedProject } from '@/lib/projects/provision'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'

jest.setTimeout(60_000)

const REGION = 'us-east-1'
const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
const REGIONAL_DB = `backenly_creation_${randomBytes(4).toString('hex')}`
// Configured, so the region is not refused for lacking a connection, but
// nothing listens on port 1: the database cannot be reached.
const UNREACHABLE_URL = 'postgresql://ci:ci@127.0.0.1:1/unreachable'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_REGION_URL = process.env[REGION_VARIABLE]

let ownerId = ''
let regionalUrl = ''
let regionalDbCreated = false

const homeUrl = () => process.env.DATABASE_URL as string

function urlFor(database: string): string {
  const url = new URL(homeUrl())
  url.pathname = `/${database}`
  return url.toString()
}

async function run(connectionString: string, sql: string): Promise<void> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end().catch(() => {})
  }
}

async function rowsIn<T>(connectionString: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return (await client.query(sql, params)).rows as T[]
  } finally {
    await client.end().catch(() => {})
  }
}

/** Every workspace schema a database holds. */
async function workspaceSchemasIn(connectionString: string): Promise<string[]> {
  const rows = await rowsIn<{ nspname: string }>(
    connectionString,
    `SELECT nspname FROM pg_namespace WHERE left(nspname, 10) = 'workspace_' ORDER BY nspname`,
  )
  return rows.map((row) => row.nspname)
}

async function schemaExistsIn(connectionString: string, schema: string): Promise<boolean> {
  const rows = await rowsIn(connectionString, `SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema])
  return rows.length === 1
}

/** The rows the provisioner writes at home, counted across the whole table. */
async function homeRowCounts(): Promise<{ projects: number; graphs: number; workspaces: number }> {
  const [projects, graphs, workspaces] = await Promise.all([
    prisma.project.count(),
    prisma.backendGraph.count(),
    prisma.workspace.count(),
  ])
  return { projects, graphs, workspaces }
}

/** Point the region at `url`, closing any client still open on its previous address. */
async function connectRegion(url: string | undefined): Promise<void> {
  await disconnectRegionalClients()
  if (url === undefined) delete process.env[REGION_VARIABLE]
  else process.env[REGION_VARIABLE] = url
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  // Project creation is refused on a single-tenant deployment, the default.
  process.env.BACKENLY_EDITION = 'cloud'
  regionalUrl = urlFor(REGIONAL_DB)

  const user = await prisma.user.create({
    data: { email: `creation-order-${randomUUID()}@example.test`, name: 'creation order fixture' },
    select: { id: true },
  })
  ownerId = user.id

  await run(homeUrl(), `CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
})

afterAll(async () => {
  await connectRegion(ORIGINAL_REGION_URL)
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION

  if (regionalDbCreated) {
    await run(homeUrl(), `DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`).catch(() => {})
  }
  if (!ownerId) return
  // By owner rather than by the ids the tests recorded, so a project a failing
  // case left behind is removed too.
  const ids = (await prisma.project.findMany({ where: { userId: ownerId }, select: { id: true } })).map((p) => p.id)
  for (const id of ids) {
    await run(homeUrl(), `DROP SCHEMA IF EXISTS "${workspaceSchemaName(id)}" CASCADE`).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('a region whose database cannot be reached', () => {
  beforeAll(() => connectRegion(UNREACHABLE_URL))

  it('refuses the project and leaves no project, graph or workspace row at home', async () => {
    const name = `creation-unreachable-${randomUUID()}`
    const before = await homeRowCounts()

    const err = await createProvisionedProject({ name, userId: ownerId, region: REGION }).then(
      () => null,
      (e: unknown) => e,
    )

    // The connection itself failed. A region with no variable set is refused
    // too, but before its database is asked anything, which is not this case.
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Can't reach database server/)

    expect(await prisma.project.count({ where: { name } })).toBe(0)
    expect(await prisma.workspace.count({ where: { name: `${name} Workspace` } })).toBe(0)
    expect(await homeRowCounts()).toEqual(before)
  })
})

describe('a home-region project', () => {
  it('gets its project row, backend graph, workspace row and schema', async () => {
    const name = `creation-home-${randomUUID()}`
    const created = await createProvisionedProject({ name, userId: ownerId })

    expect(created.postgresSchema).toBe(workspaceSchemaName(created.id))

    const row = await prisma.project.findUniqueOrThrow({
      where: { id: created.id },
      select: { name: true, userId: true, slug: true, region: true, activeGraphId: true },
    })
    expect(row).toMatchObject({ name, userId: ownerId, slug: created.slug, region: null })

    const graphs = await prisma.backendGraph.findMany({ where: { projectId: created.id }, select: { id: true } })
    expect(graphs.map((graph) => graph.id)).toEqual([row.activeGraphId])

    const workspaces = await prisma.workspace.findMany({
      where: { projectId: created.id },
      select: { postgresSchema: true, userId: true, databaseProvisioned: true, databaseProvisionedAt: true },
    })
    expect(workspaces).toEqual([
      {
        postgresSchema: created.postgresSchema,
        userId: ownerId,
        databaseProvisioned: true,
        databaseProvisionedAt: expect.any(Date),
      },
    ])

    expect(await schemaExistsIn(homeUrl(), created.postgresSchema)).toBe(true)
  })
})

describe('a region whose database answers', () => {
  beforeAll(() => connectRegion(regionalUrl))

  it('gets the schema in its own database and the rows at home', async () => {
    const created = await createProvisionedProject({
      name: `creation-regional-${randomUUID()}`,
      userId: ownerId,
      region: REGION,
    })

    expect(await workspaceSchemasIn(regionalUrl)).toEqual([created.postgresSchema])
    expect(await schemaExistsIn(homeUrl(), created.postgresSchema)).toBe(false)

    const row = await prisma.project.findUniqueOrThrow({
      where: { id: created.id },
      select: { region: true, activeGraphId: true },
    })
    expect(row.region).toBe(REGION)
    expect(row.activeGraphId).toBeTruthy()
    expect(
      await prisma.workspace.count({
        where: { projectId: created.id, postgresSchema: created.postgresSchema, databaseProvisioned: true },
      }),
    ).toBe(1)
  })

  it('drops the schema it made when the rows cannot be written at home, and throws the reason', async () => {
    // A slug another project already holds: the home transaction refuses the
    // row only after the schema exists, as a concurrent creation that took the
    // same slug first would make it.
    const slug = `creation-taken-${randomUUID().slice(0, 8)}`
    await prisma.project.create({ data: { name: 'slug holder', slug, userId: ownerId } })

    const name = `creation-refused-${randomUUID()}`
    const schemasBefore = await workspaceSchemasIn(regionalUrl)
    const before = await homeRowCounts()

    const err = await createProvisionedProject({ name, userId: ownerId, region: REGION, slug }).then(
      () => null,
      (e: unknown) => e,
    )

    // The transaction's own error, not one from the cleanup.
    expect(err).toMatchObject({ code: 'P2002' })

    expect(await workspaceSchemasIn(regionalUrl)).toEqual(schemasBefore)
    expect(await prisma.project.count({ where: { name } })).toBe(0)
    expect(await prisma.workspace.count({ where: { name: `${name} Workspace` } })).toBe(0)
    expect(await homeRowCounts()).toEqual(before)
  })
})
