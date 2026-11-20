/**
 * A BUILD'S BRANCH IS LOOKED FOR IN THE DATABASE THAT HOLDS IT
 * ============================================================
 * backend_chat on a protected production builds on a preview branch
 * (lib/branches/build-branch.ts). Before a step that acts on a table on
 * production (its REST API, row security, realtime, triggers, seed rows), it
 * asks BuildBranch.onlyOnBranch whether the table is on the branch and not yet
 * on production; if it is, the step waits for the merge. Both schemas are in
 * the database holding the project's data, in its region. onlyOnBranch read
 * information_schema on the platform client, which is that database only for a
 * project in the home region; for any other it read a database holding neither
 * schema and its answer had nothing to do with the project's tables.
 *
 * A second database stands in for another region's (DATABASE_URL_US_EAST_1),
 * as in tests/integration/change-ledger-residency.spec.ts. The home database
 * holds a decoy for the regional project: schemas under its names with other
 * tables, so an answer read in the wrong database is visibly wrong. Pinned:
 *
 *   regional project   a table only on the branch: yes; on both, or only in
 *                      the home decoy: no
 *   no connection      refused with REGION_NOT_CONFIGURED, never answered from
 *                      the home database
 *   home project       answered from the home database, as before
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'

import { prisma } from '@/lib/db/prisma'
import { BuildBranch } from '@/lib/branches/build-branch'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'

jest.setTimeout(120_000)

const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
const REGIONAL_DB = `backenly_build_branch_${randomBytes(4).toString('hex')}`
const BRANCH = 'wishlists'

const homeUrl = () => process.env.DATABASE_URL as string
function urlFor(database: string): string {
  const url = new URL(homeUrl())
  url.pathname = `/${database}`
  return url.toString()
}
const regionalUrl = urlFor(REGIONAL_DB)

async function run(connectionString: string, sql: string): Promise<void> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end().catch(() => {})
  }
}

const mainSchema = (projectId: string) => `workspace_${projectId}`
const branchSchema = (projectId: string) => `workspace_${projectId}_br_${BRANCH}`

let ownerId = ''
let regionalProject = ''
let homeProject = ''
let regionalDbCreated = false

/**
 * Production has `orders`; the branch has `orders` and `wishlists`, the table
 * this build added.
 */
async function seedBuild(url: string, projectId: string): Promise<void> {
  await run(
    url,
    `CREATE SCHEMA "${mainSchema(projectId)}";
     CREATE TABLE "${mainSchema(projectId)}".orders (id int);
     CREATE SCHEMA "${branchSchema(projectId)}";
     CREATE TABLE "${branchSchema(projectId)}".orders (id int);
     CREATE TABLE "${branchSchema(projectId)}".wishlists (id int)`,
  )
}

/**
 * The branch an earlier turn of this build opened, as BuildBranch records it
 * (saveBuildBranch in lib/branches/build-branch.ts): an active branch row and
 * the project preference naming it.
 */
async function recordBuildBranch(projectId: string): Promise<void> {
  const branch = await prisma.workspaceBranch.create({
    data: { projectId, name: BRANCH, schemaName: branchSchema(projectId), status: 'active', createdBy: ownerId },
    select: { id: true },
  })
  await prisma.projectPreference.create({
    data: {
      projectId,
      type: 'pending_plan',
      key: 'build_branch',
      value: JSON.stringify({ branchId: branch.id, name: BRANCH }),
      confidence: 1,
    },
  })
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  delete process.env[REGION_VARIABLE]

  ownerId = (
    await prisma.user.create({ data: { email: `build-branch-${randomUUID()}@example.test`, name: 'build branch fixture' }, select: { id: true } })
  ).id
  regionalProject = (
    await prisma.project.create({ data: { name: `build-branch-region-${randomUUID()}`, userId: ownerId, region: 'us-east-1' }, select: { id: true } })
  ).id
  homeProject = (
    await prisma.project.create({ data: { name: `build-branch-home-${randomUUID()}`, userId: ownerId }, select: { id: true } })
  ).id

  await run(homeUrl(), `CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
  await seedBuild(regionalUrl, regionalProject)
  await seedBuild(homeUrl(), homeProject)

  // The decoy: the regional project's schema names in the home database, the
  // other way round. Production here has `wishlists`; the branch has `reviews`,
  // a table the regional project has nowhere.
  await run(
    homeUrl(),
    `CREATE SCHEMA "${mainSchema(regionalProject)}";
     CREATE TABLE "${mainSchema(regionalProject)}".wishlists (id int);
     CREATE SCHEMA "${branchSchema(regionalProject)}";
     CREATE TABLE "${branchSchema(regionalProject)}".reviews (id int)`,
  )

  await recordBuildBranch(regionalProject)
  await recordBuildBranch(homeProject)
  process.env[REGION_VARIABLE] = regionalUrl
})

afterAll(async () => {
  delete process.env[REGION_VARIABLE]
  await disconnectRegionalClients().catch(() => {})
  if (regionalDbCreated) await run(homeUrl(), `DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`).catch(() => {})
  for (const projectId of [regionalProject, homeProject].filter(Boolean)) {
    for (const schema of [branchSchema(projectId), mainSchema(projectId)]) {
      await run(homeUrl(), `DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    }
  }
  await prisma.project.deleteMany({ where: { id: { in: [regionalProject, homeProject].filter(Boolean) } } }).catch(() => {})
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('onlyOnBranch for a project in another region', () => {
  const build = () => new BuildBranch(regionalProject, ownerId, 'add wishlists')

  it('finds the table only the branch has, in the region', async () => {
    expect(await build().onlyOnBranch('wishlists')).toBe(true)
  })

  it('says no for a table production has too', async () => {
    expect(await build().onlyOnBranch('orders')).toBe(false)
  })

  it('says no for a table only the home database has under the branch name', async () => {
    expect(await build().onlyOnBranch('reviews')).toBe(false)
  })

  it('is refused while this process has no connection for the region, not answered from home', async () => {
    delete process.env[REGION_VARIABLE]
    try {
      await expect(build().onlyOnBranch('wishlists')).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
    } finally {
      process.env[REGION_VARIABLE] = regionalUrl
    }
  })
})

describe('onlyOnBranch for a project in the home region', () => {
  const build = () => new BuildBranch(homeProject, ownerId, 'add wishlists')

  it('reads the home database, as before', async () => {
    expect(await build().onlyOnBranch('wishlists')).toBe(true)
    expect(await build().onlyOnBranch('orders')).toBe(false)
    expect(await build().onlyOnBranch('reviews')).toBe(false)
  })
})
