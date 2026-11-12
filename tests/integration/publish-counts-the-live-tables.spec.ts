/**
 * THE DEPLOY PAGE AND THE VERSION IT PUBLISHES COUNT THE SAME TABLES
 * ==================================================================
 * Production QA (2026-11-09), Deploy: "7 tables" before publishing, then
 * "Initial publish with 8 tables". The page counted registered table rows,
 * the publish counted the backend graph's entities, and neither is what a
 * publish serves. Both now count the tables in the project's schema,
 * Backenly's plumbing left out (lib/deployment/published-tables.ts), and an
 * update names the tables it added, removed or changed instead of counting
 * graph entities, which an agent's migrations never move.
 *
 * The project here has what a live one has: two registered tables, the
 * end-user `users` table sign-ups created (never registered), Backenly's own
 * plumbing tables, and a graph that still lists a table nobody built.
 */

// The readiness gate's behavioural RLS check cannot pass on a superuser test
// connection (see deploy-tool-truth.spec.ts); everything after it is real.
jest.mock('@/lib/deployment/readiness-scorer', () => ({
  ...jest.requireActual('@/lib/deployment/readiness-scorer'),
  scoreReadiness: async () => ({ ready: true, score: 100, blockers: [], warnings: [], autoFixed: [], checks: [] }),
}))

import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { goLive, publishUpdate } from '@/lib/deployment/go-live'
import { GET as stateGET } from '@/app/api/projects/[id]/state/route'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
let ownerId = ''
let projectId = ''
let graphId = ''
let schema = ''
let session = ''

const exec = (sql: string) => prisma.$executeRawUnsafe(sql)

async function latest() {
  return prisma.deployment.findFirst({
    where: { projectId, environment: 'live', status: 'live', version: { not: null } },
    orderBy: { version: 'desc' },
    select: { version: true, changeSummary: true, config: true },
  })
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  const email = `publish-count-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'owner' }, select: { id: true } })).id
  session = (await createSession(ownerId, email, 'user')).token
  projectId = (await prisma.project.create({
    data: { name: 'publish-count', userId: ownerId, jwtSecret: crypto.randomBytes(32).toString('hex') },
    select: { id: true },
  })).id
  schema = `workspace_${projectId}`
  graphId = (await prisma.backendGraph.create({
    data: {
      projectId,
      sequenceNumber: 1,
      graphData: { entities: { products: { fields: {} }, orders: { fields: {} }, users: { fields: {} }, old_drafts: { fields: {} } } },
    },
    select: { id: true },
  })).id
  await prisma.project.update({ where: { id: projectId }, data: { activeGraphId: graphId } as any })

  await exec(`CREATE SCHEMA "${schema}"`)
  await exec(`CREATE TABLE "${schema}".products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text)`)
  await exec(`CREATE TABLE "${schema}".orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), total integer)`)
  // Created by the first sign-up, never registered as a table row.
  await exec(`CREATE TABLE "${schema}".users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text)`)
  // Backenly's own plumbing.
  await exec(`CREATE TABLE "${schema}"._token_blacklist (token text PRIMARY KEY)`)
  await exec(`CREATE TABLE "${schema}"._backenly_presence (id text PRIMARY KEY)`)
  for (const name of ['products', 'orders']) {
    await prisma.table.create({ data: { name, schema, projectId } })
  }
}, 120_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.deployment.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.updateMany({ where: { id: projectId }, data: { activeGraphId: null } as any }).catch(() => {})
  await prisma.backendGraph.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe('before publishing', () => {
  it('the Deploy page counts the tables a publish puts live', async () => {
    const request = { cookies: { get: (name: string) => (name === 'auth-token' ? { value: session } : undefined) } }
    const res = await stateGET(request as any, { params: Promise.resolve({ id: projectId }) })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.liveTableCount).toBe(3)
    // What decides whether a publish is offered is unchanged: registered tables.
    expect(body.entities.map((e: { name: string }) => e.name).sort()).toEqual(['orders', 'products'])
  }, 60_000)
})

describe('publishing', () => {
  it('the first publish counts the same tables', async () => {
    const out = await goLive(projectId, ownerId, { force: true, confirmedBy: 'UI' })
    if (!('success' in out) || !out.success) throw new Error(`publish refused: ${JSON.stringify(out)}`)
    const v1 = await latest()
    expect(v1?.changeSummary).toBe('Initial publish with 3 tables')
    expect(Object.keys((v1?.config as any)?.tables ?? {}).sort()).toEqual(['orders', 'products', 'users'])
  }, 120_000)

  it('an update names the tables it added and changed', async () => {
    await exec(`CREATE TABLE "${schema}".shipments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), carrier text)`)
    await exec(`ALTER TABLE "${schema}".products ADD COLUMN sku text`)
    const out = await publishUpdate(projectId, ownerId, 'https://example.test', graphId)
    expect((out as any).noChanges).toBe(false)
    expect((await latest())?.changeSummary).toBe('Added shipments; changed products')
  }, 60_000)

  it('an update names a table it removed', async () => {
    await exec(`DROP TABLE "${schema}".orders`)
    await publishUpdate(projectId, ownerId, 'https://example.test', graphId)
    expect((await latest())?.changeSummary).toBe('Removed orders')
  }, 60_000)

  it('after a publish that recorded no tables, an update says how many are live', async () => {
    const before = await latest()
    await prisma.deployment.updateMany({
      where: { projectId, version: before?.version ?? undefined },
      data: { config: { catalogSchemaHash: 'from-before' } as Prisma.InputJsonValue },
    })
    await exec(`ALTER TABLE "${schema}".products ADD COLUMN price integer`)
    await publishUpdate(projectId, ownerId, 'https://example.test', graphId)
    expect((await latest())?.changeSummary).toBe('Backend updated, 3 tables live')
  }, 60_000)
})
