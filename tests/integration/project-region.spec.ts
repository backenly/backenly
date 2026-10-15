/**
 * A PROJECT'S DATA IS READ IN ITS OWN REGION, AND NOWHERE ELSE
 * ============================================================
 * Backenly Cloud keeps each project's workspace schema in the region it was
 * created in (lib/data-plane/regional.ts). This suite creates a second
 * database as the stand-in for another region's, puts one project's schema
 * ONLY there, and pins:
 *
 *   home project (region null)          served from DATABASE_URL, as always
 *   regional project, no connection     refused with REGION_NOT_CONFIGURED
 *   regional project, connection set    served from the regional database,
 *                                       whose marker row exists nowhere else
 *   the raw-SQL client                  the same split
 *   a region this build does not know   refused, never read as home
 *
 * The refusal is the property that matters. The home database holds no schema
 * for the regional project, and Postgres accepts a missing schema on the
 * search_path without complaint, so falling back would not reliably fail: a
 * query could answer from the platform's own tables instead.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db'
import { disconnectRegionalClients, projectRegion, workspaceRawClient } from '@/lib/data-plane/regional'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { closeAllWorkspacePools, queryWorkspace } from '@/lib/services/workspace-pool'

jest.setTimeout(120_000)

const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
const REGIONAL_DB = `backenly_region_${randomBytes(4).toString('hex')}`

let homeDb = ''
let regionalUrl = ''
let ownerId = ''
let homeProject = ''
let regionalProject = ''
let unknownProject = ''
let regionalDbCreated = false

const homeUrl = () => process.env.DATABASE_URL as string
const schemaOf = (projectId: string) => getWorkspaceDatabaseNames(projectId).postgresSchema

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

async function createProject(region: string | null): Promise<string> {
  const project = await prisma.project.create({
    data: { name: `region-${randomUUID()}`, userId: ownerId, region },
    select: { id: true },
  })
  return project.id
}

async function seedMarker(connectionString: string, schema: string, note: string): Promise<void> {
  await run(
    connectionString,
    `CREATE SCHEMA "${schema}";
     CREATE TABLE "${schema}".marker (note text);
     INSERT INTO "${schema}".marker VALUES ('${note}')`,
  )
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  delete process.env[REGION_VARIABLE]
  homeDb = new URL(homeUrl()).pathname.slice(1)
  regionalUrl = urlFor(REGIONAL_DB)

  const user = await prisma.user.create({
    data: { email: `region-${randomUUID()}@example.test`, name: 'region fixture' },
    select: { id: true },
  })
  ownerId = user.id

  homeProject = await createProject(null)
  regionalProject = await createProject('us-east-1')
  unknownProject = await createProject('mars-north-1')

  await seedMarker(homeUrl(), schemaOf(homeProject), 'home')

  await run(homeUrl(), `CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
  await seedMarker(regionalUrl, schemaOf(regionalProject), 'us-east-1')
})

afterAll(async () => {
  delete process.env[REGION_VARIABLE]
  await closeAllWorkspacePools()
  await disconnectRegionalClients()
  if (regionalDbCreated) {
    await run(homeUrl(), `DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`).catch(() => {})
  }
  if (homeProject) {
    await run(homeUrl(), `DROP SCHEMA IF EXISTS "${schemaOf(homeProject)}" CASCADE`).catch(() => {})
  }
  const ids = [homeProject, regionalProject, unknownProject].filter(Boolean)
  await prisma.project.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('a home-region project', () => {
  it('is served from DATABASE_URL, exactly as before regions', async () => {
    expect(await projectRegion(homeProject)).toBe('ap-south-1')
    const rows = await queryWorkspace<{ db: string; note: string }>(
      homeProject,
      'SELECT current_database() AS db, note FROM marker',
    )
    expect(rows).toEqual([{ db: homeDb, note: 'home' }])
  })

  it('keeps the shared raw client', async () => {
    expect(await workspaceRawClient(homeProject)).toBe(prisma)
  })
})

describe('a project in another region', () => {
  it('is refused while this process has no connection for its region', async () => {
    delete process.env[REGION_VARIABLE]
    expect(await projectRegion(regionalProject)).toBe('us-east-1')
    await expect(queryWorkspace(regionalProject, 'SELECT note FROM marker')).rejects.toMatchObject({
      code: 'REGION_NOT_CONFIGURED',
      variable: REGION_VARIABLE,
    })
    await expect(workspaceRawClient(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })

  it('has no schema in the home database that a fallback could have reached', async () => {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*)::bigint AS n FROM pg_namespace WHERE nspname = $1',
      schemaOf(regionalProject),
    )
    expect(Number(rows[0].n)).toBe(0)
  })

  it('is served from its own region once that connection exists', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const rows = await queryWorkspace<{ db: string; note: string }>(
      regionalProject,
      'SELECT current_database() AS db, note FROM marker',
    )
    expect(rows).toEqual([{ db: REGIONAL_DB, note: 'us-east-1' }])
  })

  it('gets a raw client on the regional database, not the shared one', async () => {
    process.env[REGION_VARIABLE] = regionalUrl
    const raw = await workspaceRawClient(regionalProject)
    expect(raw).not.toBe(prisma)
    const rows = await raw.$queryRawUnsafe<{ db: string }[]>('SELECT current_database() AS db')
    expect(rows[0].db).toBe(REGIONAL_DB)
  })

  it('is refused again once the connection is gone, even with a pool and a client open', async () => {
    delete process.env[REGION_VARIABLE]
    await expect(queryWorkspace(regionalProject, 'SELECT 1')).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    await expect(workspaceRawClient(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
  })
})

describe('a project recording a region this build does not know', () => {
  it('is refused, never read as the home region', async () => {
    await expect(projectRegion(unknownProject)).rejects.toMatchObject({ code: 'UNKNOWN_REGION' })
    await expect(queryWorkspace(unknownProject, 'SELECT 1')).rejects.toMatchObject({ code: 'UNKNOWN_REGION' })
  })
})

describe('a project with no row', () => {
  it('resolves to the home region, as every project did before regions', async () => {
    expect(await projectRegion(randomUUID())).toBe('ap-south-1')
  })
})
