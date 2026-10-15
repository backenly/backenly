/**
 * One credential is one vault row (medium finding INT-08).
 *
 * The console's credentials route stored every key twice: under the canonical
 * id, and again under the lowercased env-var name (`resend_api_key`,
 * `openai_api_key`, `stripe_secret_key`, …). The agent's integration list
 * showed the second row as an integration of its own, and the key store read
 * `stripe_secret_key` as Stripe's key, so a console DELETE of `stripe`, which
 * removes the exact id only, left the runtime connected.
 *
 * The route now writes one row. A lookup by env-var name resolves to that row
 * inside the key store, so build-status still recognises a stored key. Legacy
 * alias rows already in a vault are never read as a credential, never listed,
 * and deleted on disconnect.
 *
 * PostHog carries the route test because its key is stored unverifiable (no
 * provider call); the Stripe, Resend and Google rows are seeded directly, so
 * CI never calls a provider.
 */
import crypto, { randomUUID } from 'crypto'

/**
 * Identity for the withProjectAccess route (the console DELETE).
 * `requireUser` reads next/headers, which jest cannot drive, so
 * requireProjectAccess is reimplemented as operate-role-floors.test.ts does:
 * the real verifyProjectAccess decides, only the identity is the test's.
 */
let mockOwnerId = ''

jest.mock('@/lib/auth/server', () => {
  const actual = jest.requireActual('@/lib/auth/server')
  return {
    ...actual,
    requireProjectAccess: jest.fn(async (request: Request) => {
      const { verifyProjectAccess } = jest.requireActual('@/lib/auth/project-access')
      const projectId = new URL(request.url).pathname.match(/\/projects\/([a-zA-Z0-9-_]+)/)?.[1] ?? null
      if (!projectId) throw new actual.ForbiddenError('Missing projectId - project context required')
      const project = await verifyProjectAccess(projectId, mockOwnerId)
      return { user: { userId: mockOwnerId, email: `${mockOwnerId}@test.invalid` }, project, projectId }
    }),
  }
})

import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { encrypt } from '@/lib/services/encryption'
import {
  getIntegrationKey,
  hasIntegrationKey,
  listKeyVaultStatuses,
  storeIntegrationKey,
} from '@/lib/services/integrationKeyStore'
import { integrationCapabilities } from '@/lib/integrations/agent-actions'
import { executeAction } from '@/lib/ai/minimal-executor'
import { updateBuildLedger } from '@/lib/ai/build-ledger'

// The scratch database holds many projects, so the suite runs the cloud
// resolver, as the other route-level credential suites do.
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

let ownerId: string
let token: string
const projectIds: string[] = []

// Visibly synthetic values, built at runtime so no key-shaped literal sits in
// the repository.
const posthogKey = () => `phc_${'int08'.repeat(8)}`
const stripeKey = () => ['sk', 'test', 'int08'.repeat(6)].join('_')
const resendKey = () => `re_${'int08'.repeat(6)}`

async function freshProject(name: string): Promise<string> {
  const id = (
    await prisma.project.create({ data: { name, userId: ownerId }, select: { id: true } })
  ).id
  projectIds.push(id)
  return id
}

/** A vault row exactly as the old double write left it. */
async function seedRow(projectId: string, integrationId: string, value: string): Promise<void> {
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

async function vaultIds(projectId: string): Promise<string[]> {
  const rows = await prisma.projectIntegrationKey.findMany({
    where: { projectId },
    select: { integrationId: true },
  })
  return rows.map((r) => r.integrationId).sort()
}

function request(method: string, path: string, body?: unknown): any {
  const url = `http://localhost:3000${path}`
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  return {
    method,
    url,
    nextUrl: new URL(url),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: (k: string) => (k === 'auth-token' ? { value: token } : undefined) },
    json: async () => body ?? {},
  }
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  const email = `int08-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (
    await prisma.user.create({ data: { email, name: 'One Row Suite' }, select: { id: true } })
  ).id
  mockOwnerId = ownerId
  token = (await createSession(ownerId, email, 'user')).token
}, 120_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await prisma.projectIntegrationKey.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.aiConfiguration.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe('INT-08: a connect writes one row', () => {
  it('a console connect stores exactly one vault row, under the canonical id', async () => {
    const projectId = await freshProject('int08-console-connect')
    const { POST } = await import('@/app/api/projects/[id]/credentials/route')
    const res = await POST(
      request('POST', `/api/projects/${projectId}/credentials`, {
        integrationId: 'posthog',
        values: { POSTHOG_API_KEY: posthogKey() },
      }),
      routeParams(projectId),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(await vaultIds(projectId)).toEqual(['posthog'])
    expect(await getIntegrationKey(projectId, 'posthog')).toBe(posthogKey())
  }, 60_000)

  it('a key offered under its env-var name lands under the canonical id', async () => {
    const projectId = await freshProject('int08-env-var-store')
    const status = await storeIntegrationKey(projectId, 'POSTHOG_API_KEY', posthogKey())
    expect(status.integrationId).toBe('posthog')
    expect(await vaultIds(projectId)).toEqual(['posthog'])
  }, 60_000)
})

describe('INT-08: a lookup by env-var name finds the one row', () => {
  it('hasIntegrationKey and getIntegrationKey resolve env-var names to the stored id', async () => {
    const projectId = await freshProject('int08-env-var-lookup')
    await seedRow(projectId, 'resend', resendKey())
    expect(await hasIntegrationKey(projectId, 'resend_api_key')).toBe(true)
    expect(await hasIntegrationKey(projectId, 'RESEND_API_KEY')).toBe(true)
    expect(await getIntegrationKey(projectId, 'resend_api_key')).toBe(resendKey())
    expect(await hasIntegrationKey(projectId, 'openai_api_key')).toBe(false)
  }, 60_000)

  it('build-status still clears a block once the key is stored, and lists the integration once', async () => {
    const projectId = await freshProject('int08-build-status')
    // The OAuth connect stores Google under `google`. The build runtime blocks
    // on the env-var name, which the route checks as-is.
    await seedRow(projectId, 'google', `int08-client-secret-${randomUUID()}`)
    await updateBuildLedger(projectId, [
      { op: 'blocked', item: { type: 'integration', name: 'google-sign-in', blockedBy: 'GOOGLE_CLIENT_ID' } },
    ])
    const { GET } = await import('@/app/api/projects/[id]/build-status/route')
    const res = await GET(request('GET', `/api/projects/${projectId}/build-status`), routeParams(projectId))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.blocked).toEqual([])
    expect(body.configured.integrations).toEqual(['google'])
  }, 60_000)
})

describe('INT-08: legacy alias rows are not a second credential', () => {
  it('a canonical row and its legacy alias list as ONE integration on every surface', async () => {
    const projectId = await freshProject('int08-legacy-list')
    await seedRow(projectId, 'resend', resendKey())
    await seedRow(projectId, 'resend_api_key', resendKey())

    expect((await listKeyVaultStatuses(projectId)).map((s) => s.integrationId)).toEqual(['resend'])

    const listed = await executeAction(
      { action: 'LIST_INTEGRATION_KEYS', params: {} } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(listed.success).toBe(true)
    expect(listed.message).toContain('resend')
    expect(listed.message).not.toContain('resend_api_key')

    const { GET } = await import('@/app/api/projects/[id]/build-status/route')
    const res = await GET(request('GET', `/api/projects/${projectId}/build-status`), routeParams(projectId))
    expect((await res.json()).configured.integrations).toEqual(['resend'])
  }, 60_000)

  it('an orphaned alias is never read as the credential', async () => {
    // What a console DELETE of `stripe` used to leave behind.
    const projectId = await freshProject('int08-orphan-alias')
    await seedRow(projectId, 'stripe_secret_key', stripeKey())
    expect(await getIntegrationKey(projectId, 'stripe')).toBeNull()
    expect(await hasIntegrationKey(projectId, 'stripe')).toBe(false)
    const caps = await integrationCapabilities(projectId, { integrationId: 'stripe' })
    expect((caps.data as any).providers[0].connected).toBe(false)
  }, 60_000)
})

describe('INT-08: disconnect removes the credential everywhere', () => {
  it('a console DELETE of stripe removes its legacy alias, and the runtime lookup returns null', async () => {
    const projectId = await freshProject('int08-console-delete')
    await seedRow(projectId, 'stripe', stripeKey())
    await seedRow(projectId, 'stripe_secret_key', stripeKey())
    // Older writers filed ids verbatim; disconnect clears that casing too.
    await seedRow(projectId, 'STRIPE_SECRET_KEY', stripeKey())
    expect(await getIntegrationKey(projectId, 'stripe')).toBe(stripeKey())

    const { DELETE } = await import('@/app/api/projects/[id]/integrations/keys/route')
    const res = await DELETE(
      request('DELETE', `/api/projects/${projectId}/integrations/keys?integrationId=stripe`) as any,
    )
    expect(res.status).toBe(200)

    expect(await vaultIds(projectId)).toEqual([])
    expect(await getIntegrationKey(projectId, 'stripe')).toBeNull()
    const caps = await integrationCapabilities(projectId, { integrationId: 'stripe' })
    expect((caps.data as any).providers[0].connected).toBe(false)
  }, 60_000)

  it('the agent remove clears a legacy alias as well (control)', async () => {
    const projectId = await freshProject('int08-agent-remove')
    await seedRow(projectId, 'resend', resendKey())
    await seedRow(projectId, 'resend_api_key', resendKey())
    const out = await executeAction(
      { action: 'REMOVE_INTEGRATION_KEY', params: { integrationId: 'resend', confirmed: true } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(out.success).toBe(true)
    expect(await vaultIds(projectId)).toEqual([])
  }, 60_000)
})
