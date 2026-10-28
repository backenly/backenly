/**
 * CI coverage for the realtime surfaces it can honestly exercise
 * (medium finding RT-11).
 *
 * Covered here: SSE ticket single-use, expiry, type and project binding
 * (real ledger rows, real HS256 tickets), and the broadcast payload cap
 * with a real NOTIFY below it. Presence identity is covered by
 * presence-identity-binding.spec.ts. End-to-end SSE frame delivery stays a
 * staging case on purpose: it runs through the runtime container's LISTEN
 * hub and the ALB, neither of which CI runs — pretending otherwise here
 * would be a green that proves nothing.
 */
import '@/tests/helpers/real-web-standard'

import crypto, { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'

import { prisma } from '@/lib/db/prisma'
import { mintSseTicket, redeemSseTicket, SSE_TICKET_TTL_SECONDS } from '@/lib/realtime/sse-ticket'
import { hashApiKey } from '@/server/lib/end-user-identity'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId: string
let projectId: string
let jwtSecret: string
let publicKey: string

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: {
        email: `rt-ticket-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Realtime Ticket Suite',
      },
      select: { id: true },
    })
  ).id
  jwtSecret = crypto.randomBytes(32).toString('hex')
  projectId = (
    await prisma.project.create({
      data: { name: 'rt-ticket', userId: ownerId, jwtSecret },
      select: { id: true },
    })
  ).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
  const raw = `proj_live_${crypto.randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'rt-ticket', keyPrefix: raw.slice(0, 16), permissions: ['read', 'write'], capabilities: [],
      userId: ownerId, projectId, keyType: 'public', scope: 'runtime', serviceRole: false,
      rateLimit: 1000, keyHash: hashApiKey(raw),
    },
  })
  publicKey = raw
}, 120_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('RT-11: SSE tickets are single-use and bound', () => {
  it('a ticket redeems once and only once', async () => {
    const minted = await mintSseTicket(jwtSecret, { projectId })
    expect(minted.singleUse).toBe(true)
    const first = await redeemSseTicket(projectId, jwtSecret, minted.ticket)
    expect(first.ok).toBe(true)
    const replay = await redeemSseTicket(projectId, jwtSecret, minted.ticket)
    expect(replay).toMatchObject({ ok: false, code: 'ALREADY_USED' })
  }, 60_000)

  it('an expired ticket names the mint route, not a generic error', async () => {
    const expired = jwt.sign(
      { typ: 'sse', jti: randomUUID(), projectId },
      jwtSecret,
      { algorithm: 'HS256', expiresIn: -5 },
    )
    const out = await redeemSseTicket(projectId, jwtSecret, expired)
    expect(out).toMatchObject({ ok: false, code: 'EXPIRED' })
    expect((out as any).message).toContain('/realtime/ticket')
    expect(SSE_TICKET_TTL_SECONDS).toBeLessThanOrEqual(60) // short-lived by design
  }, 60_000)

  it('a non-ticket token and a foreign-project ticket are refused by code', async () => {
    const notTicket = jwt.sign({ userId: 'u1', projectId }, jwtSecret, { algorithm: 'HS256', expiresIn: 60 })
    await expect(redeemSseTicket(projectId, jwtSecret, notTicket)).resolves.toMatchObject({ ok: false, code: 'INVALID' })
    const foreign = jwt.sign(
      { typ: 'sse', jti: randomUUID(), projectId: randomUUID() },
      jwtSecret,
      { algorithm: 'HS256', expiresIn: 60 },
    )
    await expect(redeemSseTicket(projectId, jwtSecret, foreign)).resolves.toMatchObject({ ok: false, code: 'WRONG_PROJECT' })
  }, 60_000)
})

describe('RT-11: broadcast enforces its payload cap for real', () => {
  const post = async (payload: unknown) => {
    const { POST } = await import('@/app/api/v1/[projectId]/broadcast/route')
    const req = new NextRequest(`http://test.local/api/v1/${projectId}/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': publicKey },
      body: JSON.stringify({ channel: 'chat', payload }),
    })
    const res = await POST(req, { params: Promise.resolve({ projectId }) })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }

  it('a payload above the cap answers 413', async () => {
    const out = await post({ blob: 'x'.repeat(7_000) })
    expect(out.status).toBe(413)
  }, 60_000)

  it('a payload below the cap NOTIFYs for real', async () => {
    const out = await post({ note: 'hello' })
    expect(out.status).toBe(200)
  }, 60_000)
})
