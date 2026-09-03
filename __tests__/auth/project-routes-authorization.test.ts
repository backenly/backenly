/**
 * ORGANIZATION MEMBERS CAN REACH app/api/projects/[id]/** AT ALL
 * =============================================================
 * Representative matrix for the route family migrated off inline owner-only
 * checks. Not 35 near-identical tests: one route per AUTHENTICATION pattern,
 * because the authorization decision is now identical across all of them and it
 * is the plumbing that differs.
 *
 * What these routes used to do, 49 times across 36 files:
 *
 *   const project = await prisma.project.findFirst({
 *     where: { id: projectId, userId },      // owner only
 *   })
 *   if (!project) return 404
 *
 * An invited organization member is not the owner, so every one of these routes
 * answered 404 to them. Not a permissions error they could act on: the project
 * simply did not appear to exist.
 *
 * Patterns covered here:
 *   authenticateRequest + bearer   ai-functions
 *   verifyToken + bearer           audit-logs
 *   verifySession + cookie         metadata
 *
 * The fourth, `withAuth` (webhooks, domains, project root), resolves identity
 * through next/headers and cannot be invoked directly under jest. It calls the
 * same `canAccessProject(userId, projectId)` with the same arguments, and that
 * function is pinned against a real database in project-resolver.test.ts, so
 * the gap is in invoking the handler rather than in the decision.
 *
 * 404 IS DELIBERATE and is asserted, not merely tolerated. The old query could
 * not distinguish "no such project" from "not yours" — findFirst with a userId
 * predicate returns null for both — so a stranger has always received 404 here.
 * Adopting the resolver's 403 for the forbidden case would newly confirm that a
 * project exists. Migrating authorization must not start leaking existence, so
 * canAccessProject collapses the two on purpose.
 */

import { randomUUID } from 'crypto'
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

async function makeUser() {
  const email = `routes-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Route Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  return { id: u.id, email, token }
}

async function makeProject(userId: string, orgId?: string) {
  const p = await prisma.project.create({
    data: { name: `routes-${randomUUID().slice(0, 8)}`, userId, organizationId: orgId ?? null },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  return p.id
}

/** Owner, an unrestricted member, a restricted member with no grant, a stranger. */
async function fixture() {
  const owner = await makeUser()
  const member = await makeUser()
  const restricted = await makeUser()
  const stranger = await makeUser()

  const org = await prisma.organization.create({
    data: { name: `routes-org-${randomUUID().slice(0, 8)}`, ownerId: owner.id },
    select: { id: true },
  })
  createdOrgIds.push(org.id)
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: owner.id, role: 'OWNER' } })
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: member.id, role: 'DEVELOPER' } })
  await prisma.organizationMember.create({
    data: { orgId: org.id, userId: restricted.id, role: 'DEVELOPER', restricted: true },
  })

  const projectId = await makeProject(owner.id, org.id)
  return { owner, member, restricted, stranger, orgId: org.id, projectId }
}

/** jest.setup.js replaces global Request, so NextRequest cannot be built here. */
function req(opts: { bearer?: string; cookie?: string; path?: string }): any {
  const path = opts.path ?? '/api/projects/x/thing'
  const headers: Record<string, string> = {}
  if (opts.bearer) headers['authorization'] = `Bearer ${opts.bearer}`
  return {
    method: 'GET',
    url: `http://localhost:3000${path}`,
    nextUrl: { pathname: path, searchParams: new URLSearchParams() },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: {
      get: (k: string) => (k === 'auth-token' && opts.cookie ? { value: opts.cookie } : undefined),
      // Some handlers enumerate cookies for diagnostics before reading one.
      getAll: () => (opts.cookie ? [{ name: 'auth-token', value: opts.cookie }] : []),
    },
    json: async () => ({}),
  }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeAll(() => {
  assertSafeTestDatabase()
  process.env.BACKENLY_EDITION = 'cloud'
})

afterEach(() => resetSingleTenantCache())

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
  }
  if (createdProjectIds.length) {
    await prisma.aiFunction.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
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

describe('ai-functions (authenticateRequest + bearer)', () => {
  it('applies the access matrix', async () => {
    const { GET } = await import('@/app/api/projects/[id]/ai-functions/route')
    const f = await fixture()

    const owner: any = await GET(req({ bearer: f.owner.token }), params(f.projectId))
    expect(owner.status).toBe(200)

    // The fix. This was 404 before: the member is not the project's userId.
    const member: any = await GET(req({ bearer: f.member.token }), params(f.projectId))
    expect(member.status).toBe(200)

    // Restricted with no ProjectMember grant. An empty allowlist means nothing,
    // never everything.
    const restricted: any = await GET(req({ bearer: f.restricted.token }), params(f.projectId))
    expect(restricted.status).toBe(404)

    const stranger: any = await GET(req({ bearer: f.stranger.token }), params(f.projectId))
    expect(stranger.status).toBe(404)

    // Existence is not leaked: a stranger gets the same answer for a project
    // that is real but not theirs as for one that never existed.
    const ghost: any = await GET(req({ bearer: f.stranger.token }), params(randomUUID()))
    expect(ghost.status).toBe(404)
  })

  it('lets a restricted member through once the project is granted', async () => {
    const { GET } = await import('@/app/api/projects/[id]/ai-functions/route')
    const f = await fixture()
    await prisma.projectMember.create({
      data: { orgId: f.orgId, userId: f.restricted.id, projectId: f.projectId },
    })

    const res: any = await GET(req({ bearer: f.restricted.token }), params(f.projectId))
    expect(res.status).toBe(200)
  })

  it('still rejects an unauthenticated caller with 401, not 404', async () => {
    const { GET } = await import('@/app/api/projects/[id]/ai-functions/route')
    const f = await fixture()

    // Authentication and authorization stay distinct: the migration moved the
    // second, and must not have swallowed the first.
    const res: any = await GET(req({}), params(f.projectId))
    expect(res.status).toBe(401)
  })
})

describe('audit-logs (verifyToken + bearer)', () => {
  it('applies the access matrix', async () => {
    const { GET } = await import('@/app/api/projects/[id]/audit-logs/route')
    const f = await fixture()

    const owner: any = await GET(req({ bearer: f.owner.token }), params(f.projectId))
    expect(owner.status).toBe(200)

    const member: any = await GET(req({ bearer: f.member.token }), params(f.projectId))
    expect(member.status).toBe(200)

    const stranger: any = await GET(req({ bearer: f.stranger.token }), params(f.projectId))
    expect(stranger.status).toBe(404)
  })
})

describe('metadata (verifySession + cookie)', () => {
  it('applies the access matrix', async () => {
    const { GET } = await import('@/app/api/projects/[id]/metadata/route')
    const f = await fixture()

    const owner: any = await GET(req({ cookie: f.owner.token }), params(f.projectId))
    expect(owner.status).toBe(200)

    const member: any = await GET(req({ cookie: f.member.token }), params(f.projectId))
    expect(member.status).toBe(200)

    const stranger: any = await GET(req({ cookie: f.stranger.token }), params(f.projectId))
    expect(stranger.status).toBe(404)
  })
})
