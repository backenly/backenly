/**
 * "Is this user's coding agent connected?", against a real database.
 *
 * The console drops every "Connect your agent" step once the answer is yes
 * (lib/hooks/useAgentConnection.ts), so both directions matter. An agent that
 * has connected must read as connected, or the console keeps sending the user
 * back to Connect from every section, which is what a customer whose VS Code
 * agent was already connected reported. And nothing else may read as
 * connected, or a user who still has to connect loses the step that says how.
 *
 * The connection is made through authenticateMcp, the check every MCP request
 * passes first, the remote endpoint's handshake included. The lastUsed stamp it
 * leaves is what the answer is built on, so that is driven for real rather than
 * written by hand wherever the test can reach it.
 *
 * jest.setup.js replaces the global Request, so requests are the minimal
 * surface each handler reads, as in __tests__/auth/project-routes-authorization.
 */

// A teammate holds their role through an organization, which the public
// checkout resolves without the Cloud overlay; the real membership rows decide.
jest.mock('@cloud/project-access', () => {
  try {
    return jest.requireActual('@/lib/cloud/project-access')
  } catch {
    return {
      async organizationRoleForProject(_projectId: string, organizationId: string | null, userId: string) {
        if (!organizationId) return null
        const { prisma: db } = jest.requireActual('@/lib/db')
        const member = await db.organizationMember.findUnique({
          where: { orgId_userId: { orgId: organizationId, userId } },
          select: { role: true },
        })
        return member?.role ?? null
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

import { randomBytes, randomUUID } from 'crypto'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { createSession } from '@/lib/auth/session'
import { authenticateMcp } from '@/lib/mcp/auth'
import { ACTIVE_WITHIN_MS, agentConnectionFor } from '@/lib/mcp/agent-connection'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const userIds: string[] = []
const projectIds: string[] = []
const orgIds: string[] = []

async function makeUser() {
  const email = `agent-conn-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Agent Connection Test' }, select: { id: true } })
  userIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  return { id: u.id, token }
}

async function makeProject(userId: string, organizationId?: string) {
  const p = await prisma.project.create({
    data: { name: `agent-conn-${randomUUID().slice(0, 8)}`, userId, organizationId },
    select: { id: true },
  })
  projectIds.push(p.id)
  return p.id
}

/** An organization the owner owns, with these members. */
async function makeOrg(ownerId: string, members: Array<{ userId: string; role: 'ADMIN' | 'DEVELOPER' | 'VIEWER' }>) {
  const org = await prisma.organization.create({ data: { name: `agent-conn-${randomUUID().slice(0, 8)}`, ownerId }, select: { id: true } })
  orgIds.push(org.id)
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: ownerId, role: 'OWNER' } })
  for (const m of members) await prisma.organizationMember.create({ data: { orgId: org.id, userId: m.userId, role: m.role } })
  return org.id
}

/** An MCP key exactly as app/api/projects/[id]/mcp/keys/route.ts mints it. */
async function mintMcpKey(projectId: string, userId: string, extra: { label?: string; expiresAt?: Date } = {}) {
  const raw = `mcp_live_${randomBytes(32).toString('hex')}`
  const row = await prisma.apiKey.create({
    data: {
      name: 'MCP Key',
      keyHash: hashApiKey(raw),
      keyPrefix: raw.substring(0, 16),
      projectId,
      userId,
      permissions: ['read', 'write', 'admin'],
      capabilities: [],
      rateLimit: 600,
      keyType: 'mcp',
      scope: 'mcp',
      serviceRole: true,
      mcpClientLabel: extra.label ?? null,
      expiresAt: extra.expiresAt ?? null,
    },
    select: { id: true },
  })
  return { raw, id: row.id }
}

/** What an MCP host sends: the key, and nothing else this check reads. */
const mcpRequest = (rawKey: string) =>
  ({ headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? rawKey : null) } }) as unknown as NextRequest

/** The agent connects: one authenticated MCP request, then its stamp landing. */
async function connectAgent(rawKey: string, keyId: string) {
  const auth = await authenticateMcp(mcpRequest(rawKey))
  expect(auth.success).toBe(true)
  // The stamp is fire-and-forget so no MCP request waits on it.
  for (let i = 0; i < 50; i++) {
    const row = await prisma.apiKey.findUnique({ where: { id: keyId }, select: { lastUsed: true } })
    if (row?.lastUsed) return row.lastUsed
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('authenticateMcp never stamped lastUsed')
}

function consoleRequest(opts: { cookie?: string; path: string; method?: string }): any {
  return {
    method: opts.method ?? 'GET',
    url: `http://localhost:3000${opts.path}`,
    nextUrl: { pathname: opts.path, searchParams: new URLSearchParams() },
    headers: { get: () => null },
    cookies: {
      get: (k: string) => (k === 'auth-token' && opts.cookie ? { value: opts.cookie } : undefined),
      getAll: () => (opts.cookie ? [{ name: 'auth-token', value: opts.cookie }] : []),
    },
    json: async () => ({}),
  }
}

const body = (res: any) => JSON.parse(res.body)

const originalEdition = process.env.BACKENLY_EDITION

beforeAll(() => {
  assertSafeTestDatabase()
  // Cross-tenant authorization is a Cloud property: single-tenant treats every
  // account as the operator, so the stranger case would assert nothing there.
  process.env.BACKENLY_EDITION = 'cloud'
})

afterEach(() => resetSingleTenantCache())

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (projectIds.length) {
    await prisma.apiKey.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } })
  }
  if (orgIds.length) {
    await prisma.organizationMember.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {})
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {})
  }
  if (userIds.length) {
    await prisma.apiKey.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
})

describe('agentConnectionFor', () => {
  it('is not connected until an agent presents the key, and connected from its first request', async () => {
    const owner = await makeUser()
    const projectId = await makeProject(owner.id)

    expect(await agentConnectionFor(projectId, owner.id)).toEqual({ connected: false, active: false, lastSeenAt: null, client: null })

    // Minting is the first half of connecting. Nothing is connected yet.
    const key = await mintMcpKey(projectId, owner.id, { label: 'VS Code laptop' })
    expect((await agentConnectionFor(projectId, owner.id)).connected).toBe(false)

    const stamped = await connectAgent(key.raw, key.id)
    const answer = await agentConnectionFor(projectId, owner.id)
    expect(answer).toEqual({ connected: true, active: true, lastSeenAt: stamped, client: 'VS Code laptop' })
  })

  it('is at work only while its last call is recent; idle after that, and still connected', async () => {
    // Production QA (2026-11-09): "Agent connected", green, six days after the
    // last call. A call is the only sign of an agent at work.
    const owner = await makeUser()
    const projectId = await makeProject(owner.id)
    const key = await mintMcpKey(projectId, owner.id, { label: 'VS Code laptop' })
    const stamped = await connectAgent(key.raw, key.id)

    const anHourLater = new Date(stamped.getTime() + ACTIVE_WITHIN_MS)
    expect(await agentConnectionFor(projectId, owner.id, new Date(anHourLater.getTime() - 1))).toMatchObject({ connected: true, active: true })
    expect(await agentConnectionFor(projectId, owner.id, anHourLater)).toMatchObject({ connected: true, active: false })

    const sixDaysLater = new Date(stamped.getTime() + 6 * 24 * 3_600_000)
    expect(await agentConnectionFor(projectId, owner.id, sixDaysLater)).toEqual({
      connected: true,
      active: false,
      lastSeenAt: stamped,
      client: 'VS Code laptop',
    })
  })

  it('belongs to the user: a teammate connecting their agent does not connect this one', async () => {
    const owner = await makeUser()
    const teammate = await makeUser()
    // An ADMIN of the project's organization, as issuing an MCP key takes.
    const projectId = await makeProject(owner.id, await makeOrg(owner.id, [{ userId: teammate.id, role: 'ADMIN' }]))
    const theirs = await mintMcpKey(projectId, teammate.id)
    await connectAgent(theirs.raw, theirs.id)

    expect((await agentConnectionFor(projectId, teammate.id)).connected).toBe(true)
    expect((await agentConnectionFor(projectId, owner.id)).connected).toBe(false)
  })

  it('belongs to the project: a connection to one project does not connect another', async () => {
    const owner = await makeUser()
    const first = await makeProject(owner.id)
    const second = await makeProject(owner.id)
    const key = await mintMcpKey(first, owner.id)
    await connectAgent(key.raw, key.id)

    expect((await agentConnectionFor(first, owner.id)).connected).toBe(true)
    expect((await agentConnectionFor(second, owner.id)).connected).toBe(false)
  })

  it('stops counting a credential once it has expired', async () => {
    const owner = await makeUser()
    const projectId = await makeProject(owner.id)
    const key = await mintMcpKey(projectId, owner.id, { expiresAt: new Date(Date.now() + 60 * 60_000) })
    await connectAgent(key.raw, key.id)
    expect((await agentConnectionFor(projectId, owner.id)).connected).toBe(true)

    await prisma.apiKey.update({ where: { id: key.id }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    expect((await agentConnectionFor(projectId, owner.id)).connected).toBe(false)
  })

  it('does not count a runtime key, however recently it was used', async () => {
    const owner = await makeUser()
    const projectId = await makeProject(owner.id)
    await prisma.apiKey.create({
      data: {
        name: 'web app', keyHash: hashApiKey(`proj_live_${randomBytes(24).toString('hex')}`), keyPrefix: 'proj_live_',
        projectId, userId: owner.id, permissions: ['read'], capabilities: [], keyType: 'public', scope: 'runtime',
        lastUsed: new Date(),
      },
    })
    expect((await agentConnectionFor(projectId, owner.id)).connected).toBe(false)
  })

  it('counts an OAuth connection, and names the client that registered it', async () => {
    const owner = await makeUser()
    const projectId = await makeProject(owner.id)
    // The connection row exactly as app/api/mcp/oauth/authorize/route.ts writes
    // it at consent, with the stamp authenticateBearer leaves on its first call.
    await prisma.apiKey.create({
      data: {
        name: 'Visual Studio Code', keyHash: `oauth:${randomBytes(32).toString('hex')}`, keyPrefix: 'mcp_oauth_',
        projectId, userId: owner.id, permissions: ['read', 'write', 'admin'], capabilities: [], rateLimit: 600,
        keyType: 'mcp_oauth', scope: 'mcp', serviceRole: true, mcpClientLabel: 'Visual Studio Code',
        lastUsed: new Date(),
      },
    })
    const answer = await agentConnectionFor(projectId, owner.id)
    expect(answer.connected).toBe(true)
    expect(answer.client).toBe('Visual Studio Code')
  })
})

describe('GET /api/projects/[id]/mcp/status', () => {
  it('answers the owner, from their own connection, and names no credential', async () => {
    const { GET } = await import('@/app/api/projects/[id]/mcp/status/route')
    const owner = await makeUser()
    const projectId = await makeProject(owner.id)
    const path = `/api/projects/${projectId}/mcp/status`

    const before: any = await GET(consoleRequest({ cookie: owner.token, path }))
    expect(before.status).toBe(200)
    expect(body(before)).toEqual({ connected: false, active: false, lastSeenAt: null, client: null })

    const key = await mintMcpKey(projectId, owner.id, { label: 'Claude Code' })
    const stamped = await connectAgent(key.raw, key.id)

    const after: any = await GET(consoleRequest({ cookie: owner.token, path }))
    expect(after.status).toBe(200)
    expect(body(after)).toEqual({ connected: true, active: true, lastSeenAt: stamped.toISOString(), client: 'Claude Code' })
  })

  it('refuses anyone who cannot open the project', async () => {
    const { GET } = await import('@/app/api/projects/[id]/mcp/status/route')
    const owner = await makeUser()
    const stranger = await makeUser()
    const projectId = await makeProject(owner.id)
    const key = await mintMcpKey(projectId, owner.id)
    await connectAgent(key.raw, key.id)
    const path = `/api/projects/${projectId}/mcp/status`

    const theirs: any = await GET(consoleRequest({ cookie: stranger.token, path }))
    expect(theirs.status).toBe(403)
    expect(body(theirs).connected).toBeUndefined()

    const anonymous: any = await GET(consoleRequest({ path }))
    expect(anonymous.status).not.toBe(200)
    expect(body(anonymous).connected).toBeUndefined()
  })

  it('turns false when the key is revoked from Connect', async () => {
    const { GET } = await import('@/app/api/projects/[id]/mcp/status/route')
    const { DELETE } = await import('@/app/api/projects/[id]/mcp/keys/[keyId]/route')
    const owner = await makeUser()
    const projectId = await makeProject(owner.id)
    const key = await mintMcpKey(projectId, owner.id)
    await connectAgent(key.raw, key.id)
    const path = `/api/projects/${projectId}/mcp/status`
    expect(body(await GET(consoleRequest({ cookie: owner.token, path }))).connected).toBe(true)

    const revoked: any = await DELETE(
      consoleRequest({ cookie: owner.token, path: `/api/projects/${projectId}/mcp/keys/${key.id}`, method: 'DELETE' }),
      { params: Promise.resolve({ id: projectId, keyId: key.id }) },
    )
    expect(revoked.status).toBe(200)
    expect(body(await GET(consoleRequest({ cookie: owner.token, path }))).connected).toBe(false)
  })
})
