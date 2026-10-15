/**
 * API KEYS ARE A PROJECT SURFACE, AND withProjectAccess ROUTES HAVE FLOORS
 * ========================================================================
 * SET-03: Settings → API keys listed and revoked only the CALLER'S OWN rows
 * with no project-access check. Agent-created keys belong to the project
 * owner, so an org ADMIN saw an empty table and could not revoke a leaked
 * key from the one place the docs say to do it — while an EX-member kept
 * revoke power over rows they created.
 *
 * SET-04: withProjectAccess answers "is this caller a member" and nothing
 * more, and two routes relied on it alone: share-report (mints an
 * UNAUTHENTICATED public URL onto the project's activity ledger) and the
 * Supabase importer (writes the workspace). A VIEWER could do both.
 *
 * Floors now: list = member read (masked metadata only); revoke = project
 * ADMIN, or creator while still a member; share-report = ADMIN; importer =
 * DEVELOPER. Real routes, sessions, resolver and membership rows.
 */

import { randomBytes, randomUUID } from 'crypto'

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

// withProjectAccess resolves identity via next/headers; the floor decisions
// inside the handlers are what is under test, so the wrapper is delegated to
// the real verifyProjectAccess path with a test-controlled user, mirroring
// the house pattern for this wrapper.
let currentUserId = ''
jest.mock('@/lib/auth/route-protection', () => {
  const actual = jest.requireActual('@/lib/auth/route-protection')
  return {
    ...actual,
    withProjectAccess: (handler: any) => async (request: any, ctx: any = {}) => {
      const { canAccessProject } = jest.requireActual('@/lib/edition/guard')
      const projectId = String(request?.nextUrl?.pathname ?? '').split('/')[3] ?? ''
      if (!(await canAccessProject(currentUserId, projectId))) {
        const { NextResponse } = jest.requireActual('next/server')
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
      return handler(request, { user: { userId: currentUserId }, projectId, params: ctx.params })
    },
  }
})

import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const createdUserIds: string[] = []
const createdOrgIds: string[] = []
const createdProjectIds: string[] = []

async function makeUser(): Promise<{ id: string; token: string }> {
  const email = `skf-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Keys Floor Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  return { id: u.id, token }
}

function req(opts: { method: string; token?: string; path: string; body?: unknown; query?: string }): any {
  const headers: Record<string, string> = {}
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
  return {
    method: opts.method,
    url: `http://localhost:3000${opts.path}${opts.query ?? ''}`,
    nextUrl: { pathname: opts.path, searchParams: new URLSearchParams((opts.query ?? '').replace(/^\?/, '')), origin: 'http://localhost:3000' },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => opts.body ?? {},
  }
}

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) })

let owner!: { id: string; token: string }
let orgAdmin!: { id: string; token: string }
let viewer!: { id: string; token: string }
let projectId = ''
let agentKeyId = ''

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  assertSafeTestDatabase()
  owner = await makeUser()
  orgAdmin = await makeUser()
  viewer = await makeUser()
  const org = await prisma.organization.create({
    data: { name: `skf-org-${randomUUID().slice(0, 8)}`, ownerId: owner.id },
    select: { id: true },
  })
  createdOrgIds.push(org.id)
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: owner.id, role: 'OWNER' } })
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: orgAdmin.id, role: 'ADMIN' } })
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: viewer.id, role: 'VIEWER' } })
  const p = await prisma.project.create({
    data: { name: `skf-${randomUUID().slice(0, 8)}`, userId: owner.id, organizationId: org.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  projectId = p.id

  // An agent-created key: owned by the PROJECT OWNER, as the executor mints it.
  const raw = `proj_live_${randomBytes(24).toString('hex')}`
  agentKeyId = (
    await prisma.apiKey.create({
      data: {
        name: 'agent key', keyPrefix: raw.slice(0, 16), keyHash: hashApiKey(raw),
        permissions: ['read', 'write'], capabilities: [], userId: owner.id, projectId,
        keyType: 'public', scope: 'runtime', serviceRole: false, rateLimit: 1000,
      },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await prisma.shareToken.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } }).catch(() => {})
  await prisma.organizationMember.deleteMany({ where: { orgId: { in: createdOrgIds } } }).catch(() => {})
  await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
})

describe('SET-03: the keys table is the project surface the docs describe', () => {
  it("an org ADMIN sees the owner's agent key in the list", async () => {
    const { GET } = await import('@/app/api/api-keys/route')
    const res: any = await GET(req({ method: 'GET', token: orgAdmin.token, path: '/api/api-keys', query: `?projectId=${projectId}` }) as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.apiKeys.map((k: any) => k.id)
    expect(ids).toContain(agentKeyId)
    // Masked metadata only — never a full plaintext key.
    for (const k of body.apiKeys) expect(String(k.key)).toMatch(/•/) // the keyPrefix mask, never plaintext
  }, 60_000)

  it('a stranger is told nothing', async () => {
    const stranger = await makeUser()
    const { GET } = await import('@/app/api/api-keys/route')
    const res: any = await GET(req({ method: 'GET', token: stranger.token, path: '/api/api-keys', query: `?projectId=${projectId}` }) as any)
    expect(res.status).toBe(404)
  }, 60_000)

  it('a VIEWER cannot revoke, an org ADMIN can', async () => {
    const { DELETE } = await import('@/app/api/api-keys/[id]/route')
    const asViewer: any = await DELETE(
      req({ method: 'DELETE', token: viewer.token, path: `/api/api-keys/${agentKeyId}` }) as any,
      params({ id: agentKeyId }),
    )
    expect(asViewer.status).toBe(404) // no existence oracle
    expect(await prisma.apiKey.count({ where: { id: agentKeyId } })).toBe(1)

    const asAdmin: any = await DELETE(
      req({ method: 'DELETE', token: orgAdmin.token, path: `/api/api-keys/${agentKeyId}` }) as any,
      params({ id: agentKeyId }),
    )
    expect(asAdmin.status).toBe(200)
    expect(await prisma.apiKey.count({ where: { id: agentKeyId } })).toBe(0)
  }, 60_000)
})

describe('SET-04: withProjectAccess routes carry their own floors', () => {
  it('a VIEWER cannot publish a public share link; an ADMIN can', async () => {
    const { POST } = await import('@/app/api/projects/[id]/share-report/route')
    currentUserId = viewer.id
    const asViewer: any = await POST(
      req({ method: 'POST', path: `/api/projects/${projectId}/share-report` }) as any,
      params({ id: projectId }),
    )
    expect(asViewer.status).toBe(403)
    expect(await prisma.shareToken.count({ where: { projectId } })).toBe(0)

    currentUserId = orgAdmin.id
    const asAdmin: any = await POST(
      req({ method: 'POST', path: `/api/projects/${projectId}/share-report` }) as any,
      params({ id: projectId }),
    )
    expect(asAdmin.status).toBe(200)
    expect(await prisma.shareToken.count({ where: { projectId } })).toBe(1)
  }, 60_000)

  it('a VIEWER cannot run the workspace importer', async () => {
    process.env.SUPABASE_IMPORT_ENABLED = 'true'
    try {
      const mod = await import('@/app/api/projects/[id]/import/supabase/route')
      currentUserId = viewer.id
      const res: any = await (mod as any).POST(
        req({
          method: 'POST', path: `/api/projects/${projectId}/import/supabase`,
          body: { connectionString: 'postgresql://u:p@db.example:5432/x' },
        }) as any,
        params({ id: projectId }),
      )
      expect(res.status).toBe(403)
    } finally {
      delete process.env.SUPABASE_IMPORT_ENABLED
    }
  }, 60_000)
})
