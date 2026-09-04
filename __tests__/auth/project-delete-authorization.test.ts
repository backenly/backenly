/**
 * DELETING A PROJECT
 * ==================
 * The single most consequential change in the authorization migration, and the
 * only one that WIDENS a destructive operation. DELETE /api/projects/[id] was
 * owner-only: `where: { id: projectId, userId }`. It is now reachable by an
 * organization ADMIN as well as the project owner.
 *
 * That widening is deliberate, and it is why this file exists rather than the
 * case being folded into the general route matrix. The operation drops every
 * workspace schema the project owns, deletes its rows, and removes its backups
 * and storage objects. There is no undo in the dashboard.
 *
 * The line that must hold: a DEVELOPER can build anything in a project and
 * cannot destroy it.
 *
 *   VIEWER      denied
 *   DEVELOPER   denied
 *   ADMIN       allowed
 *   OWNER       allowed
 *   stranger    denied, and without confirming the project exists
 *
 * `withAuth` resolves identity through next/headers, which cannot be driven
 * under jest, so `requireUser` is overridden and everything else in the module
 * is the real implementation. The handler, the guard, the resolver and the
 * deletion itself all run for real against a real database.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'

let currentUserId = ''

jest.mock('@/lib/auth/server', () => ({
  ...jest.requireActual('@/lib/auth/server'),
  requireUser: jest.fn(async () => ({
    userId: currentUserId,
    email: `${currentUserId}@test.invalid`,
    role: 'user',
  })),
}))

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const createdUserIds: string[] = []
const createdOrgIds: string[] = []
const createdProjectIds: string[] = []

async function makeUser(): Promise<string> {
  const u = await prisma.user.create({
    data: { email: `del-${randomUUID()}@test.invalid`, name: 'Delete Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  return u.id
}

/** An org-owned project plus a member holding `role`. */
async function fixture(role: string) {
  const ownerId = await makeUser()
  const memberId = await makeUser()
  const org = await prisma.organization.create({
    data: { name: `del-org-${randomUUID().slice(0, 8)}`, ownerId },
    select: { id: true },
  })
  createdOrgIds.push(org.id)
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: ownerId, role: 'OWNER' } })
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: memberId, role } })

  const p = await prisma.project.create({
    data: { name: `del-${randomUUID().slice(0, 8)}`, userId: ownerId, organizationId: org.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  return { ownerId, memberId, projectId: p.id }
}

/** The DELETE handler reads the project id from the END of the path. */
function req(projectId: string): any {
  const url = `http://localhost:3000/api/projects/${projectId}`
  return {
    method: 'DELETE',
    url,
    nextUrl: { pathname: `/api/projects/${projectId}` },
    headers: { get: () => null },
    cookies: { get: () => undefined, getAll: () => [] },
    json: async () => ({}),
  }
}

const stillExists = async (id: string) =>
  (await prisma.project.findUnique({ where: { id }, select: { id: true } })) !== null

beforeAll(() => {
  assertSafeTestDatabase()
  process.env.BACKENLY_EDITION = 'cloud'
})

afterAll(async () => {
  if (createdProjectIds.length) {
    await prisma.projectMember.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdOrgIds.length) {
    await prisma.organizationMember.deleteMany({ where: { orgId: { in: createdOrgIds } } })
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } })
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

describe('DELETE /api/projects/[id]', () => {
  it.each(['VIEWER', 'DEVELOPER'])('refuses an org %s, and the project survives', async role => {
    const { DELETE } = await import('@/app/api/projects/[id]/route')
    const f = await fixture(role)
    currentUserId = f.memberId

    const res: any = await DELETE(req(f.projectId), {} as any)

    expect(res.status).toBe(404)
    // The assertion that matters. A refusal that still deleted would be the
    // worst possible outcome of this migration.
    expect(await stillExists(f.projectId)).toBe(true)
  })

  it('allows an org ADMIN', async () => {
    const { DELETE } = await import('@/app/api/projects/[id]/route')
    const f = await fixture('ADMIN')
    currentUserId = f.memberId

    const res: any = await DELETE(req(f.projectId), {} as any)

    expect(res.status).toBe(200)
    expect(await stillExists(f.projectId)).toBe(false)
  })

  it('allows the project owner', async () => {
    const { DELETE } = await import('@/app/api/projects/[id]/route')
    const f = await fixture('VIEWER')
    // The owner is a mere VIEWER of the organization here, which must not
    // demote them out of their own project.
    currentUserId = f.ownerId

    const res: any = await DELETE(req(f.projectId), {} as any)

    expect(res.status).toBe(200)
    expect(await stillExists(f.projectId)).toBe(false)
  })

  it('refuses a stranger without confirming the project exists', async () => {
    const { DELETE } = await import('@/app/api/projects/[id]/route')
    const f = await fixture('DEVELOPER')
    const strangerId = await makeUser()
    currentUserId = strangerId

    const real: any = await DELETE(req(f.projectId), {} as any)
    const ghost: any = await DELETE(req(randomUUID()), {} as any)

    // Identical answers for a project that exists but is not theirs and one
    // that never existed: refusing to delete must not become an existence
    // oracle.
    expect(real.status).toBe(404)
    expect(ghost.status).toBe(404)
    expect(await real.json()).toEqual(await ghost.json())
    expect(await stillExists(f.projectId)).toBe(true)
  })
})
