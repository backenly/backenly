/**
 * WORKSPACE OAUTH CREDENTIALS ARE A TENANT BOUNDARY
 * ================================================
 * `/api/workspace-oauth` stores the OAuth client a project's END USERS sign in
 * through: the client id, the encrypted client secret, the redirect URI. Whoever
 * can write that row decides which OAuth app the project's "Sign in with Google"
 * authorizes against. Whoever can delete it takes social sign-in down.
 *
 * The three handlers authenticated the caller and then took the project id from
 * the `x-project-id` header with no further question, so any signed-in account
 * could list, replace or delete another project's provider credentials by naming
 * its id. Project ids are not secret: every runtime URL carries one.
 *
 * The rule pinned here is the one every sibling auth-settings route already
 * follows (auth-config, auth-email-settings):
 *
 *   stranger    nothing: no list, no write, no delete, and the victim's row is untouched
 *   VIEWER      may see which providers are configured (never a secret)
 *   DEVELOPER   may save a provider, as with the rest of the auth configuration
 *   ADMIN       may delete one, which is irreversible from the dashboard
 *   OWNER       everything
 *
 * Real database, real signed sessions, the real handlers, guard and resolver.
 * The defect was a missing check between a header and a query, which a mocked
 * client would model as whatever the test assumed.
 */

import { randomBytes, randomUUID } from 'crypto'

/**
 * Where an organization member's role comes from.
 *
 * The public tree resolves `@cloud/project-access` to a stub that knows no
 * organizations (lib/edition/oss/project-access.ts), so without this every
 * member would read as a stranger and the role ladder could not be exercised
 * here at all. When the Cloud overlay is composed, the real module is used.
 * Otherwise this mirrors lib/cloud/project-access.ts line for line, against the
 * real membership rows in the test database. Everything after the role lookup,
 * the handlers, the guard and the resolver, is the real implementation.
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
import { WorkspaceOAuthService } from '@/lib/services/workspaceOAuth'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

const DB_URL = process.env.TEST_DATABASE_URL

// The service refuses to store a client secret without a key, deliberately.
// A per-run key keeps this suite from depending on one being configured.
process.env.OAUTH_ENCRYPTION_KEY = process.env.OAUTH_ENCRYPTION_KEY || randomBytes(32).toString('hex')

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
  const email = `woauth-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Workspace OAuth Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  return { id: u.id, token }
}

/**
 * An organization-owned project with a configured Google client, plus one
 * member holding `role`.
 */
async function fixture(role: 'VIEWER' | 'DEVELOPER' | 'ADMIN') {
  const owner = await makeUser()
  const member = await makeUser()
  const org = await prisma.organization.create({
    data: { name: `woauth-org-${randomUUID().slice(0, 8)}`, ownerId: owner.id },
    select: { id: true },
  })
  createdOrgIds.push(org.id)
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: owner.id, role: 'OWNER' } })
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: member.id, role } })

  const p = await prisma.project.create({
    data: { name: `woauth-${randomUUID().slice(0, 8)}`, userId: owner.id, organizationId: org.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)

  await WorkspaceOAuthService.upsertConfig(p.id, {
    provider: 'google',
    clientId: 'victim-client-id',
    clientSecret: 'victim-client-secret',
    redirectUri: 'https://victim.example/auth/callback',
    scopes: ['openid', 'email'],
    enabled: true,
  })

  return { owner, member, projectId: p.id }
}

/**
 * jest.setup.js replaces the global Request, so a real NextRequest cannot be
 * built here. This is the subset the handlers and authenticateRequest touch.
 */
function req(opts: { method: string; token?: string | null; projectId?: string | null; body?: unknown; path?: string }): any {
  const path = opts.path ?? '/api/workspace-oauth'
  const headers: Record<string, string> = {}
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
  if (opts.projectId) headers['x-project-id'] = opts.projectId
  return {
    method: opts.method,
    url: `http://localhost:3000${path}`,
    nextUrl: { pathname: path },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => opts.body ?? {},
  }
}

const ATTACKER_CONFIG = {
  provider: 'google',
  clientId: 'attacker-client-id',
  clientSecret: 'attacker-client-secret',
  redirectUri: 'https://attacker.example/steal',
}

async function storedGoogle(projectId: string) {
  return prisma.workspaceOAuthConfig.findUnique({
    where: { projectId_provider: { projectId, provider: 'google' } },
    select: { clientId: true, clientSecret: true, redirectUri: true },
  })
}

async function listAs(token: string, projectId: string) {
  const { GET } = await import('@/app/api/workspace-oauth/route')
  return GET(req({ method: 'GET', token, projectId }) as any)
}

async function saveAs(token: string, projectId: string) {
  const { POST } = await import('@/app/api/workspace-oauth/route')
  return POST(req({ method: 'POST', token, projectId, body: ATTACKER_CONFIG }) as any)
}

async function deleteAs(token: string, projectId: string) {
  const { DELETE } = await import('@/app/api/workspace-oauth/[provider]/route')
  return DELETE(
    req({ method: 'DELETE', token, projectId, path: '/api/workspace-oauth/google' }) as any,
    { params: Promise.resolve({ provider: 'google' }) },
  )
}

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_PINNED = process.env.BACKENLY_PROJECT_ID

beforeAll(() => {
  assertSafeTestDatabase()
})

beforeEach(() => {
  process.env.BACKENLY_EDITION = 'cloud'
})

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  if (ORIGINAL_PINNED === undefined) delete process.env.BACKENLY_PROJECT_ID
  else process.env.BACKENLY_PROJECT_ID = ORIGINAL_PINNED
  resetSingleTenantCache()
})

afterAll(async () => {
  if (createdProjectIds.length) {
    await prisma.workspaceOAuthConfig.deleteMany({ where: { projectId: { in: createdProjectIds } } })
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

describe('a signed-in stranger', () => {
  it('cannot replace another project\'s OAuth client, and the stored row is untouched', async () => {
    const f = await fixture('DEVELOPER')
    const stranger = await makeUser()
    const before = await storedGoogle(f.projectId)

    const res: any = await saveAs(stranger.token, f.projectId)

    expect(res.status).toBe(404)
    expect(await storedGoogle(f.projectId)).toEqual(before)
  })

  it('cannot delete another project\'s OAuth client', async () => {
    const f = await fixture('DEVELOPER')
    const stranger = await makeUser()

    const res: any = await deleteAs(stranger.token, f.projectId)

    expect(res.status).toBe(404)
    expect(await storedGoogle(f.projectId)).not.toBeNull()
  })

  it('cannot list which providers another project uses', async () => {
    const f = await fixture('DEVELOPER')
    const stranger = await makeUser()

    const res: any = await listAs(stranger.token, f.projectId)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(JSON.stringify(body)).not.toContain('victim-client-id')
  })

  it('gets the same answer for a real project and one that never existed', async () => {
    const f = await fixture('DEVELOPER')
    const stranger = await makeUser()

    const real: any = await saveAs(stranger.token, f.projectId)
    const ghost: any = await saveAs(stranger.token, randomUUID())

    // Refusing must not become an existence oracle for project ids.
    expect(real.status).toBe(ghost.status)
    expect(await real.json()).toEqual(await ghost.json())
  })
})

describe('organization roles', () => {
  it('a VIEWER can see which providers are configured, without any secret', async () => {
    const f = await fixture('VIEWER')

    const res: any = await listAs(f.member.token, f.projectId)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.configs.map((c: any) => c.provider)).toEqual(['google'])
    expect(JSON.stringify(body)).not.toContain('victim-client-secret')
  })

  it('a VIEWER cannot replace the OAuth client', async () => {
    const f = await fixture('VIEWER')
    const before = await storedGoogle(f.projectId)

    const res: any = await saveAs(f.member.token, f.projectId)

    expect(res.status).toBe(403)
    expect(await storedGoogle(f.projectId)).toEqual(before)
  })

  it('a VIEWER cannot delete the OAuth client', async () => {
    const f = await fixture('VIEWER')

    const res: any = await deleteAs(f.member.token, f.projectId)

    expect(res.status).toBe(403)
    expect(await storedGoogle(f.projectId)).not.toBeNull()
  })

  it('a DEVELOPER can save a provider, and the secret is never echoed back', async () => {
    const f = await fixture('DEVELOPER')

    const res: any = await saveAs(f.member.token, f.projectId)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect((await storedGoogle(f.projectId))?.clientId).toBe('attacker-client-id')
    expect(JSON.stringify(body)).not.toContain('attacker-client-secret')
  })

  it('a DEVELOPER cannot delete one: removing sign-in is an administrative act', async () => {
    const f = await fixture('DEVELOPER')

    const res: any = await deleteAs(f.member.token, f.projectId)

    expect(res.status).toBe(403)
    expect(await storedGoogle(f.projectId)).not.toBeNull()
  })

  it('an ADMIN can delete one', async () => {
    const f = await fixture('ADMIN')

    const res: any = await deleteAs(f.member.token, f.projectId)

    expect(res.status).toBe(200)
    expect(await storedGoogle(f.projectId)).toBeNull()
  })

  it('the owner can list, save and delete', async () => {
    const f = await fixture('VIEWER')

    expect(((await listAs(f.owner.token, f.projectId)) as any).status).toBe(200)
    expect(((await saveAs(f.owner.token, f.projectId)) as any).status).toBe(200)
    expect(((await deleteAs(f.owner.token, f.projectId)) as any).status).toBe(200)
    expect(await storedGoogle(f.projectId)).toBeNull()
  })
})

describe('request shape', () => {
  it('refuses an unauthenticated request before touching any project', async () => {
    const f = await fixture('VIEWER')
    const { POST } = await import('@/app/api/workspace-oauth/route')

    const res: any = await POST(req({ method: 'POST', projectId: f.projectId, body: ATTACKER_CONFIG }) as any)

    expect(res.status).toBe(401)
    expect((await storedGoogle(f.projectId))?.clientId).toBe('victim-client-id')
  })

  it('refuses a Cloud request that names no project instead of guessing one', async () => {
    const owner = await makeUser()

    const res: any = await listAs(owner.token, null as any)

    expect(res.status).toBe(400)
  })
})

describe('single-tenant', () => {
  it('the operator still manages THE project\'s providers', async () => {
    const f = await fixture('VIEWER')
    process.env.BACKENLY_EDITION = 'single-tenant'
    process.env.BACKENLY_PROJECT_ID = f.projectId
    resetSingleTenantCache()

    expect(((await listAs(f.owner.token, f.projectId)) as any).status).toBe(200)
    expect(((await saveAs(f.owner.token, f.projectId)) as any).status).toBe(200)
    expect(((await deleteAs(f.owner.token, f.projectId)) as any).status).toBe(200)
  })
})
