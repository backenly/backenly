/**
 * THE WORKSPACE ZIP IS A TENANT BOUNDARY
 * ======================================
 * GET /api/workspace/download returns the project's generated workspace from
 * disk as a ZIP. That tree can hold the project's `.env`, so reading it is
 * reading the project's configuration.
 *
 * The handler authenticated the caller and then took the project id from the
 * `X-Project-Id` header with no further question, so any signed-in account
 * could download another project's workspace by naming its id. It now resolves
 * the header through `getCurrentProjectId`, the same guard every sibling
 * workspace/files route uses: the header is a request, the resolver decides.
 *
 * What is pinned here:
 *
 *   unauthenticated   401, before any project or disk access
 *   stranger          refused; a missing project answers 404
 *   no project named  400 on Cloud, never a guessed project
 *   VIEWER member     passes the guard (a read), reaching the disk lookup
 *   owner             passes the guard, reaching the disk lookup
 *
 * "Reaching the disk lookup" is asserted as the route's own 404 "Workspace not
 * found", which only the code AFTER the guard can produce: these fixtures never
 * create a directory on disk.
 *
 * Real database, real signed sessions, the real handler and resolver.
 */

import { randomUUID } from 'crypto'

/**
 * Where an organization member's role comes from.
 *
 * The public tree resolves `@cloud/project-access` to a stub that knows no
 * organizations, so the VIEWER case could not be exercised without this. When
 * the Cloud overlay is composed the real module is used; otherwise this mirrors
 * lib/cloud/project-access.ts against the real membership rows. Everything
 * after the role lookup is the real implementation.
 */
jest.mock('@cloud/project-access', () => {
  try {
    return jest.requireActual('@/lib/cloud/project-access')
  } catch {
    return {
      async organizationRoleForProject(projectId: string, organizationId: string | null, userId: string) {
        if (!organizationId) return null
        const { prisma: db } = jest.requireActual('@/lib/db')
        const member = await db.organizationMember.findUnique({
          where: { orgId_userId: { orgId: organizationId, userId } },
          select: { role: true, restricted: true },
        })
        if (!member) return null
        if (member.restricted && member.role !== 'OWNER' && member.role !== 'ADMIN') {
          const grant = await db.projectMember.findUnique({
            where: { userId_projectId: { userId, projectId } },
            select: { id: true },
          })
          if (!grant) return null
        }
        return member.role
      },
      async organizationProjectClauses(userId: string) {
        return [
          { organization: { members: { some: { userId, restricted: false } } } },
          { projectMembers: { some: { userId } } },
        ]
      },
    }
  }
})

import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
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
const createdOrgIds: string[] = []
const createdProjectIds: string[] = []

async function makeUser(): Promise<{ id: string; token: string }> {
  const email = `wdl-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Workspace Download Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  return { id: u.id, token }
}

/** An organization-owned project plus one member holding `role`. */
async function fixture(role: 'VIEWER' | 'DEVELOPER' | 'ADMIN') {
  const owner = await makeUser()
  const member = await makeUser()
  const org = await prisma.organization.create({
    data: { name: `wdl-org-${randomUUID().slice(0, 8)}`, ownerId: owner.id },
    select: { id: true },
  })
  createdOrgIds.push(org.id)
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: owner.id, role: 'OWNER' } })
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: member.id, role } })

  const p = await prisma.project.create({
    data: { name: `wdl-${randomUUID().slice(0, 8)}`, userId: owner.id, organizationId: org.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  return { owner, member, projectId: p.id }
}

/** jest.setup.js replaces the global Request; this is the subset the handler touches. */
function req(opts: { token?: string | null; projectId?: string | null }): any {
  const headers: Record<string, string> = {}
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
  if (opts.projectId) headers['x-project-id'] = opts.projectId
  return {
    method: 'GET',
    url: 'http://localhost:3000/api/workspace/download',
    nextUrl: { pathname: '/api/workspace/download' },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
  }
}

async function download(token: string | null, projectId: string | null) {
  const { GET } = await import('@/app/api/workspace/download/route')
  return GET(req({ token, projectId }) as any)
}

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

beforeAll(() => {
  assertSafeTestDatabase()
})

beforeEach(() => {
  process.env.BACKENLY_EDITION = 'cloud'
})

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
})

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
  }
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

describe('GET /api/workspace/download', () => {
  it('refuses an unauthenticated request before touching anything', async () => {
    const f = await fixture('VIEWER')

    const res: any = await download(null, f.projectId)

    expect(res.status).toBe(401)
  })

  it('refuses a signed-in stranger and returns no archive', async () => {
    const f = await fixture('VIEWER')
    const stranger = await makeUser()

    const res: any = await download(stranger.token, f.projectId)

    expect(res.status).toBe(403)
    expect(res.headers?.get?.('Content-Type') ?? '').not.toContain('zip')
  })

  it('answers 404 for a project that does not exist', async () => {
    const stranger = await makeUser()

    const res: any = await download(stranger.token, randomUUID())

    expect(res.status).toBe(404)
  })

  it('refuses a Cloud request that names no project instead of guessing one', async () => {
    const someone = await makeUser()

    const res: any = await download(someone.token, null)

    expect(res.status).toBe(400)
  })

  it('lets the owner through the guard, to the route\'s own disk lookup', async () => {
    const f = await fixture('VIEWER')

    const res: any = await download(f.owner.token, f.projectId)
    const body = await res.json()

    // No workspace directory exists for this fixture, so reaching the route's
    // "Workspace not found" proves the guard resolved and allowed the project.
    expect(res.status).toBe(404)
    expect(body.error).toBe('Workspace not found')
  })

  it('a VIEWER may read: the guard passes and the disk lookup answers', async () => {
    const f = await fixture('VIEWER')

    const res: any = await download(f.member.token, f.projectId)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toBe('Workspace not found')
  })
})
