/**
 * A SECOND CREDENTIAL STORED ON ITS OWN DOES NOT CONNECT ITS PROVIDER (#611)
 * =========================================================================
 * The integrations page now adds Stripe's webhook signing secret, and
 * OneSignal's App ID, on its own, through POST /api/projects/[id]/credentials.
 * That route switched the provider on (activeIntegrations[id].enabled) for any
 * value it stored, so a signing secret alone would have shown Stripe connected
 * with no secret key behind it. A provider is switched on by its own key; a
 * second credential stored alone leaves the switch as it was.
 *
 * Real sessions, routes and database. Nothing here reaches a provider: the
 * signing secret, the App ID and the PostHog key are stored unverifiable, and
 * Stripe's secret key is seeded as a row.
 */
import crypto, { randomUUID } from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { encrypt } from '@/lib/services/encryption'
import { getIntegrationKey } from '@/lib/services/integrationKeyStore'

// The scratch database holds many projects, so the suite runs the cloud
// resolver, as the other route-level credential suites do.
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

let ownerId: string
let token: string
const projectIds: string[] = []

// Visibly synthetic values, built at runtime so no key-shaped literal sits in
// the repository.
const signingSecret = () => ['whsec', 'i611'.repeat(8)].join('_')
const stripeKey = () => ['sk', 'test', 'i611'.repeat(6)].join('_')
const posthogKey = () => `phc_${'i611'.repeat(10)}`

async function freshProject(name: string): Promise<string> {
  const id = (await prisma.project.create({ data: { name, userId: ownerId }, select: { id: true } })).id
  projectIds.push(id)
  return id
}

/** A stored key, written as a row so no provider is asked about it. */
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
  const rows = await prisma.projectIntegrationKey.findMany({ where: { projectId }, select: { integrationId: true } })
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

async function store(projectId: string, integrationId: string, values: Record<string, string>) {
  const { POST } = await import('@/app/api/projects/[id]/credentials/route')
  return POST(request('POST', `/api/projects/${projectId}/credentials`, { integrationId, values }), routeParams(projectId))
}

/** What the integrations page loads: the switches, and the stored credentials' statuses. */
async function consoleView(projectId: string): Promise<{ integrations: Record<string, any>; keyVault: Record<string, any> }> {
  const { GET } = await import('@/app/api/projects/[id]/integrations/route')
  const res = await GET(request('GET', `/api/projects/${projectId}/integrations`), routeParams(projectId))
  expect(res.status).toBe(200)
  return res.json()
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  const email = `i611-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, name: 'Second Credential Suite' }, select: { id: true } })).id
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

describe("Stripe's signing secret, stored on its own", () => {
  it('is stored, and does not connect Stripe when no secret key is stored', async () => {
    const projectId = await freshProject('i611-secret-alone')

    const res = await store(projectId, 'stripe', { STRIPE_WEBHOOK_SECRET: signingSecret() })
    expect(res.status).toBe(200)
    expect((await res.json()).stored).toEqual(['STRIPE_WEBHOOK_SECRET'])
    expect(await vaultIds(projectId)).toEqual(['stripe_webhook_secret'])
    expect(await getIntegrationKey(projectId, 'stripe_webhook_secret')).toBe(signingSecret())

    const seen = await consoleView(projectId)
    expect(seen.integrations.stripe).toBeUndefined()
    expect(seen.keyVault.stripe).toBeUndefined()
    expect(seen.keyVault.stripe_webhook_secret.verification).toBe('unverifiable')
  }, 60_000)

  it("is stored beside a connected Stripe's secret key, leaving Stripe connected as it was", async () => {
    const projectId = await freshProject('i611-secret-beside-key')
    await seedRow(projectId, 'stripe', stripeKey())
    const connected = { enabled: true, activatedAt: '2026-11-01T00:00:00.000Z', activatedBy: 'credential_modal', stored: ['STRIPE_SECRET_KEY'] }
    await prisma.project.update({ where: { id: projectId }, data: { activeIntegrations: { stripe: connected } } })

    const res = await store(projectId, 'stripe', { STRIPE_WEBHOOK_SECRET: signingSecret() })
    expect(res.status).toBe(200)
    expect(await vaultIds(projectId)).toEqual(['stripe', 'stripe_webhook_secret'])
    expect(await getIntegrationKey(projectId, 'stripe')).toBe(stripeKey())

    // Both are what the page loads: Stripe on, and both credentials stored.
    const seen = await consoleView(projectId)
    expect(seen.integrations.stripe).toEqual(connected)
    expect(Object.keys(seen.keyVault).sort()).toEqual(['stripe', 'stripe_webhook_secret'])
  }, 60_000)

  it('is refused when it is not a signing secret, with the reason the page shows, and nothing is stored', async () => {
    const projectId = await freshProject('i611-secret-refused')

    const res = await store(projectId, 'stripe', { STRIPE_WEBHOOK_SECRET: `not-a-signing-secret-${randomUUID()}` })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/^Stripe webhook signing secrets must start with whsec_/)
    expect(await vaultIds(projectId)).toEqual([])
    expect((await consoleView(projectId)).integrations.stripe).toBeUndefined()
  }, 60_000)
})

describe('the same for OneSignal, and a provider’s own key unchanged', () => {
  it("stores OneSignal's App ID on its own without connecting OneSignal", async () => {
    const projectId = await freshProject('i611-app-id-alone')
    const appId = randomUUID()

    const res = await store(projectId, 'onesignal', { ONESIGNAL_APP_ID: appId })
    expect(res.status).toBe(200)
    expect(await vaultIds(projectId)).toEqual(['onesignal_app_id'])
    expect(await getIntegrationKey(projectId, 'onesignal_app_id')).toBe(appId)
    expect((await consoleView(projectId)).integrations.onesignal).toBeUndefined()
  }, 60_000)

  it('still connects a provider by its own key', async () => {
    const projectId = await freshProject('i611-own-key')

    const res = await store(projectId, 'posthog', { POSTHOG_API_KEY: posthogKey() })
    expect(res.status).toBe(200)
    const seen = await consoleView(projectId)
    expect(seen.integrations.posthog).toMatchObject({ enabled: true, activatedBy: 'credential_modal', stored: ['POSTHOG_API_KEY'] })
    expect(Object.keys(seen.keyVault)).toEqual(['posthog'])
  }, 60_000)
})
