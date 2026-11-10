/**
 * A PROJECT ON A PLAN WITHOUT WEBHOOKS CAN STILL STOP THE ONES IT HAS
 * ===================================================================
 *
 * Delivery doesn't check the plan, so endpoints made on Pro keep receiving a
 * project's events after it moves to Free. Every route refused to disable or
 * delete them there, so the only way to stop the data going out was to pay.
 * Disabling and deleting are now allowed on every plan; turning an endpoint
 * back on, or any other edit, still needs a plan that includes webhooks, and
 * authorization is unchanged (deleting stays ADMIN).
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
import { PATCH, DELETE } from '@/app/api/projects/[id]/webhooks/[webhookId]/route'

let ownerId: string
let strangerId: string
let projectId: string
const originalEdition = process.env.BACKENLY_EDITION

const user = async (name: string) =>
  (await prisma.user.create({
    data: { email: `wh-stop-${name}-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name },
  })).id

const madeOnPro = async (active = true) =>
  (await prisma.webhook.create({
    data: { projectId, eventType: 'row.inserted', targetUrl: 'https://hooks.example.test/made-on-pro', secret: 'whsec_test', active },
  })).id

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = await user('owner')
  strangerId = await user('stranger')
  projectId = (await prisma.project.create({ data: { name: 'webhooks-after-downgrade', userId: ownerId } })).id
}, 60_000)

beforeEach(() => {
  currentUserId = ownerId
})

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  await prisma.webhook.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } }).catch(() => {})
}, 60_000)

const call = async (handler: (req: any, ctx: any) => Promise<Response>, webhookId: string, method: string, body?: unknown) => {
  const res = await handler(
    new NextRequest(`http://localhost:3000/api/projects/${projectId}/webhooks/${webhookId}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({ id: projectId, webhookId }) } as any,
  )
  return { status: res.status, body: await res.json() }
}

const row = (id: string) => prisma.webhook.findUnique({ where: { id } })

it('disables one', async () => {
  const id = await madeOnPro()
  const r = await call(PATCH, id, 'PATCH', { active: false })
  expect(r.status).toBe(200)
  expect((await row(id))?.active).toBe(false)
})

it('deletes one', async () => {
  const id = await madeOnPro()
  const r = await call(DELETE, id, 'DELETE')
  expect(r.status).toBe(200)
  expect(await row(id)).toBeNull()
})

it('still refuses to turn one back on', async () => {
  const id = await madeOnPro(false)
  const r = await call(PATCH, id, 'PATCH', { active: true })
  expect(r.status).toBe(403)
  expect(r.body).toMatchObject({ code: 'PLAN_LIMIT_EXCEEDED' })
  expect((await row(id))?.active).toBe(false)
})

it('still refuses an edit that disables and also changes something else', async () => {
  const id = await madeOnPro()
  const r = await call(PATCH, id, 'PATCH', { active: false, targetUrl: 'https://hooks.example.test/elsewhere' })
  expect(r.status).toBe(403)
  expect(await row(id)).toMatchObject({ active: true, targetUrl: 'https://hooks.example.test/made-on-pro' })
})

it('still lets nobody outside the project disable or delete one', async () => {
  const id = await madeOnPro()
  currentUserId = strangerId
  expect((await call(PATCH, id, 'PATCH', { active: false })).status).toBe(404)
  expect((await call(DELETE, id, 'DELETE')).status).toBe(404)
  expect((await row(id))?.active).toBe(true)
})
