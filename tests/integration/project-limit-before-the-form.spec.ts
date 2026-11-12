/**
 * A PLAN LIMIT IS SAID BEFORE THE NEW PROJECT FORM, IN CREATING'S OWN WORDS
 * ========================================================================
 *
 * Production QA (2026-11-09): on Free, "New project" opened the form, and the
 * limit came back only after the name and region were filled in. The console
 * now asks GET /api/projects/can-create first. Its answer is the one
 * POST /api/projects gives (lib/projects/creation-verdict.ts), so the two
 * can't drift apart; the POST still decides.
 */
let mockPlan: 'free' | 'none' = 'free'
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return {
    ...actual,
    cloudEntitlements: async () =>
      mockPlan === 'none' ? null : { ...selfHostedEntitlements(), planName: 'SANDBOX', maxProjects: 1 },
  }
})

// The sign-in wrapper is delegated (its decision is pinned elsewhere); the
// account, the count, the plan and the database behind them are real.
let currentUserId = ''
jest.mock('@/lib/auth/route-protection', () => {
  const actual = jest.requireActual('@/lib/auth/route-protection')
  return {
    ...actual,
    withAuth: (handler: any) => async (request: any, ctx: any = {}) =>
      handler(request, { user: { userId: currentUserId, email: 'owner@example.test' }, params: ctx.params }),
  }
})

import '../helpers/real-web-standard'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { GET as canCreate } from '@/app/api/projects/can-create/route'
import { POST as create } from '@/app/api/projects/route'

let fullId: string
let emptyId: string
let projectId: string
const originalEdition = process.env.BACKENLY_EDITION

const user = async (name: string) =>
  (await prisma.user.create({
    data: { email: `limit-${name}-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name },
  })).id

beforeAll(async () => {
  fullId = await user('full')
  emptyId = await user('empty')
  projectId = (await prisma.project.create({ data: { name: 'the-one-free-project', userId: fullId } })).id
}, 60_000)

beforeEach(() => {
  process.env.BACKENLY_EDITION = 'cloud'
  mockPlan = 'free'
})

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [fullId, emptyId] } } }).catch(() => {})
}, 60_000)

const ask = async (userId: string) => {
  currentUserId = userId
  const res = await canCreate(new NextRequest('http://localhost:3000/api/projects/can-create'), {} as any)
  return { status: res.status, body: await res.json() }
}

it('on a full plan, says the limit before the form, in the words creating uses', async () => {
  const before = await ask(fullId)
  expect(before.status).toBe(200)
  expect(before.body).toMatchObject({ allowed: false, code: 'PLAN_LIMIT_EXCEEDED', currentPlan: 'SANDBOX' })

  currentUserId = fullId
  const res = await create(
    new NextRequest('http://localhost:3000/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a-second-one', userId: fullId }),
    }),
    {} as any,
  )
  const created = await res.json()
  expect(res.status).toBe(403)
  expect(created).toMatchObject({ success: false, code: 'PLAN_LIMIT_EXCEEDED' })
  expect(before.body.error).toBe(created.error)
  expect(await prisma.project.count({ where: { userId: fullId } })).toBe(1)
})

it('with room on the plan, says yes', async () => {
  expect((await ask(emptyId)).body).toEqual({ allowed: true })
})

it('for an account with no entitlements yet, says yes: creating gives it them first', async () => {
  mockPlan = 'none'
  expect((await ask(fullId)).body).toEqual({ allowed: true })
})

it('on a single-tenant deployment, says a second project is not supported there', async () => {
  delete process.env.BACKENLY_EDITION
  expect((await ask(emptyId)).body).toMatchObject({ allowed: false, code: 'PROJECT_CREATION_UNSUPPORTED' })
})
