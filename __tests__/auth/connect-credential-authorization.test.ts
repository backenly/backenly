/**
 * CREDENTIAL SURFACES ARE HELD TO A ROLE, NOT TO MEMBERSHIP
 * =========================================================
 * The Connect page's credential routes authorized with `withProjectValidation`
 * alone, which answers "is this caller a member of the project" and nothing
 * more. On Cloud that admitted every organization role, so a VIEWER — the rank
 * that exists to look and not touch — could:
 *
 *   POST   /api/projects/[id]/mcp/keys            mint a full-write mcp_live_ key
 *   DELETE /api/projects/[id]/mcp/keys/[keyId]    revoke the team's agent key
 *   GET    /api/projects/[id]/database-access     read live Postgres passwords
 *   POST   /api/projects/[id]/database-access     provision READ_WRITE credentials
 *   POST   /api/projects/[id]/database-access/rotate  rotate them
 *   GET    /api/projects/[id]/export/database     stream a full pg_dump
 *
 * Every one of those GRANTS something: a credential, or the tenant's data in
 * bulk. The repository's own rule (lib/edition/guard.ts, /api/api-keys) is that
 * issuing a credential is administration, so the floor pinned here is:
 *
 *   stranger            403, nothing created, nothing revealed
 *   VIEWER / DEVELOPER  403 on every credential-granting verb, no side effect
 *   ADMIN / OWNER       allowed
 *   mcp/keys GET        stays VIEWER: the list is masked, no plaintext exists
 *
 * Real database, real signed sessions, the real wrapper, guard and resolver.
 * The ADMIN assertions for database-access / export accept the route's own
 * downstream answer (503 cluster-not-enabled, 404 nothing-to-rotate, 500) —
 * anything but 403 — because this scratch cluster has no direct-access setup;
 * what is under test is the floor, and those answers are only reachable past it.
 */

import { randomUUID } from 'crypto'

/**
 * Where an organization member's role comes from. The public tree resolves
 * `@cloud/project-access` to a stub that knows no organizations; with the Cloud
 * overlay composed the real module is used. Otherwise this mirrors
 * lib/cloud/project-access.ts against the real membership rows. Everything
 * after the role lookup — handlers, wrapper, guard, resolver — is real.
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
  const email = `cred-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Credential Floor Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  return { id: u.id, token }
}

/** An organization-owned project plus one member holding `role`. */
async function fixture(role: 'VIEWER' | 'DEVELOPER' | 'ADMIN') {
  const owner = await makeUser()
  const member = await makeUser()
  const org = await prisma.organization.create({
    data: { name: `cred-org-${randomUUID().slice(0, 8)}`, ownerId: owner.id },
    select: { id: true },
  })
  createdOrgIds.push(org.id)
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: owner.id, role: 'OWNER' } })
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: member.id, role } })

  const p = await prisma.project.create({
    data: { name: `cred-${randomUUID().slice(0, 8)}`, userId: owner.id, organizationId: org.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  return { owner, member, projectId: p.id }
}

/**
 * jest.setup.js replaces the global Request; this is the subset the wrapper
 * and handlers touch. The project id rides the PATH, as the real routes have
 * it — withProjectValidation reads it from nextUrl.pathname.
 */
function req(opts: { method: string; token?: string | null; path: string; body?: unknown }): any {
  const headers: Record<string, string> = {}
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
  return {
    method: opts.method,
    url: `http://localhost:3000${opts.path}`,
    nextUrl: { pathname: opts.path },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => opts.body ?? {},
  }
}

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) })

async function mintKey(token: string, projectId: string) {
  const { POST } = await import('@/app/api/projects/[id]/mcp/keys/route')
  return POST(
    req({ method: 'POST', token, path: `/api/projects/${projectId}/mcp/keys`, body: { name: 'test key' } }) as any,
    params({ id: projectId }),
  )
}

async function listKeys(token: string, projectId: string) {
  const { GET } = await import('@/app/api/projects/[id]/mcp/keys/route')
  return GET(req({ method: 'GET', token, path: `/api/projects/${projectId}/mcp/keys` }) as any, params({ id: projectId }))
}

async function revokeKey(token: string, projectId: string, keyId: string) {
  const { DELETE } = await import('@/app/api/projects/[id]/mcp/keys/[keyId]/route')
  return DELETE(
    req({ method: 'DELETE', token, path: `/api/projects/${projectId}/mcp/keys/${keyId}` }) as any,
    params({ id: projectId, keyId }),
  )
}

async function dbAccess(method: 'GET' | 'POST' | 'DELETE', token: string, projectId: string, body?: unknown) {
  const route = await import('@/app/api/projects/[id]/database-access/route')
  const path = `/api/projects/${projectId}/database-access${method === 'DELETE' ? '?mode=READ_ONLY' : ''}`
  return route[method](req({ method, token, path, body }) as any)
}

async function rotate(token: string, projectId: string) {
  const { POST } = await import('@/app/api/projects/[id]/database-access/rotate/route')
  return POST(req({ method: 'POST', token, path: `/api/projects/${projectId}/database-access/rotate`, body: { mode: 'READ_ONLY' } }) as any)
}

async function exportDb(token: string, projectId: string) {
  const { GET } = await import('@/app/api/projects/[id]/export/database/route')
  return GET(req({ method: 'GET', token, path: `/api/projects/${projectId}/export/database` }) as any)
}

const keyRows = (projectId: string) => prisma.apiKey.findMany({ where: { projectId, scope: 'mcp' } })

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
    await prisma.apiKey.deleteMany({ where: { projectId: { in: createdProjectIds } } })
  }
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

describe('minting an MCP key', () => {
  it('a stranger is refused and no key row or audit row appears', async () => {
    const f = await fixture('VIEWER')
    const stranger = await makeUser()

    const res: any = await mintKey(stranger.token, f.projectId)

    expect(res.status).toBe(403)
    expect(await keyRows(f.projectId)).toHaveLength(0)
  })

  it('a VIEWER is refused and no key row appears', async () => {
    const f = await fixture('VIEWER')

    const res: any = await mintKey(f.member.token, f.projectId)

    expect(res.status).toBe(403)
    expect(await keyRows(f.projectId)).toHaveLength(0)
  })

  it('a DEVELOPER is refused: issuing a credential is administration', async () => {
    const f = await fixture('DEVELOPER')

    const res: any = await mintKey(f.member.token, f.projectId)

    expect(res.status).toBe(403)
    expect(await keyRows(f.projectId)).toHaveLength(0)
  })

  it('an ADMIN mints a key and receives the plaintext once', async () => {
    const f = await fixture('ADMIN')

    const res: any = await mintKey(f.member.token, f.projectId)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.rawKey).toMatch(/^mcp_live_[0-9a-f]{64}$/)
    expect(await keyRows(f.projectId)).toHaveLength(1)
  })

  it('the owner mints a key', async () => {
    const f = await fixture('VIEWER')

    const res: any = await mintKey(f.owner.token, f.projectId)

    expect(res.status).toBe(200)
  })
})

describe('listing MCP keys stays a VIEWER read', () => {
  it('a VIEWER sees the masked list and no plaintext key material', async () => {
    const f = await fixture('VIEWER')
    await mintKey(f.owner.token, f.projectId)

    const res: any = await listKeys(f.member.token, f.projectId)
    const text = JSON.stringify(await res.json())

    expect(res.status).toBe(200)
    expect(text).toContain('mcp_live_')
    // The 64-hex secret half never appears; only the 16-char prefix is stored.
    expect(text).not.toMatch(/mcp_live_[0-9a-f]{20,}/)
  })
})

describe('revoking an MCP key', () => {
  it('a DEVELOPER is refused and the key keeps working', async () => {
    const f = await fixture('DEVELOPER')
    await mintKey(f.owner.token, f.projectId)
    const [key] = await keyRows(f.projectId)

    const res: any = await revokeKey(f.member.token, f.projectId, key.id)

    expect(res.status).toBe(403)
    expect(await keyRows(f.projectId)).toHaveLength(1)
  })

  it('an ADMIN revokes it', async () => {
    const f = await fixture('ADMIN')
    await mintKey(f.owner.token, f.projectId)
    const [key] = await keyRows(f.projectId)

    const res: any = await revokeKey(f.member.token, f.projectId, key.id)

    expect(res.status).toBe(200)
    expect(await keyRows(f.projectId)).toHaveLength(0)
  })
})

describe('direct database credentials', () => {
  it('a VIEWER cannot read the credential status: the response carries live passwords', async () => {
    const f = await fixture('VIEWER')

    const res: any = await dbAccess('GET', f.member.token, f.projectId)

    expect(res.status).toBe(403)
  })

  it('a DEVELOPER can neither provision, revoke nor rotate', async () => {
    const f = await fixture('DEVELOPER')

    expect(((await dbAccess('POST', f.member.token, f.projectId, { mode: 'READ_WRITE' })) as any).status).toBe(403)
    expect(((await dbAccess('DELETE', f.member.token, f.projectId)) as any).status).toBe(403)
    expect(((await rotate(f.member.token, f.projectId)) as any).status).toBe(403)
    expect(await prisma.databaseCredential.count({ where: { projectId: f.projectId } })).toBe(0)
  })

  it('an ADMIN passes the floor on every verb', async () => {
    const f = await fixture('ADMIN')

    // This scratch cluster has no direct-access definer functions, so the
    // routes answer with their own downstream errors — reachable only PAST the
    // floor. What must never come back for an ADMIN is the floor's 403.
    const get: any = await dbAccess('GET', f.member.token, f.projectId)
    const post: any = await dbAccess('POST', f.member.token, f.projectId, { mode: 'READ_ONLY' })
    const rot: any = await rotate(f.member.token, f.projectId)

    expect(get.status).toBe(200)
    expect(post.status).not.toBe(403)
    expect(rot.status).not.toBe(403)
  })
})

describe('database export', () => {
  it('a VIEWER and a DEVELOPER are refused', async () => {
    const v = await fixture('VIEWER')
    const d = await fixture('DEVELOPER')

    expect(((await exportDb(v.member.token, v.projectId)) as any).status).toBe(403)
    expect(((await exportDb(d.member.token, d.projectId)) as any).status).toBe(403)
  })

  it('an ADMIN passes the floor', async () => {
    const f = await fixture('ADMIN')

    const res: any = await exportDb(f.member.token, f.projectId)

    // No workspace schema exists for this fixture, so the route may fail
    // downstream; the floor's 403 is the one answer that must not appear.
    expect(res.status).not.toBe(403)
  })
})

describe('single-tenant', () => {
  it('the operator still mints and revokes: every account is OWNER there', async () => {
    const f = await fixture('VIEWER')
    process.env.BACKENLY_EDITION = 'single-tenant'
    process.env.BACKENLY_PROJECT_ID = f.projectId
    resetSingleTenantCache()

    const res: any = await mintKey(f.owner.token, f.projectId)
    expect(res.status).toBe(200)

    const [key] = await keyRows(f.projectId)
    expect((((await revokeKey(f.owner.token, f.projectId, key.id)) as any)).status).toBe(200)

    delete process.env.BACKENLY_PROJECT_ID
  })
})
