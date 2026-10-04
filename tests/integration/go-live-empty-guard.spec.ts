/**
 * GO-LIVE EMPTY BACKEND GUARD
 * ===========================
 *
 * The deployment guard refuses to deploy a completely empty backend.
 * Previously it only checked `prisma.table.count === 0`. If a project enabled
 * auth but created no tables, the deploy was refused with an error saying to
 * create tables, APIs, or auth first.
 *
 * Pinned here, against the deployment engine logic:
 *
 *  1. An empty project is refused deployment.
 *  2. A project with only auth enabled passes the empty check and the
 *     confirmation message accurately reflects it.
 *  3. A project with catalog-backed REST APIs passes the check and accurately
 *     reports feature counts in the confirmation message.
 *  4. A project with only tables passes the check.
 */

import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'
import { goLive, type GoLiveConfirmation, type GoLiveError } from '../../lib/deployment/go-live'

const prisma = new PrismaClient()
let ownerId: string
const projects: string[] = []

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `go-live-guard-${crypto.randomBytes(6).toString('hex')}@example.test`,
      password: 'not-a-real-hash',
      name: 'Go-Live Guard Suite',
    },
    select: { id: true },
  })
  ownerId = owner.id
}, 60_000)

afterAll(async () => {
  for (const projectId of projects) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`)
  }
  await prisma.table.deleteMany({ where: { projectId: { in: projects } } }).catch(() => {})
  await prisma.backendGraph.deleteMany({ where: { projectId: { in: projects } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await prisma.$disconnect()
}, 120_000)

/** Creates a project with a backend graph so it passes the 'no backend state' guard */
async function setupProject(features: { auth: boolean; tables: number; apis: number }): Promise<string> {
  const project = await prisma.project.create({
    data: {
      name: `guard-test-${crypto.randomBytes(4).toString('hex')}`,
      userId: ownerId,
      authManifest: features.auth ? { enabled: true } : {},
      jwtSecret: features.auth ? crypto.randomBytes(32).toString('hex') : null,
    },
    select: { id: true },
  })
  projects.push(project.id)

  const graph = await prisma.backendGraph.create({
    data: {
      projectId: project.id,
      graphData: {},
    },
    select: { id: true },
  })
  await prisma.project.update({
    where: { id: project.id },
    data: { activeGraphId: graph.id },
  })

  for (let i = 0; i < features.tables; i++) {
    await prisma.table.create({
      data: { projectId: project.id, name: `table_${i}` },
    })
  }
  if (features.apis > 0) {
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "workspace_${project.id}"`)
    for (let i = 0; i < features.apis; i++) {
      await prisma.$executeRawUnsafe(
        `CREATE TABLE "workspace_${project.id}"."api_${i}" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text)`,
      )
    }
  }

  return project.id
}

describe('the empty-backend guard', () => {
  // Required environment variables so readiness checks don't crash
  const envSnapshot = { ...process.env }
  
  beforeAll(() => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://fake'
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'a-very-long-secret-key-that-is-at-least-32-chars'
  })
  
  afterAll(() => {
    process.env = envSnapshot
  })

  it('refuses to deploy an entirely empty backend', async () => {
    const projectId = await setupProject({ tables: 0, apis: 0, auth: false })
    const result = await goLive(projectId, ownerId) as GoLiveError
    
    expect(result.kind).toBe('error')
    expect(result.error).toMatch(/no backend has been built yet/)
  }, 30_000)

  it('admits a backend that only has auth enabled', async () => {
    const projectId = await setupProject({ tables: 0, apis: 0, auth: true })
    const result = await goLive(projectId, ownerId, { force: false })
    
    // An auth-only project might fail readiness if it lacks a `users` table schema,
    // but the empty-backend guard itself must let it through.
    if (result.kind === 'error') {
      expect((result as GoLiveError).error).not.toMatch(/no backend has been built yet/)
      expect((result as GoLiveError).error).toMatch(/Deployment blocked — readiness/)
    } else {
      const confirm = result as GoLiveConfirmation
      expect(confirm.kind).toBe('confirmation')
      expect(confirm.message).toMatch(/Authentication enabled/)
    }
  }, 30_000)

  it('admits catalog-backed REST APIs without legacy table metadata', async () => {
    const projectId = await setupProject({ tables: 0, apis: 1, auth: false })
    const result = await goLive(projectId, ownerId, { force: false })
    
    if (result.kind === 'error') {
      expect((result as GoLiveError).error).not.toMatch(/no backend has been built yet/)
    } else {
      const confirm = result as GoLiveConfirmation
      expect(confirm.kind).toBe('confirmation')
      expect(confirm.message).not.toMatch(/0 tables/)
      expect(confirm.message).toMatch(/1 API/)
    }
  }, 30_000)

  it('counts and reports tables accurately', async () => {
    const projectId = await setupProject({ tables: 2, apis: 0, auth: false })
    const result = await goLive(projectId, ownerId, { force: false })
    
    if (result.kind === 'error') {
      expect((result as GoLiveError).error).not.toMatch(/no backend has been built yet/)
    } else {
      const confirm = result as GoLiveConfirmation
      expect(confirm.kind).toBe('confirmation')
      expect(confirm.message).toMatch(/2 tables/)
    }
  }, 30_000)
})
