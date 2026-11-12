/**
 * AN INTEGRATION KEY IS CHECKED WHEN IT IS ENTERED, NOT AFTER THE NEXT STEP
 * ========================================================================
 *
 * Production QA (2026-11-09), Integrations → Stripe: step 1 accepted any text,
 * and Stripe's refusal came back only after the next step (what to build) was
 * filled in, worded "your stripe dashboard". POST
 * /api/projects/[id]/credentials/verify runs the checks storing runs
 * (checkIntegrationKey) and stores nothing; the panel asks it on Continue.
 *
 * Real sessions, roles and database. Stripe's API is the one stand-in: the
 * suite must not call it, so its answer is stubbed at fetch.
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
          select: { role: true },
        })
        return member?.role ?? null
      },
      async organizationProjectClauses(userId: string) {
        return [{ organization: { members: { some: { userId, restricted: false } } } }, { projectMembers: { some: { userId } } }]
      },
    }
  }
})

import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { POST as verify } from '@/app/api/projects/[id]/credentials/verify/route'
import { POST as store } from '@/app/api/projects/[id]/credentials/route'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
// Made-up keys, built from parts: a literal shaped like a live Stripe key is
// (rightly) refused by the repository's secret scanning.
const stripeKey = (body: string) => ['sk', 'live', body].join('_')
const REFUSED = stripeKey('51Hx9ZqLmNoPqRsTuVwXyZaBcDe')
const ACCEPTED = stripeKey('51Kz7YtRqPoNmLkJiHgFeDcBaZy')

const userIds: string[] = []
let orgId = ''
let projectId = ''
let owner = { id: '', token: '' }
let viewer = { id: '', token: '' }
let stripeCalls: string[] = []
let realFetch: typeof fetch

async function makeUser() {
  const email = `keycheck-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Key Check' }, select: { id: true } })
  userIds.push(u.id)
  const { token } = await createSession(u.id, email)
  return { id: u.id, token }
}

function req(token: string, path: string, body: unknown): any {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  return {
    method: 'POST',
    url: `http://localhost:3000${path}`,
    nextUrl: { pathname: path, searchParams: new URLSearchParams() },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => body,
  }
}

const params = () => ({ params: Promise.resolve({ id: projectId }) })
const ask = async (token: string, values: Record<string, string>) => {
  const res: any = await verify(req(token, `/api/projects/${projectId}/credentials/verify`, { integrationId: 'stripe', values }), params())
  return { status: res.status, body: await res.json() }
}
const storedKeys = () => prisma.projectIntegrationKey.count({ where: { projectId } })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  owner = await makeUser()
  viewer = await makeUser()
  orgId = (await prisma.organization.create({ data: { name: `keycheck-${randomUUID().slice(0, 8)}`, ownerId: owner.id }, select: { id: true } })).id
  await prisma.organizationMember.create({ data: { orgId, userId: owner.id, role: 'OWNER' } })
  await prisma.organizationMember.create({ data: { orgId, userId: viewer.id, role: 'VIEWER' } })
  projectId = (await prisma.project.create({
    data: { name: `keycheck-${randomUUID().slice(0, 8)}`, userId: owner.id, organizationId: orgId },
    select: { id: true },
  })).id

  realFetch = global.fetch
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('https://api.stripe.com/')) return realFetch(input, init)
    // The probe passes a plain object (lib/integrations/key-verification.ts).
    const sent = (init?.headers ?? {}) as Record<string, string>
    const auth = sent.Authorization ?? sent.authorization ?? ''
    stripeCalls.push(url)
    return new Response('{}', { status: auth === `Bearer ${REFUSED}` ? 401 : 200 })
  }) as typeof fetch
}, 120_000)

beforeEach(() => {
  stripeCalls = []
})

afterAll(async () => {
  global.fetch = realFetch
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await prisma.projectIntegrationKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.organizationMember.deleteMany({ where: { orgId } }).catch(() => {})
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {})
}, 60_000)

it('says a key Stripe refuses, and stores nothing', async () => {
  const r = await ask(owner.token, { STRIPE_SECRET_KEY: REFUSED })
  expect(r.status).toBe(422)
  expect(r.body).toMatchObject({ ok: false, envVar: 'STRIPE_SECRET_KEY' })
  expect(r.body.error).toMatch(/^Stripe rejected this key \(HTTP 401\)/)
  expect(stripeCalls).toHaveLength(1)
  expect(await storedKeys()).toBe(0)
})

it("says a key Stripe accepts, with Stripe's answer, and stores nothing", async () => {
  const r = await ask(owner.token, { STRIPE_SECRET_KEY: ACCEPTED })
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ ok: true, checks: [{ envVar: 'STRIPE_SECRET_KEY', status: 'verified', detail: 'Stripe accepted this key.' }] })
  expect(await storedKeys()).toBe(0)
})

it('refuses a placeholder before asking Stripe, naming Stripe as Stripe', async () => {
  const r = await ask(owner.token, { STRIPE_SECRET_KEY: stripeKey('PLACEHOLDER_KEY_123456') })
  expect(r.status).toBe(422)
  expect(r.body.error).toContain('Paste the actual key from your Stripe dashboard.')
  expect(stripeCalls).toHaveLength(0)
})

it('says which field is wrong when the webhook signing secret is malformed', async () => {
  const r = await ask(owner.token, { STRIPE_SECRET_KEY: ACCEPTED, STRIPE_WEBHOOK_SECRET: 'not-a-signing-secret' })
  expect(r.status).toBe(422)
  expect(r.body).toMatchObject({ ok: false, envVar: 'STRIPE_WEBHOOK_SECRET' })
  expect(r.body.error).toMatch(/must start with whsec_/)
})

it('lets only someone who may connect it ask: a VIEWER is refused before Stripe is called', async () => {
  const r = await ask(viewer.token, { STRIPE_SECRET_KEY: ACCEPTED })
  expect(r.status).toBe(403)
  expect(stripeCalls).toHaveLength(0)
})

it('gives the answer storing gives: the same refusal, the same words', async () => {
  const checked = await ask(owner.token, { STRIPE_SECRET_KEY: REFUSED })
  const res: any = await store(
    req(owner.token, `/api/projects/${projectId}/credentials`, { integrationId: 'stripe', values: { STRIPE_SECRET_KEY: REFUSED } }),
    params(),
  )
  expect(res.status).toBeGreaterThanOrEqual(400)
  expect((await res.json()).error).toBe(checked.body.error)
  expect(await storedKeys()).toBe(0)
})
