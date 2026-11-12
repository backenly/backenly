/**
 * INTEGRATION KEYS HAVE THE FLOORS ENV VARS HAVE
 * ==============================================
 * The console connects a provider through three routes: POST credentials (the
 * Integrations page), POST integrations/keys (the key vault) and POST
 * integrations (the switch that marks one on); integrations/keys DELETE
 * disconnects it. The floors follow the project's encrypted env vars
 * (app/api/projects/[id]/env-vars) and the key check the page runs first
 * (credentials/verify):
 *
 *   store or replace a key      DEVELOPER   (credentials, integrations/keys POST)
 *   turn an integration on      DEVELOPER   (integrations POST)
 *   remove a key                ADMIN       (integrations/keys DELETE)
 *
 * Reads stay open to every member: masked keys only.
 *
 * Real database, real signed sessions, real wrappers, guard and resolver.
 * PostHog is the stored provider because its key is stored unverifiable, so
 * no provider is called.
 */

import { randomUUID } from 'crypto'

/**
 * Identity for the withProjectAccess route (integrations/keys).
 * `requireUser` reads next/headers, which jest cannot drive, so
 * requireProjectAccess is reimplemented as operate-role-floors.test.ts does:
 * the real verifyProjectAccess decides, only the identity is the test's.
 */
let currentUserId = ''

jest.mock('@/lib/auth/server', () => {
  const actual = jest.requireActual('@/lib/auth/server')
  return {
    ...actual,
    requireProjectAccess: jest.fn(async (request: Request) => {
      const { verifyProjectAccess } = jest.requireActual('@/lib/auth/project-access')
      const projectId = new URL(request.url).pathname.match(/\/projects\/([a-zA-Z0-9-_]+)/)?.[1] ?? null
      if (!projectId) throw new actual.ForbiddenError('Missing projectId - project context required')
      const project = await verifyProjectAccess(projectId, currentUserId)
      return { user: { userId: currentUserId, email: `${currentUserId}@test.invalid` }, project, projectId }
    }),
  }
})

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
import { encrypt } from '@/lib/services/encryption'
import { getIntegrationKey } from '@/lib/services/integrationKeyStore'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

// Visibly synthetic values, built at runtime so no key-shaped literal sits in
// the repository.
const posthogKey = (tag: string) => `phc_${tag.repeat(8)}`
const stripeKey = (tag: string) => ['sk', 'test', tag.repeat(6)].join('_')

type Role = 'VIEWER' | 'DEVELOPER' | 'ADMIN'
type TestUser = { id: string; token: string }

const userIds: string[] = []
let orgId = ''
let projectId = ''
let owner!: TestUser
const members = {} as Record<Role, TestUser>

async function makeUser(): Promise<TestUser> {
  const email = `keyfloor-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Key Floor' }, select: { id: true } })
  userIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  return { id: u.id, token }
}

function req(user: TestUser, method: string, path: string, body?: unknown): any {
  currentUserId = user.id
  const url = `http://localhost:3000${path}`
  const headers: Record<string, string> = { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' }
  return {
    method,
    url,
    nextUrl: new URL(url),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => body ?? {},
    clone() { return this },
  }
}

const params = () => ({ params: Promise.resolve({ id: projectId }) })

async function connectFromPage(user: TestUser, values: Record<string, string>) {
  const { POST } = await import('@/app/api/projects/[id]/credentials/route')
  return POST(req(user, 'POST', `/api/projects/${projectId}/credentials`, { integrationId: 'posthog', values }), params())
}

async function storeInVault(user: TestUser, integrationId: string, key: string) {
  const { POST } = await import('@/app/api/projects/[id]/integrations/keys/route')
  return POST(req(user, 'POST', `/api/projects/${projectId}/integrations/keys`, { integrationId, key }))
}

async function removeFromVault(user: TestUser, integrationId: string) {
  const { DELETE } = await import('@/app/api/projects/[id]/integrations/keys/route')
  return DELETE(req(user, 'DELETE', `/api/projects/${projectId}/integrations/keys?integrationId=${integrationId}`))
}

async function turnOn(user: TestUser, integrationId: string) {
  const { POST } = await import('@/app/api/projects/[id]/integrations/route')
  return POST(
    req(user, 'POST', `/api/projects/${projectId}/integrations`, { integrationId, name: integrationId, activatedBy: 'test' }),
    params(),
  )
}

/** A vault row as a connect leaves it, written directly so no route decides. */
async function seedKey(integrationId: string, value: string): Promise<void> {
  await prisma.projectIntegrationKey.deleteMany({ where: { projectId, integrationId } })
  await prisma.projectIntegrationKey.create({
    data: {
      projectId,
      integrationId,
      encryptedKey: encrypt(value),
      maskedKey: `${value.slice(0, 7)}…${value.slice(-4)}`,
      verification: 'unchecked',
    },
  })
}

const activeIntegrations = async () =>
  ((await prisma.project.findUnique({ where: { id: projectId }, select: { activeIntegrations: true } }))
    ?.activeIntegrations ?? {}) as Record<string, any>

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  assertSafeTestDatabase()
  owner = await makeUser()
  for (const role of ['VIEWER', 'DEVELOPER', 'ADMIN'] as Role[]) members[role] = await makeUser()
  orgId = (await prisma.organization.create({
    data: { name: `keyfloor-${randomUUID().slice(0, 8)}`, ownerId: owner.id },
    select: { id: true },
  })).id
  await prisma.organizationMember.create({ data: { orgId, userId: owner.id, role: 'OWNER' } })
  for (const role of ['VIEWER', 'DEVELOPER', 'ADMIN'] as Role[]) {
    await prisma.organizationMember.create({ data: { orgId, userId: members[role].id, role } })
  }
  projectId = (await prisma.project.create({
    data: { name: `keyfloor-${randomUUID().slice(0, 8)}`, userId: owner.id, organizationId: orgId },
    select: { id: true },
  })).id
}, 120_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await prisma.projectIntegrationKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.organizationMember.deleteMany({ where: { orgId } }).catch(() => {})
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {})
}, 120_000)

describe('storing or replacing a key needs DEVELOPER', () => {
  it('a VIEWER is refused on the Integrations page, and nothing is stored', async () => {
    const res: any = await connectFromPage(members.VIEWER, { POSTHOG_API_KEY: posthogKey('viewr') })
    expect(res.status).toBe(403)
    expect(await getIntegrationKey(projectId, 'posthog')).toBeNull()
    expect((await activeIntegrations()).posthog).toBeUndefined()
  }, 60_000)

  it('a VIEWER cannot replace a stored key through the key vault', async () => {
    await seedKey('posthog', posthogKey('owner'))
    const res: any = await storeInVault(members.VIEWER, 'posthog', posthogKey('other'))
    expect(res.status).toBe(403)
    expect(await getIntegrationKey(projectId, 'posthog')).toBe(posthogKey('owner'))
  }, 60_000)

  it('a VIEWER cannot turn an integration on', async () => {
    const res: any = await turnOn(members.VIEWER, 'resend')
    expect(res.status).toBe(403)
    expect((await activeIntegrations()).resend).toBeUndefined()
  }, 60_000)

  it('a DEVELOPER connects from the page, stores through the vault and turns one on', async () => {
    const page: any = await connectFromPage(members.DEVELOPER, { POSTHOG_API_KEY: posthogKey('devlp') })
    expect(page.status).toBe(200)
    expect(await getIntegrationKey(projectId, 'posthog')).toBe(posthogKey('devlp'))

    const vault: any = await storeInVault(members.DEVELOPER, 'posthog', posthogKey('devl2'))
    expect(vault.status).toBe(200)
    expect(await getIntegrationKey(projectId, 'posthog')).toBe(posthogKey('devl2'))

    const on: any = await turnOn(members.DEVELOPER, 'resend')
    expect(on.status).toBe(200)
    expect((await activeIntegrations()).resend?.enabled).toBe(true)
  }, 60_000)
})

describe('removing a key needs ADMIN', () => {
  it('a VIEWER and a DEVELOPER are refused, and the key stays', async () => {
    await seedKey('stripe', stripeKey('keepm'))
    for (const role of ['VIEWER', 'DEVELOPER'] as Role[]) {
      const res: any = await removeFromVault(members[role], 'stripe')
      expect(res.status).toBe(403)
    }
    expect(await getIntegrationKey(projectId, 'stripe')).toBe(stripeKey('keepm'))
  }, 60_000)

  it('an ADMIN removes it', async () => {
    await seedKey('stripe', stripeKey('gonee'))
    const res: any = await removeFromVault(members.ADMIN, 'stripe')
    expect(res.status).toBe(200)
    expect(await getIntegrationKey(projectId, 'stripe')).toBeNull()
  }, 60_000)
})

describe('reading stays open to every member', () => {
  it('a VIEWER lists masked keys, never the key itself', async () => {
    await seedKey('stripe', stripeKey('readm'))
    const { GET } = await import('@/app/api/projects/[id]/integrations/keys/route')
    const res: any = await GET(req(members.VIEWER, 'GET', `/api/projects/${projectId}/integrations/keys`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((k: any) => k.integrationId)).toContain('stripe')
    expect(JSON.stringify(body)).not.toContain(stripeKey('readm'))
  }, 60_000)
})
