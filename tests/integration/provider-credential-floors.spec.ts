/**
 * PROVIDER SECRETS NEVER REACH A BROWSER, AND THEIR SURFACES HAVE FLOORS
 * ======================================================================
 * Two leaks with the same shape (INT-11, INT-12):
 *
 *   - GET/POST /api/providers called requireAuth, DISCARDED the result, and
 *     returned/created whole platform AuthProvider rows — clientSecret
 *     included — for any signed-in account. The sibling [providerId] route
 *     fixed this exact hole in itself (requireAdmin + redaction) and
 *     documents why the secret never goes to a browser.
 *   - GET /api/provider-credentials/[provider] DECRYPTED the stored
 *     deploy-provider token (Vercel etc.) and sent it to any member who
 *     could resolve the project — VIEWER included — and the save/delete
 *     verbs had no floor either.
 *
 * Now: the providers collection is platform-admin only and redacted; the
 * per-project credential routes are ADMIN-floored and the decrypted material
 * never leaves the server at all (the deploy pipeline reads it server-side;
 * no UI ever consumed the value).
 *
 * Real database, real signed sessions, real wrapper/guard/resolver — the
 * same fixture the connect-credential floor suite uses.
 */

import { randomUUID } from 'crypto'

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

// The scratch database holds many projects; the floors under test are the
// Cloud organization ladder, so the suite runs the cloud resolver (the
// sibling connect-credential floor suite does the same).
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

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

async function makeUser(role: 'user' | 'admin' = 'user'): Promise<{ id: string; token: string }> {
  const email = `pcred-${randomUUID()}@test.invalid`
  // Platform role rides the SESSION claim (authenticateRequest reads it from
  // the token); the User model has no scalar role column.
  const u = await prisma.user.create({ data: { email, name: 'Provider Floor Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  const { token } = await createSession(u.id, email, role)
  return { id: u.id, token }
}

function req(opts: { method: string; token?: string | null; path: string; projectId?: string; body?: unknown }): any {
  const headers: Record<string, string> = {}
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
  if (opts.projectId) headers['x-project-id'] = opts.projectId
  return {
    method: opts.method,
    url: `http://localhost:3000${opts.path}`,
    nextUrl: { pathname: opts.path, searchParams: new URLSearchParams() },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => opts.body ?? {},
  }
}

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) })

let owner!: { id: string; token: string }
let viewer!: { id: string; token: string }
let projectId = ''
const VERCEL_TOKEN = `vercel_tok_${randomUUID().replace(/-/g, '')}`

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  assertSafeTestDatabase()
  owner = await makeUser()
  viewer = await makeUser()
  const org = await prisma.organization.create({
    data: { name: `pcred-org-${randomUUID().slice(0, 8)}`, ownerId: owner.id },
    select: { id: true },
  })
  createdOrgIds.push(org.id)
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: owner.id, role: 'OWNER' } })
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: viewer.id, role: 'VIEWER' } })
  const p = await prisma.project.create({
    data: { name: `pcred-${randomUUID().slice(0, 8)}`, userId: owner.id, organizationId: org.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  projectId = p.id
}, 120_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await prisma.providerCredential.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } }).catch(() => {})
  await prisma.organizationMember.deleteMany({ where: { orgId: { in: createdOrgIds } } }).catch(() => {})
  await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
})

describe('INT-12: per-project deploy credentials', () => {
  it('the owner saves them (ADMIN floor passes)', async () => {
    const { POST } = await import('@/app/api/provider-credentials/route')
    const res: any = await POST(
      req({
        method: 'POST', token: owner.token, path: '/api/provider-credentials', projectId,
        body: { provider: 'vercel', credentials: { token: VERCEL_TOKEN }, name: 'deploy' },
      }) as any,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain(VERCEL_TOKEN)
  }, 60_000)

  it('a VIEWER cannot save, read or delete them', async () => {
    const { POST } = await import('@/app/api/provider-credentials/route')
    const save: any = await POST(
      req({
        method: 'POST', token: viewer.token, path: '/api/provider-credentials', projectId,
        body: { provider: 'railway', credentials: { token: 'nope' } },
      }) as any,
    )
    expect(save.status).toBe(403)

    const { GET, DELETE } = await import('@/app/api/provider-credentials/[provider]/route')
    const read: any = await GET(
      req({ method: 'GET', token: viewer.token, path: '/api/provider-credentials/vercel', projectId }) as any,
      params({ provider: 'vercel' }),
    )
    expect(read.status).toBe(403)

    const del: any = await DELETE(
      req({ method: 'DELETE', token: viewer.token, path: '/api/provider-credentials/vercel', projectId }) as any,
      params({ provider: 'vercel' }),
    )
    expect(del.status).toBe(403)
    expect(await prisma.providerCredential.count({ where: { projectId, provider: 'vercel' } })).toBe(1)
  }, 60_000)

  it('even the owner is told it is configured — never the decrypted token', async () => {
    const { GET } = await import('@/app/api/provider-credentials/[provider]/route')
    const res: any = await GET(
      req({ method: 'GET', token: owner.token, path: '/api/provider-credentials/vercel', projectId }) as any,
      params({ provider: 'vercel' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(true)
    expect(JSON.stringify(body)).not.toContain(VERCEL_TOKEN)
  }, 60_000)
})

describe('INT-11: the platform providers collection', () => {
  it('a plain signed-in account is refused', async () => {
    const { GET } = await import('@/app/api/providers/route')
    const res: any = await GET(req({ method: 'GET', token: owner.token, path: '/api/providers' }) as any)
    expect(res.status).toBe(403)
  }, 60_000)

  it('a platform admin reads rows with the secret withheld', async () => {
    const admin = await makeUser('admin')
    await prisma.authProvider.upsert({
      where: { name: 'github' },
      create: { name: 'github', type: 'oauth', enabled: true, configured: true, clientId: 'cid', clientSecret: 'csecret-xyz', scopes: [] },
      update: { clientSecret: 'csecret-xyz' },
    })
    const { GET } = await import('@/app/api/providers/route')
    const res: any = await GET(req({ method: 'GET', token: admin.token, path: '/api/providers' }) as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('csecret-xyz')
    const github = body.providers.find((p: any) => p.name === 'github')
    expect(github.clientSecretSet).toBe(true)
  }, 60_000)
})
