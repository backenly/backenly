/**
 * THE CONSOLE'S REALTIME PAGE SEES EVERY CHANGE
 * =============================================
 *
 * The page listened with the project's public anon key, and the stream delivers
 * a change only to a subscriber that could read the row. On a table behind
 * row-level security an anonymous visitor reads nothing, so the owner watched
 * "Connected · Listening for changes" while their orders were updated, and saw
 * no event at all.
 *
 * The page now opens the stream with a ticket from the console
 * (app/api/projects/[id]/realtime-ticket). Pinned here on a real provisioned
 * project, a table with Backenly's own row security, and a real session:
 *
 *  1. A project member gets a single-use ticket that redeems as a stream that
 *     sees every change, where the anon key's stream saw only what an
 *     anonymous visitor could read.
 *  2. Someone who is not a member gets no ticket.
 *  3. A project with no signing secret says so (the page then falls back to
 *     the anon key and says what that view leaves out).
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { createProvisionedProject } from '@/lib/projects/provision'
import { withChangeAttribution } from '@/lib/changes/attribution'
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { redeemRealtimeTicketParam } from '@/lib/realtime/ticket-auth'
import { visibleChange, type RealtimeSubscriber } from '@/lib/realtime/visibility'
import { GET, POST } from '@/app/api/projects/[id]/realtime-ticket/route'

let ownerId: string
let ownerEmail: string
let strangerId: string
let projectId: string
let schema: string
let bareProjectId: string
let orderId: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

async function askForTicket(userId: string, email: string, project: string) {
  const { token } = await createSession(userId, email, 'user')
  const res = await POST(
    new NextRequest(`https://backenly.test/api/projects/${project}/realtime-ticket`, {
      method: 'POST',
      headers: { cookie: `auth-token=${token}` },
    }),
  )
  return { status: res.status, body: (await res.json()) as any, cacheControl: res.headers.get('cache-control') }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'

  ownerEmail = `realtime-owner-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, password: 'not-a-real-hash', name: 'owner' } })).id
  strangerId = (await prisma.user.create({
    data: { email: `realtime-stranger-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'stranger' },
  })).id

  const project = await createProvisionedProject({ name: 'console-realtime', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })

  // A table the way Backenly makes one: an owner column, so row security
  // admits only the row's own user.
  const made = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    applyMigrationToMain(projectId, ownerId, 'CREATE TABLE orders (user_id uuid, total integer NOT NULL)', {
      agentSurface: false,
      workspaceSchema: schema,
    }),
  )
  if (!made.ok) throw new Error(`orders was not created: ${JSON.stringify(made)}`)
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO "${schema}"."orders" (user_id, total) VALUES ($1::uuid, 5) RETURNING id::text`,
    crypto.randomUUID(),
  )
  orderId = rows[0].id

  bareProjectId = (await prisma.project.create({ data: { name: 'no-secret', userId: ownerId }, select: { id: true } })).id
}, 240_000)

afterAll(async () => {
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } }).catch(() => {})
  await closeChangeLockPool()
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
})

describe('the console realtime ticket', () => {
  it('opens a stream that sees every change, which the anon key never could', async () => {
    const answer = await askForTicket(ownerId, ownerEmail, projectId)
    expect(answer.status).toBe(200)
    expect(answer.cacheControl).toMatch(/no-store/)
    expect(typeof answer.body.ticket).toBe('string')

    const redeemed = await redeemRealtimeTicketParam(projectId, answer.body.ticket)
    expect(redeemed.ok).toBe(true)
    const claims = (redeemed as Extract<typeof redeemed, { ok: true }>).claims!
    const consoleStream: RealtimeSubscriber = {
      projectId,
      endUserId: claims.endUserId ?? null,
      endUserRole: claims.endUserRole ?? null,
      serviceRole: !!claims.serviceRole,
    }
    expect(consoleStream).toEqual({ projectId, endUserId: null, endUserRole: null, serviceRole: true })

    // What the page used to open: the anon key, an anonymous stream. Each
    // change reaches a stream only if its identity could read the row
    // (lib/realtime/visibility.ts); under Backenly's own-rows policy an
    // anonymous visitor reads none, and a service-role stream gets every change
    // as sent. __tests__/database/realtime-row-visibility.test.ts proves both
    // under a production-like role. Here, the decision with row security
    // answering "no" for the visitor, as it does for this table's row:
    const anonymousStream: RealtimeSubscriber = { projectId, endUserId: null, endUserRole: null, serviceRole: false }
    const rowSecurity = {
      primaryKey: async () => [{ name: 'id', type: 'uuid' }],
      canSelect: async (who: RealtimeSubscriber) => who.serviceRole,
    }
    const change = { type: 'update', table: 'orders', data: { id: orderId, total: 6 }, old: { id: orderId } }
    expect(await visibleChange(anonymousStream, change, rowSecurity)).toBeNull()
    expect(await visibleChange(consoleStream, change, rowSecurity)).toMatchObject({ table: 'orders', data: { id: orderId, total: 6 } })

    // Single use: the same ticket does not open a second stream.
    expect((await redeemRealtimeTicketParam(projectId, answer.body.ticket)).ok).toBe(false)
  }, 60_000)

  it('is not given to someone outside the project', async () => {
    const answer = await askForTicket(strangerId, 'stranger@example.test', projectId)
    expect([403, 404]).toContain(answer.status)
    expect(answer.body.ticket).toBeUndefined()
  }, 60_000)

  it('says when the project has no signing secret', async () => {
    await prisma.project.update({ where: { id: bareProjectId }, data: { jwtSecret: null } })
    const answer = await askForTicket(ownerId, ownerEmail, bareProjectId)
    expect(answer.status).toBe(409)
    expect(answer.body.code).toBe('NO_PROJECT_SECRET')
  }, 60_000)

  it('is never minted by a GET', async () => {
    const res = await GET()
    expect(res.status).toBe(405)
  })
})
