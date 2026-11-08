/**
 * A REALTIME STREAM'S END USER COMES FROM A TICKET, NEVER FROM ITS URL (#621)
 * ==========================================================================
 * The agent realtime doc said "the older `?apiKey=&userToken=` query form still
 * works". Nothing reads a user token from a query string, so a client that
 * followed it opened a stream with no end user, which receives nothing from
 * tables whose rows only their owners may read, and no error. It also said
 * `old` carries the previous row on updates, when a stream that is not a
 * service-role one receives only the primary key. These pin what the doc now
 * says to what both doors do:
 *
 *   Next (lib/api/v1/middleware.ts)   a user token in the URL is not read; the
 *                                     same token as X-User-Token is the user
 *   the runtime (server/lib/auth.ts)  a stream opened with ?apiKey= has no end
 *                                     user, whatever its URL carries
 *   POST /realtime/ticket             a ticket minted with X-User-Token speaks
 *                                     for that user when the stream redeems it
 *
 * `old` reduced to the primary key is pinned in tests/unit/realtime-visibility.spec.ts
 * and, against real row-level security, __tests__/database/realtime-row-visibility.test.ts.
 *
 * Real database: the project, its end-user table and user, the key, the ticket.
 */
import '@/tests/helpers/real-web-standard'

import fs from 'fs'
import path from 'path'
import { randomBytes, randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'
import { redeemRealtimeTicketParam } from '@/lib/realtime/ticket-auth'
import { v1AuthMiddleware } from '@/server/lib/auth'
import { POST as mintTicket } from '@/app/api/v1/[projectId]/realtime/ticket/route'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'

const ALICE = `rt-identity-${randomUUID().slice(0, 8)}@test.invalid`

let ownerId = ''
let projectId = ''
let jwtSecret = ''
let clientKey = ''
let aliceId = ''
let aliceToken = ''

const streamUrl = (query: string) => `https://backenly.test/api/v1/${projectId}/realtime?${query}`

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `rt-identity-owner-${randomUUID()}@test.invalid`, name: 'Realtime Identity' },
    select: { id: true },
  })).id
  jwtSecret = randomBytes(32).toString('hex')
  projectId = (await prisma.project.create({
    data: { name: `rt-identity-${randomUUID().slice(0, 8)}`, userId: ownerId, jwtSecret },
    select: { id: true },
  })).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
  await ensureAuthUsersTable(projectId, { email: ALICE })
  aliceId = (await executeWithUserContext<{ id: string }>(
    projectId,
    '',
    true,
    `INSERT INTO "workspace_${projectId}"."users" (email, password) VALUES ($1, 'x') RETURNING id::text AS id`,
    [ALICE],
  ))[0].id
  aliceToken = jwt.sign({ userId: aliceId, email: ALICE, projectId, role: 'user', jti: randomUUID() }, jwtSecret, {
    algorithm: 'HS256',
    expiresIn: '1h',
  })
  clientKey = `proj_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'rt-identity', keyPrefix: clientKey.slice(0, 16), keyHash: hashApiKey(clientKey),
      permissions: ['read', 'write'], capabilities: [], userId: ownerId, projectId,
      keyType: 'public', scope: 'runtime', serviceRole: false, rateLimit: 1000,
    },
  })
}, 60_000)

afterAll(async () => {
  await flushRecordedRequests().catch(() => {})
  if (projectId) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('the Next door', () => {
  it('does not read a user token from the stream URL', async () => {
    const out = await v1ApiMiddleware(
      new NextRequest(streamUrl(`apiKey=${clientKey}&userToken=${aliceToken}`)),
      { projectId },
    )
    expect(out.response).toBeFalsy()
    expect(out.context.endUserId ?? null).toBeNull()
  })

  it('takes the same token as the user from X-User-Token', async () => {
    const out = await v1ApiMiddleware(
      new NextRequest(streamUrl(''), { headers: { 'x-api-key': clientKey, 'x-user-token': aliceToken } }),
      { projectId },
    )
    expect(out.response).toBeFalsy()
    expect(out.context.endUserId).toBe(aliceId)
  })
})

describe('the runtime door', () => {
  it('gives a stream opened with ?apiKey= no end user, whatever its URL carries', async () => {
    const req: any = {
      params: { projectId },
      headers: {},
      query: { apiKey: clientKey, userToken: aliceToken },
      method: 'GET',
      url: `/api/v1/${projectId}/realtime?apiKey=${clientKey}&userToken=${aliceToken}`,
      originalUrl: `/api/v1/${projectId}/realtime?apiKey=${clientKey}&userToken=${aliceToken}`,
    }
    const res: any = {
      locals: {},
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) { this.headers[name] = value },
      status(code: number) { this.statusCode = code; return this },
      json(body: unknown) { this.body = body; return this },
    }
    const next = jest.fn()

    await v1AuthMiddleware(req, res, next)

    expect(res.statusCode).toBeUndefined()
    expect(next).toHaveBeenCalled()
    expect(req.v1Context).toMatchObject({ projectId })
    expect(req.v1Context.endUserId).toBeUndefined()
  })
})

describe('a ticket', () => {
  async function ticketFor(url: string, headers: Record<string, string>) {
    const res = await (mintTicket as any)(new NextRequest(url, { method: 'POST', headers }), {
      params: Promise.resolve({ projectId }),
    })
    expect(res.status).toBe(200)
    return (await res.json()) as { ticket: string; endUserId: string | null }
  }

  it('minted with X-User-Token speaks for that user when the stream redeems it', async () => {
    const minted = await ticketFor(`https://backenly.test/api/v1/${projectId}/realtime/ticket`, {
      'x-api-key': clientKey,
      'x-user-token': aliceToken,
    })
    expect(minted.endUserId).toBe(aliceId)
    const redeemed = await redeemRealtimeTicketParam(projectId, minted.ticket)
    expect(redeemed).toMatchObject({ ok: true, claims: { endUserId: aliceId } })
  })

  it('carries no user when the token was only in the URL', async () => {
    const minted = await ticketFor(`https://backenly.test/api/v1/${projectId}/realtime/ticket?userToken=${aliceToken}`, {
      'x-api-key': clientKey,
    })
    expect(minted.endUserId ?? null).toBeNull()
  })
})

describe('the agent realtime doc', () => {
  const doc = fs.readFileSync(path.join(process.cwd(), 'public', 'docs', 'agents', 'realtime.md'), 'utf8')

  it('points a signed-in stream to a ticket, and promises no user-token query form', () => {
    expect(doc).toContain("A signed-in user's stream needs a ticket: the stream reads no user token from its URL")
    expect(doc).toContain('POST /api/v1/{projectId}/realtime/ticket')
    expect(doc).not.toMatch(/userToken=/)
  })

  it('describes `old` as it is delivered', () => {
    expect(doc).toContain(
      "On an update, `old` carries only the previous row's primary key, unless the stream was opened with a service-role key",
    )
    expect(doc).not.toContain('`old` carries the previous row on updates')
  })
})
