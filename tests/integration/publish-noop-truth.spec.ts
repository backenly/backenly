/**
 * "Already up to date" is decided by the live catalog, not a graph pointer
 * (medium finding DEP-03), and the deploy cluster answers honestly
 * (DEP-13, DEP-14).
 *
 * DEP-03: publishUpdate compared `latestDeployment.graphSnapshotId ===
 * activeGraphId`. The MCP schema path (apply_migration, the typed executors)
 * changes real tables without moving activeGraphId, so after an agent
 * reshaped the schema, "Publish update" answered "Already up to date" and
 * recorded nothing. The no-op check now hashes the live catalog
 * (information_schema via readWorkspaceSchema) and claims no-changes only
 * when the previous publish recorded the same hash.
 */
import fs from 'fs'
import path from 'path'
import crypto, { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/db/prisma'
import { publishUpdate } from '@/lib/deployment/go-live'

const ROOT = process.cwd()

let ownerId: string
let projectId: string
const activeGraphId = randomUUID() // never moved below — that is the point

async function latestVersion() {
  return prisma.deployment.findFirst({
    where: { projectId, environment: 'live', status: 'live' },
    orderBy: { version: 'desc' },
    select: { version: true, config: true },
  })
}

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `publish-noop-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Publish No-op Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'publish-noop', userId: ownerId, projectStatus: 'LIVE', isDeployed: true },
      select: { id: true },
    })
  ).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "workspace_${projectId}"."recipes" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL)`,
  )
}, 120_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.deployment.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('DEP-03: the no-op check reads the catalog', () => {
  it('a first update records the catalog hash', async () => {
    const out = await publishUpdate(projectId, ownerId, 'https://example.test', activeGraphId)
    expect(out.success).toBe(true)
    expect((out as any).noChanges).toBe(false)
    const latest = await latestVersion()
    expect((latest?.config as any)?.catalogSchemaHash).toMatch(/^[0-9a-f]{16}$/)
  }, 60_000)

  it('an unchanged catalog is honestly "already up to date"', async () => {
    const before = (await latestVersion())?.version
    const out = await publishUpdate(projectId, ownerId, 'https://example.test', activeGraphId)
    expect((out as any).noChanges).toBe(true)
    expect((await latestVersion())?.version).toBe(before)
  }, 60_000)

  it('an agent schema change publishes a new version although the graph pointer never moved', async () => {
    // Exactly what apply_migration does: the catalog changes, activeGraphId
    // does not. The old pointer comparison answered noChanges here.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "workspace_${projectId}"."recipes" ADD COLUMN servings integer`,
    )
    const before = (await latestVersion())?.version ?? 0
    const out = await publishUpdate(projectId, ownerId, 'https://example.test', activeGraphId)
    expect((out as any).noChanges).toBe(false)
    expect((await latestVersion())?.version).toBe(before + 1)
  }, 60_000)

  it('a legacy deployment without a recorded hash never claims up to date', async () => {
    // Rows from before hashes were recorded cannot prove sameness; the
    // honest default is an extra snapshot, never "up to date".
    await prisma.deployment.updateMany({ where: { projectId }, data: { config: Prisma.DbNull } })
    const before = (await latestVersion())?.version ?? 0
    const out = await publishUpdate(projectId, ownerId, 'https://example.test', activeGraphId)
    expect((out as any).noChanges).toBe(false)
    expect((await latestVersion())?.version).toBe(before + 1)
  }, 60_000)
})

describe('DEP-13 / DEP-14: the deploy cluster answers honestly', () => {
  it('an engine refusal is a 422, not a 500, and the guard speaks console', () => {
    const route = fs.readFileSync(path.join(ROOT, 'app', 'api', 'projects', '[id]', 'go-live', 'route.ts'), 'utf8')
    expect(route).toContain("'Project not found' ? 404 : 422")
    const goLive = fs.readFileSync(path.join(ROOT, 'lib', 'deployment', 'go-live.ts'), 'utf8')
    expect(goLive).not.toContain('Ask me to create tables')
    expect(goLive).toContain('Nothing to publish yet')
  })

  it('the page only offers Publish when the engine would accept it', () => {
    const page = fs.readFileSync(path.join(ROOT, 'app', 'app', 'projects', '[id]', 'deploy', 'page.tsx'), 'utf8')
    expect(page).toContain('const publishable =')
    expect(page).toContain("publishable ? publishButton('Publish backend') : undefined")
  })

  it('connect_frontend no longer demands a deploy the API does not need', () => {
    const svc = fs.readFileSync(path.join(ROOT, 'lib', 'services', 'connectFrontend.ts'), 'utf8')
    expect(svc).not.toContain("hasn't been deployed")
    expect(svc).toContain('not published yet')
    const executor = fs.readFileSync(path.join(ROOT, 'lib', 'ai', 'minimal-executor.ts'), 'utf8')
    expect(executor).not.toContain('your backend must be deployed first')
    expect(executor).not.toContain('deployment-gated')
    // What the agent reads must not send it to publish first either.
    for (const file of ['tools.ts', 'prompts.ts', 'capabilities.ts']) {
      const src = fs.readFileSync(path.join(ROOT, 'lib', 'ai', 'brain', file), 'utf8')
      expect(src).not.toMatch(/verifies the backend (has been|is) deployed|deployment-gated|handles deploy-check/)
    }
  })
})
