/**
 * OPERATE DECISIONS ARE HELD TO A ROLE, NOT TO MEMBERSHIP
 * =======================================================
 * The Operate surfaces decide what actually happens to a backend: approving a
 * parked agent request executes it verbatim, approving a health finding runs
 * its repair, the autonomy dial widens what the platform may do on its own,
 * maintenance consent arms Tier-2, a branch merge replays schema onto
 * production, go-live runs auto-fix DDL and flips the project LIVE.
 *
 * Every one of those routes authorized membership only, so on Cloud an
 * organization VIEWER — the rank that exists to look — could be the "human
 * approval" the safety model hinges on. The floors pinned here follow the
 * repo's own siblings (proposals approve = DEVELOPER, branch keys/protection =
 * ADMIN, readiness = DEVELOPER, console rollback = ADMIN):
 *
 *   agent-approvals decide        ADMIN   (a request only parks because its
 *                                          tool is destructive or high risk)
 *   health approve / undo         DEVELOPER
 *   health dismiss                DEVELOPER
 *   autonomy dial                 DEVELOPER
 *   maintenance consent/revoke    ADMIN
 *   finding approve / dismiss     DEVELOPER
 *   finding rollback              ADMIN
 *   branch create / discard       DEVELOPER
 *   branch merge                  ADMIN
 *   go-live                       DEVELOPER
 *
 * Reads stay open: the Review Queue list and the health report are VIEWER.
 *
 * Real database, real signed sessions, the real wrapper, guard and resolver.
 * Where the allowed rank's request then fails downstream (a fabricated
 * approval id, a branch engine this tree does not ship), the assertion is
 * "anything but the floor's 403" — those answers are only reachable past it.
 */

import { randomUUID } from 'crypto'

/**
 * Identity for the withProjectAccess / getProjectContext routes.
 *
 * `requireUser` reads next/headers, which jest cannot drive, and
 * `requireProjectAccess` / `getProjectContext` call it module-locally, so
 * overriding requireUser alone (the project-delete suite's trick) does not
 * reach them. They are reimplemented here faithfully — the same real
 * verifyProjectAccess / canAccessProject decide, the same error classes are
 * thrown — with only the identity supplied by the test.
 */
let currentUserId = ''

jest.mock('@/lib/auth/server', () => {
  const actual = jest.requireActual('@/lib/auth/server')
  return {
    ...actual,
    requireUser: jest.fn(async () => ({
      userId: currentUserId,
      email: `${currentUserId}@test.invalid`,
      role: 'user',
    })),
    requireProjectAccess: jest.fn(async (request: Request) => {
      const { verifyProjectAccess } = jest.requireActual('@/lib/auth/project-access')
      const url = new URL(request.url)
      const projectId =
        url.searchParams.get('projectId') ??
        url.pathname.match(/\/projects\/([a-zA-Z0-9-_]+)/)?.[1] ??
        null
      if (!projectId) throw new actual.ForbiddenError('Missing projectId - project context required')
      const project = await verifyProjectAccess(projectId, currentUserId)
      return { user: { userId: currentUserId, email: `${currentUserId}@test.invalid` }, project, projectId }
    }),
    getProjectContext: jest.fn(async (projectId: string) => {
      const { canAccessProject } = jest.requireActual('@/lib/edition/guard')
      const { prisma: db } = jest.requireActual('@/lib/db')
      const allowed = await canAccessProject(currentUserId, projectId)
      const project = allowed
        ? await db.project.findUnique({ where: { id: projectId }, include: { workspaces: true } })
        : null
      if (!project) throw new actual.ForbiddenError('Project not found or you do not have access')
      return { user: { userId: currentUserId, email: `${currentUserId}@test.invalid`, role: 'user' }, project }
    }),
  }
})

/** See workspace-oauth-authorization.test.ts — same role source, same reason. */
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
  const email = `floor-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Floor Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  return { id: u.id, token }
}

async function fixture(role: 'VIEWER' | 'DEVELOPER' | 'ADMIN') {
  const owner = await makeUser()
  const member = await makeUser()
  const org = await prisma.organization.create({
    data: { name: `floor-org-${randomUUID().slice(0, 8)}`, ownerId: owner.id },
    select: { id: true },
  })
  createdOrgIds.push(org.id)
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: owner.id, role: 'OWNER' } })
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: member.id, role } })
  const p = await prisma.project.create({
    data: { name: `floor-${randomUUID().slice(0, 8)}`, userId: owner.id, organizationId: org.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  return { owner, member, projectId: p.id }
}

function req(opts: { method: string; token: string; path: string; body?: unknown; query?: string }): any {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` }
  return {
    method: opts.method,
    url: `http://localhost:3000${opts.path}${opts.query ?? ''}`,
    nextUrl: { pathname: opts.path },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => opts.body ?? {},
  }
}

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) })

type Call = (token: string, projectId: string) => Promise<any>

type TestUser = { id: string; token: string }

/** Act as `user` on every identity path: Bearer token and requireUser alike. */
async function runAs(user: TestUser, name: keyof typeof calls, projectId: string) {
  currentUserId = user.id
  return calls[name](user.token, projectId)
}

/** Every gated call, by route and verb. */
const calls: Record<string, Call> = {
  decideApproval: async (token, projectId) => {
    const { POST } = await import('@/app/api/projects/[id]/agent-approvals/route')
    return POST(
      req({ method: 'POST', token, path: `/api/projects/${projectId}/agent-approvals`, body: { approvalId: randomUUID(), decision: 'approve' } }) as any,
      params({ id: projectId }),
    )
  },
  approveFinding: async (token, projectId) => {
    const { POST } = await import('@/app/api/projects/[id]/health/approve/route')
    return POST(
      req({ method: 'POST', token, path: `/api/projects/${projectId}/health/approve`, body: { findingId: randomUUID() } }) as any,
      params({ id: projectId }),
    )
  },
  undoFix: async (token, projectId) => {
    const { DELETE } = await import('@/app/api/projects/[id]/health/approve/route')
    return DELETE(
      req({ method: 'DELETE', token, path: `/api/projects/${projectId}/health/approve`, query: `?findingId=${randomUUID()}&confirm=true` }) as any,
      params({ id: projectId }),
    )
  },
  dismissFinding: async (token, projectId) => {
    const { POST } = await import('@/app/api/projects/[id]/health/route')
    return POST(
      req({ method: 'POST', token, path: `/api/projects/${projectId}/health`, body: { findingId: randomUUID() } }) as any,
      params({ id: projectId }),
    )
  },
  setDial: async (token, projectId) => {
    const { PATCH } = await import('@/app/api/projects/[id]/autonomy/route')
    return PATCH(
      req({ method: 'PATCH', token, path: `/api/projects/${projectId}/autonomy`, body: { level: 'observe' } }) as any,
      params({ id: projectId }),
    )
  },
  grantMaintenance: async (token, projectId) => {
    const { POST } = await import('@/app/api/projects/[id]/maintenance/route')
    return POST(
      req({ method: 'POST', token, path: `/api/projects/${projectId}/maintenance`, body: {} }) as any,
      params({ id: projectId }),
    )
  },
  approveFindingFix: async (token, projectId) => {
    const { POST } = await import('@/app/api/projects/[id]/approvals/[findingId]/route')
    return POST(
      req({ method: 'POST', token, path: `/api/projects/${projectId}/approvals/${randomUUID()}` }) as any,
      params({ id: projectId, findingId: randomUUID() }),
    )
  },
  rollbackFinding: async (token, projectId) => {
    const { POST } = await import('@/app/api/projects/[id]/approvals/[findingId]/rollback/route')
    return POST(
      req({ method: 'POST', token, path: `/api/projects/${projectId}/approvals/${randomUUID()}/rollback` }) as any,
      params({ id: projectId, findingId: randomUUID() }),
    )
  },
  createBranch: async (token, projectId) => {
    const { POST } = await import('@/app/api/projects/[id]/branches/route')
    return POST(
      req({ method: 'POST', token, path: `/api/projects/${projectId}/branches`, body: { name: 'test-branch' } }) as any,
      params({ id: projectId }),
    )
  },
  mergeBranch: async (token, projectId) => {
    const { POST } = await import('@/app/api/projects/[id]/branches/[branchId]/route')
    return POST(
      req({ method: 'POST', token, path: `/api/projects/${projectId}/branches/${randomUUID()}` }) as any,
      params({ id: projectId, branchId: randomUUID() }),
    )
  },
  discardBranch: async (token, projectId) => {
    const { DELETE } = await import('@/app/api/projects/[id]/branches/[branchId]/route')
    return DELETE(
      req({ method: 'DELETE', token, path: `/api/projects/${projectId}/branches/${randomUUID()}` }) as any,
      params({ id: projectId, branchId: randomUUID() }),
    )
  },
  goLive: async (token, projectId) => {
    const { POST } = await import('@/app/api/projects/[id]/go-live/route')
    return POST(
      req({ method: 'POST', token, path: `/api/projects/${projectId}/go-live` }) as any,
      params({ id: projectId }),
    )
  },
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
  if (createdProjectIds.length) {
    await prisma.auditLog.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.projectMember.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdOrgIds.length) {
    await prisma.organizationMember.deleteMany({ where: { orgId: { in: createdOrgIds } } })
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } })
  }
  if (createdUserIds.length) {
    await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

/** The DEVELOPER-floor surfaces: VIEWER refused, DEVELOPER past the floor. */
const developerFloor: Array<keyof typeof calls> = [
  'approveFinding', 'undoFix', 'dismissFinding', 'setDial', 'approveFindingFix', 'createBranch', 'discardBranch', 'goLive',
]

/** The ADMIN-floor surfaces: DEVELOPER refused, ADMIN past the floor. */
const adminFloor: Array<keyof typeof calls> = [
  'decideApproval', 'grantMaintenance', 'rollbackFinding', 'mergeBranch',
]

describe('DEVELOPER-floor surfaces', () => {
  it('refuse a VIEWER on every one', async () => {
    const f = await fixture('VIEWER')
    for (const name of developerFloor) {
      const res: any = await runAs(f.member, name, f.projectId)
      expect(`${name}:${res.status}`).toBe(`${name}:403`)
    }
  })

  it('let a DEVELOPER past the floor on every one', async () => {
    const f = await fixture('DEVELOPER')
    for (const name of developerFloor) {
      const res: any = await runAs(f.member, name, f.projectId)
      expect(`${name}:${res.status === 403}`).toBe(`${name}:false`)
    }
  })
})

describe('ADMIN-floor surfaces', () => {
  it('refuse a VIEWER and a DEVELOPER on every one', async () => {
    const v = await fixture('VIEWER')
    const d = await fixture('DEVELOPER')
    for (const name of adminFloor) {
      const rv: any = await runAs(v.member, name, v.projectId)
      const rd: any = await runAs(d.member, name, d.projectId)
      expect(`${name}:viewer:${rv.status}`).toBe(`${name}:viewer:403`)
      expect(`${name}:developer:${rd.status}`).toBe(`${name}:developer:403`)
    }
  })

  it('let an ADMIN past the floor on every one', async () => {
    const f = await fixture('ADMIN')
    for (const name of adminFloor) {
      const res: any = await runAs(f.member, name, f.projectId)
      expect(`${name}:${res.status === 403}`).toBe(`${name}:false`)
    }
  })
})

describe('what must stay open', () => {
  it('a VIEWER still reads the Review Queue list', async () => {
    const f = await fixture('VIEWER')
    currentUserId = f.member.id
    const { GET } = await import('@/app/api/projects/[id]/agent-approvals/route')

    const res: any = await GET(
      req({ method: 'GET', token: f.member.token, path: `/api/projects/${f.projectId}/agent-approvals` }) as any,
      params({ id: f.projectId }),
    )

    expect(res.status).toBe(200)
  })

  it('a VIEWER who tries to publish leaves the project exactly as it was', async () => {
    const f = await fixture('VIEWER')
    const before = await prisma.project.findUnique({ where: { id: f.projectId } })

    await runAs(f.member, 'goLive', f.projectId)

    const after = await prisma.project.findUnique({ where: { id: f.projectId } })
    expect(after).toEqual(before)
  })
})

describe('single-tenant', () => {
  it('the operator is OWNER and passes every floor', async () => {
    const f = await fixture('VIEWER')
    process.env.BACKENLY_EDITION = 'single-tenant'
    process.env.BACKENLY_PROJECT_ID = f.projectId
    resetSingleTenantCache()

    const res: any = await runAs(f.owner, 'decideApproval', f.projectId)
    expect(res.status).not.toBe(403)

    delete process.env.BACKENLY_PROJECT_ID
  })
})
