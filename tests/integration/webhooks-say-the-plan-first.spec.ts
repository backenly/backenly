/**
 * ON A PLAN WITHOUT WEBHOOKS, THE PAGE IS TOLD BEFORE ANYONE FILLS IN A FORM
 * ==========================================================================
 *
 * Production QA (2026-11-09), Webhooks on Free: the list route answered 403,
 * which the page showed as an error, and "Add endpoint" still opened the full
 * form, whose save was then refused. Reading now never needs the plan: the
 * list answers with the plan's answer in it, and a project that moved to a
 * plan without webhooks can still read the endpoints it has. A change is
 * refused exactly as before.
 */
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', allowWebhooks: false }) }
})

// The sign-in wrapper is delegated (its decision is pinned elsewhere); the
// project check, the plan and the database behind it are real.
let currentUserId = ''
jest.mock('@/lib/auth/route-protection', () => {
  const actual = jest.requireActual('@/lib/auth/route-protection')
  return {
    ...actual,
    withAuth: (handler: any) => async (request: any, ctx: any = {}) =>
      handler(request, { user: { userId: currentUserId }, params: ctx.params }),
  }
})

import '../helpers/real-web-standard'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { GET, POST } from '@/app/api/projects/[id]/webhooks/route'
import * as one from '@/app/api/projects/[id]/webhooks/[webhookId]/route'
import * as logsRoute from '@/app/api/projects/[id]/webhooks/[webhookId]/logs/route'

let ownerId: string
let ownerEmail: string
let projectId: string
const originalEdition = process.env.BACKENLY_EDITION

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  ownerEmail = `wh-plan-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, password: 'not-a-real-hash', name: 'owner' } })).id
  currentUserId = ownerId
  projectId = (await prisma.project.create({ data: { name: 'webhooks-on-free', userId: ownerId } })).id
}, 60_000)

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  await prisma.webhook.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

const call = async (
  handler: (req: any, ctx: any) => Promise<Response>,
  init: { method?: string; body?: unknown; path?: string; webhookId?: string } = {},
) => {
  const res = await handler(
    new NextRequest(`http://localhost:3000/api/projects/${projectId}/webhooks${init.path ?? ''}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    }),
    { params: Promise.resolve({ id: projectId, ...(init.webhookId ? { webhookId: init.webhookId } : {}) }) } as any,
  )
  return { status: res.status, body: await res.json() }
}

it('answers the list with the plan, not a refusal', async () => {
  const r = await call(GET)
  expect(r.status).toBe(200)
  expect(r.body).toMatchObject({ webhooks: [], plan: { allowed: false, currentPlan: 'SANDBOX', requiredPlan: 'PRO' } })
})

it('still refuses to add an endpoint on that plan', async () => {
  const r = await call(POST, { method: 'POST', body: { eventType: 'row.inserted', targetUrl: 'https://hooks.example.test/in' } })
  expect(r.status).toBe(403)
  expect(r.body).toMatchObject({ code: 'PLAN_LIMIT_EXCEEDED', requiredPlan: 'PRO' })
  expect(await prisma.webhook.count({ where: { projectId } })).toBe(0)
})

describe('an endpoint made before the project moved to a plan without webhooks', () => {
  let webhookId: string
  beforeAll(async () => {
    webhookId = (
      await prisma.webhook.create({
        data: { projectId, eventType: 'row.inserted', targetUrl: 'https://hooks.example.test/made-on-pro', secret: 'whsec_test' },
      })
    ).id
  })
  afterAll(async () => {
    await prisma.webhook.deleteMany({ where: { id: webhookId } }).catch(() => {})
  })

  it('is listed, and it and its deliveries can be read', async () => {
    const list = await call(GET)
    expect(list.status).toBe(200)
    expect(list.body.webhooks.map((w: { id: string }) => w.id)).toEqual([webhookId])
    expect((await call(one.GET, { path: `/${webhookId}`, webhookId })).status).toBe(200)
    const logs = await call(logsRoute.GET, { path: `/${webhookId}/logs`, webhookId })
    expect(logs.status).toBe(200)
    expect(logs.body.logs).toEqual([])
  })

  it('still cannot be changed on that plan', async () => {
    const edit = await call(one.PATCH, { method: 'PATCH', path: `/${webhookId}`, webhookId, body: { targetUrl: 'https://hooks.example.test/elsewhere' } })
    expect(edit.status).toBe(403)
    expect(edit.body).toMatchObject({ code: 'PLAN_LIMIT_EXCEEDED' })
    expect((await prisma.webhook.findUnique({ where: { id: webhookId } }))?.targetUrl).toBe('https://hooks.example.test/made-on-pro')
  })
})
