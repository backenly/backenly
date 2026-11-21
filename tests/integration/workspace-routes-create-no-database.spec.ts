/**
 * THE WORKSPACE ROUTES CREATE NO DATABASE
 * =======================================
 * POST /api/workspaces, POST /api/workspaces/[workspaceId]/provision-database
 * and the executor's first phase used to "provision" a workspace: for one not
 * yet provisioned they ran CREATE DATABASE "db_<hash>" on the platform's own
 * connection and wrote that database's connection string into
 * Workspace.postgresSchema, where every reader expects a schema name.
 * DELETE /api/workspaces/[workspaceId] read the column back as a connection
 * string and dropped the database it named. That path is removed: a project's
 * workspace schema is created with the project (lib/projects/provision.ts).
 * This pins it:
 *
 *   POST /api/workspaces         creates the row only: no database, no
 *                                connection string, an existing row unchanged
 *   provision-database           a flat 404 for everyone; the row unchanged
 *   DELETE /api/workspaces/[id]  removes the row only, whatever the column holds
 *
 * Runtime engine mode, so the removed path would really have run its DDL here.
 * Real routes, rows and catalog; only the sign-in wrapper is delegated, as in
 * tests/integration/project-limit-before-the-form.spec.ts.
 */
let currentUserId = ''
jest.mock('@/lib/auth/route-protection', () => {
  const actual = jest.requireActual('@/lib/auth/route-protection')
  return {
    ...actual,
    withAuth: (handler: any) => async (request: any, ctx: any = {}) =>
      handler(request, { user: { userId: currentUserId, email: 'owner@example.test' }, params: ctx.params }),
  }
})

import '../helpers/real-web-standard'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { POST as createWorkspace } from '@/app/api/workspaces/route'
import { DELETE as deleteWorkspace } from '@/app/api/workspaces/[workspaceId]/route'
import { POST as provisionDatabase } from '@/app/api/workspaces/[workspaceId]/provision-database/route'

jest.setTimeout(120_000)

const homeUrl = () => process.env.DATABASE_URL as string
function urlFor(database: string): string {
  const url = new URL(homeUrl())
  url.pathname = `/${database}`
  return url.toString()
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: homeUrl() })
  await client.connect()
  try {
    return (await client.query(sql, params)).rows as T[]
  } finally {
    await client.end().catch(() => {})
  }
}

const databaseExists = async (name: string) =>
  (await rows<{ n: number }>('SELECT count(*)::int AS n FROM pg_database WHERE datname = $1', [name]))[0].n === 1

/** The name the removed path gave a project's database. */
const legacyDatabaseName = (projectId: string) =>
  `db_${createHash('sha256').update(projectId).digest('hex').slice(0, 16)}`

/** The database a legacy row's connection string names; it must outlive DELETE. */
const NAMED_DB = `backenly_wsdel_${randomBytes(4).toString('hex')}`
let namedDbCreated = false

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_ENGINE_MODE = process.env.ENGINE_MODE

let ownerId = ''
let strangerId = ''
let bareProject = ''
let provisionedProject = ''
let unprovisionedProject = ''
let legacyProject = ''

const project = async (name: string) =>
  (await prisma.project.create({ data: { name: `${name}-${randomUUID()}`, userId: ownerId }, select: { id: true } })).id

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  // Cloud, so a stranger is a stranger (single-tenant treats any account as the operator).
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'

  ownerId = (await prisma.user.create({ data: { email: `ws-nodb-${randomUUID()}@example.test`, name: 'owner' } })).id
  strangerId = (await prisma.user.create({ data: { email: `ws-nodb-${randomUUID()}@example.test`, name: 'stranger' } })).id

  bareProject = await project('ws-nodb-bare')
  provisionedProject = await project('ws-nodb-provisioned')
  unprovisionedProject = await project('ws-nodb-unprovisioned')
  legacyProject = await project('ws-nodb-legacy')

  // As createProvisionedProject writes it.
  await prisma.workspace.create({
    data: {
      name: 'provisioned',
      projectId: provisionedProject,
      postgresSchema: `workspace_${provisionedProject}`,
      databaseProvisioned: true,
      databaseProvisionedAt: new Date(),
    },
  })
  // A row nothing provisioned: what the removed path acted on.
  await prisma.workspace.create({ data: { name: 'unprovisioned', projectId: unprovisionedProject } })

  // A row the removed path left behind: a connection string in postgresSchema,
  // naming a database that exists.
  await rows(`CREATE DATABASE "${NAMED_DB}"`)
  namedDbCreated = true
  await prisma.workspace.create({
    data: { name: 'legacy', projectId: legacyProject, postgresSchema: urlFor(NAMED_DB), databaseProvisioned: true },
  })
})

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  if (ORIGINAL_ENGINE_MODE === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = ORIGINAL_ENGINE_MODE

  const ids = [bareProject, provisionedProject, unprovisionedProject, legacyProject].filter(Boolean)
  for (const id of ids) {
    await rows(`DROP DATABASE IF EXISTS "${legacyDatabaseName(id)}" WITH (FORCE)`).catch(() => {})
  }
  if (namedDbCreated) await rows(`DROP DATABASE IF EXISTS "${NAMED_DB}" WITH (FORCE)`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId].filter(Boolean) } } }).catch(() => {})
})

const workspaceOf = (projectId: string) =>
  prisma.workspace.findUnique({
    where: { projectId },
    select: { id: true, postgresSchema: true, databaseProvisioned: true, mongodbDatabase: true },
  })

const post = (projectId: string) =>
  createWorkspace(
    new NextRequest('http://localhost:3000/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'from the route', projectId }),
    }),
    {} as any,
  )

describe('POST /api/workspaces', () => {
  it('creates the row only: no database, and no connection string in postgresSchema', async () => {
    currentUserId = ownerId
    const res = await post(bareProject)
    expect(res.status).toBe(201)

    const row = await workspaceOf(bareProject)
    expect(row).not.toBeNull()
    expect(row!.postgresSchema).toBeNull()
    expect(row!.databaseProvisioned).toBe(false)
    expect(await databaseExists(legacyDatabaseName(bareProject))).toBe(false)
  })

  it("leaves a provisioned project's workspace as it was, its schema name included", async () => {
    currentUserId = ownerId
    const before = await workspaceOf(provisionedProject)
    const res = await post(provisionedProject)
    expect(res.status).toBe(200)
    expect(await workspaceOf(provisionedProject)).toEqual(before)
    expect(before!.postgresSchema).toBe(`workspace_${provisionedProject}`)
    expect(await databaseExists(legacyDatabaseName(provisionedProject))).toBe(false)
  })
})

describe('POST /api/workspaces/[workspaceId]/provision-database', () => {
  it('answers 404 to everyone and changes nothing, provisioned or not', async () => {
    for (const projectId of [unprovisionedProject, provisionedProject]) {
      const before = await workspaceOf(projectId)
      for (const who of [ownerId, strangerId, '']) {
        currentUserId = who
        const res = await provisionDatabase()
        expect(res.status).toBe(404)
      }
      expect(await workspaceOf(projectId)).toEqual(before)
      expect(await databaseExists(legacyDatabaseName(projectId))).toBe(false)
    }
    const unprovisioned = await workspaceOf(unprovisionedProject)
    expect(unprovisioned!.postgresSchema).toBeNull()
    expect(unprovisioned!.databaseProvisioned).toBe(false)
  })
})

describe('DELETE /api/workspaces/[workspaceId]', () => {
  it('removes the row only, and never drops the database a connection string in it names', async () => {
    currentUserId = ownerId
    const row = await workspaceOf(legacyProject)
    expect(row!.postgresSchema).toContain('://')

    const res = await deleteWorkspace(
      new NextRequest(`http://localhost:3000/api/workspaces/${row!.id}`, { method: 'DELETE' }),
      {} as any,
    )
    expect(res.status).toBe(200)
    expect(await workspaceOf(legacyProject)).toBeNull()
    expect(await databaseExists(NAMED_DB)).toBe(true)
  })
})
