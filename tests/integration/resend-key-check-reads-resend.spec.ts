/**
 * CONNECTING RESEND READS WHAT RESEND SAYS ABOUT THE KEY (#608)
 * ============================================================
 *
 * Connecting Resend asks GET https://api.resend.com/domains about the key, and
 * the answer used to be read by its status alone: 401 or 403 refused the key,
 * and anything else but 429 and 5xx confirmed it. Resend's error reference
 * gives two of that endpoint's answers the opposite meanings:
 *
 *   - a key with Sending access, Resend's least-privilege option, gets 401
 *     restricted_api_key. It is real and can send, and it was refused;
 *   - a key that does not exist or was deleted gets 400 validation_error,
 *     "API key is invalid". It was stored and shown as confirmed, and a
 *     re-check could never catch a key deleted later.
 *
 * Every door that checks a key is driven here: the console's Continue (POST
 * ../credentials/verify) and Save (POST ../credentials), the agent's connect
 * (store_integration_key) and re-check (integrations verify), and the live
 * check of GET /api/integrations/health. Real sessions, roles and database.
 * Resend is the one stand-in, answering with the bodies its error reference
 * documents, stubbed at fetch: the suite never calls Resend.
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
import { GET as health } from '@/app/api/integrations/health/route'
import { executeAction } from '@/lib/ai/minimal-executor'
import { verifyIntegration } from '@/lib/integrations/agent-actions'
import { storeIntegrationKey } from '@/lib/services/integrationKeyStore'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

// Made-up keys, built at runtime: a literal shaped like a Resend key is
// (rightly) refused by the repository's secret scanning.
const SENDING_ACCESS = `re_${'send608'.repeat(4)}`
const FULL_ACCESS = `re_${'full608'.repeat(4)}`
const DELETED = `re_${'gone608'.repeat(4)}`

// Resend's answers to GET /domains, as https://resend.com/docs/api-reference/errors gives them.
type ResendAnswer = { status: number; body: unknown }
const RESTRICTED: ResendAnswer = {
  status: 401,
  body: { statusCode: 401, message: 'This API key is restricted to only send emails', name: 'restricted_api_key' },
}
const INVALID: ResendAnswer = { status: 400, body: { statusCode: 400, message: 'API key is invalid', name: 'validation_error' } }
const DOMAINS: ResendAnswer = { status: 200, body: { object: 'list', has_more: false, data: [] } }

/** What Resend says about each key; a test can delete a key in Resend by changing it. */
let resendSays = new Map<string, ResendAnswer>()
let resendCalls: string[] = []
let realFetch: typeof fetch

const SENDING_ACCESS_DETAIL =
  'Resend accepted this key. It has Sending access, which is what sending email needs; ' +
  "Resend's other endpoints, called with ctx.integrations.resend.request(), need a key with Full access."
const DELETED_DETAIL =
  'Resend says this API key is invalid (HTTP 400): no such key exists, or it was deleted. ' +
  'Create a key at resend.com/api-keys and use that one.'

const userIds: string[] = []
const projectIds: string[] = []
let orgId = ''
let owner = { id: '', token: '' }

async function makeUser() {
  const email = `resend-key-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Resend Key Check' }, select: { id: true } })
  userIds.push(u.id)
  const { token } = await createSession(u.id, email)
  return { id: u.id, token }
}

async function freshProject(): Promise<string> {
  const { id } = await prisma.project.create({
    data: { name: `resend-key-${randomUUID().slice(0, 8)}`, userId: owner.id, organizationId: orgId },
    select: { id: true },
  })
  projectIds.push(id)
  return id
}

function req(method: 'GET' | 'POST', path: string, body?: unknown): any {
  const headers: Record<string, string> = { authorization: `Bearer ${owner.token}` }
  const url = `http://localhost:3000${path}`
  return {
    method,
    url,
    nextUrl: new URL(url),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => body,
  }
}

const params = (projectId: string) => ({ params: Promise.resolve({ id: projectId }) })

const askOnContinue = async (projectId: string, key: string) => {
  const res: any = await verify(
    req('POST', `/api/projects/${projectId}/credentials/verify`, { integrationId: 'resend', values: { RESEND_API_KEY: key } }),
    params(projectId),
  )
  return { status: res.status, body: await res.json() }
}

const saveInConsole = async (projectId: string, key: string) => {
  const res: any = await store(
    req('POST', `/api/projects/${projectId}/credentials`, { integrationId: 'resend', values: { RESEND_API_KEY: key } }),
    params(projectId),
  )
  return { status: res.status, body: await res.json() }
}

const connectFromAgent = (projectId: string, key: string) =>
  executeAction({ action: 'STORE_INTEGRATION_KEY', params: { integrationId: 'resend', apiKey: key } } as any, projectId, undefined, 0, undefined, false)

const liveHealth = async (projectId: string) => {
  const res: any = await health(req('GET', `/api/integrations/health?projectId=${projectId}&check=1`))
  const body = await res.json()
  return { status: res.status, resend: (body.integrations ?? []).find((i: any) => i.integrationId === 'resend') }
}

const vaultRow = (projectId: string) =>
  prisma.projectIntegrationKey.findUnique({
    where: { projectId_integrationId: { projectId, integrationId: 'resend' } },
    select: { verification: true, verificationDetail: true, verifiedAt: true },
  })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  owner = await makeUser()
  orgId = (await prisma.organization.create({ data: { name: `resend-key-${randomUUID().slice(0, 8)}`, ownerId: owner.id }, select: { id: true } })).id
  await prisma.organizationMember.create({ data: { orgId, userId: owner.id, role: 'OWNER' } })

  realFetch = global.fetch
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('https://api.resend.com/')) return realFetch(input, init)
    resendCalls.push(url)
    // Both probes pass a plain object of headers.
    const sent = (init?.headers ?? {}) as Record<string, string>
    const key = (sent.Authorization ?? sent.authorization ?? '').replace(/^Bearer /, '')
    const answer = resendSays.get(key) ?? { status: 500, body: { statusCode: 500, message: 'unexpected key in test', name: 'application_error' } }
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}, 120_000)

beforeEach(() => {
  resendSays = new Map([
    [SENDING_ACCESS, RESTRICTED],
    [FULL_ACCESS, DOMAINS],
    [DELETED, INVALID],
  ])
  resendCalls = []
})

afterAll(async () => {
  global.fetch = realFetch
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await prisma.projectIntegrationKey.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {})
  await prisma.organizationMember.deleteMany({ where: { orgId } }).catch(() => {})
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {})
}, 60_000)

describe("the console's Continue and Save", () => {
  it('Continue says a Sending-access key is accepted, in words that say what it can do, and stores nothing', async () => {
    const projectId = await freshProject()
    const r = await askOnContinue(projectId, SENDING_ACCESS)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, checks: [{ envVar: 'RESEND_API_KEY', status: 'verified', detail: SENDING_ACCESS_DETAIL }] })
    expect(resendCalls).toEqual(['https://api.resend.com/domains'])
    expect(await vaultRow(projectId)).toBeNull()
  })

  it('Continue refuses a deleted key with what Resend said, and stores nothing', async () => {
    const projectId = await freshProject()
    const r = await askOnContinue(projectId, DELETED)
    expect(r.status).toBe(422)
    expect(r.body).toEqual({ ok: false, envVar: 'RESEND_API_KEY', error: DELETED_DETAIL })
    expect(await vaultRow(projectId)).toBeNull()
  })

  it('Save stores a Sending-access key as confirmed by Resend', async () => {
    const projectId = await freshProject()
    const r = await saveInConsole(projectId, SENDING_ACCESS)
    expect(r.status).toBe(200)
    const row = await vaultRow(projectId)
    expect(row).toMatchObject({ verification: 'verified', verificationDetail: SENDING_ACCESS_DETAIL })
    expect(row?.verifiedAt).toBeInstanceOf(Date)
  })

  it('Save refuses a deleted key, so it is never shown as confirmed', async () => {
    const projectId = await freshProject()
    const r = await saveInConsole(projectId, DELETED)
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.body.error).toBe(DELETED_DETAIL)
    expect(await vaultRow(projectId)).toBeNull()
  })
})

describe("the agent's connect and re-check", () => {
  it('connect stores a Sending-access key as verified', async () => {
    const projectId = await freshProject()
    const out = await connectFromAgent(projectId, SENDING_ACCESS)
    expect(out.success).toBe(true)
    expect((out.data as any).verification).toBe('verified')
    expect((await vaultRow(projectId))?.verification).toBe('verified')
  }, 60_000)

  it('connect refuses a deleted key, saying why', async () => {
    const projectId = await freshProject()
    const out = await connectFromAgent(projectId, DELETED)
    expect(out.success).toBe(false)
    expect(out.error).toBe('INTEGRATION_KEY_REJECTED')
    expect(out.message).toContain(DELETED_DETAIL)
    expect(await vaultRow(projectId)).toBeNull()
  }, 60_000)

  it('verify catches a key deleted in Resend after it was connected', async () => {
    const projectId = await freshProject()
    expect((await connectFromAgent(projectId, FULL_ACCESS)).success).toBe(true)
    expect((await vaultRow(projectId))?.verification).toBe('verified')

    resendSays.set(FULL_ACCESS, INVALID) // deleted on resend.com/api-keys
    const out = await verifyIntegration(projectId, { integrationId: 'resend' })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('KEY_REJECTED')
    expect(out.summary).toContain(DELETED_DETAIL)
    const row = await vaultRow(projectId)
    expect(row).toMatchObject({ verification: 'rejected', verificationDetail: DELETED_DETAIL, verifiedAt: null })
  }, 60_000)
})

describe('the live health check', () => {
  it('reads Resend the same way: a Sending-access key is ok, and the same key once deleted is invalid', async () => {
    const projectId = await freshProject()
    // Filed without a check (the re-file path), so only the health check reads Resend here.
    await storeIntegrationKey(projectId, 'resend', SENDING_ACCESS, { skipVerification: true })
    expect(resendCalls).toEqual([])

    const before = await liveHealth(projectId)
    expect(before.status).toBe(200)
    expect(before.resend).toMatchObject({ status: 'ok', note: `HTTP 401 — ${SENDING_ACCESS_DETAIL}` })

    resendSays.set(SENDING_ACCESS, INVALID)
    const after = await liveHealth(projectId)
    expect(after.resend).toMatchObject({ status: 'invalid_key', note: `HTTP 400 — ${DELETED_DETAIL}` })
  })
})
