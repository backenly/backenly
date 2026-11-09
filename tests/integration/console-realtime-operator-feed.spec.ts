/**
 * THE CONSOLE'S REALTIME PAGE SHOWS EVERY CHANGE (#617)
 * =====================================================
 * The page opened its stream with the project's anon key: no end user and no
 * service role. A stream delivers an insert or an update only when it can read
 * the row, and nobody anonymous can read a row of a table only its owners may
 * read, so the page showed such a table's deletes alone, as bare ids. It now
 * opens the stream with a ticket issued to the signed-in member:
 *
 *   POST /api/projects/:id/realtime-ticket   for whoever may open the project:
 *                                            401 with no session, 404 for anyone
 *                                            else. It names the member in `op`
 *                                            and no end user, reads as the
 *                                            service role, lasts 30 seconds and
 *                                            is spent once; it is not issued, or
 *                                            accepted, when it cannot be spent.
 *                                            A project with no secret gets one
 *   the stream, on the runtime and Next      the insert, the update and the
 *                                            delete, whole, on an owner-only
 *                                            table, where a stream on the anon
 *                                            key still receives the delete alone
 *   the end-user doors                       take the ticket as no user, and
 *                                            refresh makes no session of it
 *
 * Real database: the project, its owner-only table, its realtime trigger and
 * notifications, the sessions, the ticket ledger. As in
 * __tests__/database/realtime-row-visibility.test.ts, the anon stream's checks
 * run under a NOSUPERUSER NOBYPASSRLS role when this suite's connection is a
 * superuser, so the policy decides as it does in production.
 */

const mockPremise = { role: '' }
jest.mock('@/lib/services/workspace-rls', () => {
  const actual = jest.requireActual('@/lib/services/workspace-rls')
  return {
    ...actual,
    executeWithUserContext: async (projectId: string, userId: string, isServiceRole: boolean, sql: string, values: unknown[] = [], userRole = 'user') => {
      if (!mockPremise.role) return actual.executeWithUserContext(projectId, userId, isServiceRole, sql, values, userRole)
      const { prisma: db } = jest.requireActual('@/lib/db/prisma')
      const { rlsSessionSql, rlsSessionParams } = jest.requireActual('@/lib/services/rls-session')
      return db.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${mockPremise.role}`)
        await tx.$executeRawUnsafe(rlsSessionSql(), ...rlsSessionParams({ userId, isServiceRole, userRole }))
        return tx.$queryRawUnsafe(sql, ...values)
      })
    },
  }
})

import '@/tests/helpers/real-web-standard'

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { mintKey } from '@/lib/auth/key-prefix'
import { jwtClaimFunctionSql, ownRowsPredicate } from '@/lib/postgrest/rls-translation'
import { installRealtimeTrigger } from '@/lib/services/realtimeTriggers'
import { mintSseTicket } from '@/lib/realtime/sse-ticket'
import { redeemRealtimeTicketParam } from '@/lib/realtime/ticket-auth'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'
import { refreshEndUserToken } from '@/lib/services/end-user-auth-flows'
import { hashApiKey, resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { POST as issueTicket } from '@/app/api/projects/[id]/realtime-ticket/route'
import { GET as nextStreamRoute } from '@/app/api/v1/[projectId]/realtime/route'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import app from '@/server/app'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const userIds: string[] = []
const projectIds: string[] = []
let owner = { id: '', session: '' }
let stranger = { id: '', session: '' }
let projectId = ''
let schema = ''
let jwtSecret = ''
let anonKey = ''
let runtime: http.Server
let runtimeBase = ''
const alice = randomUUID()

async function makeUser(label: string) {
  const email = `rt-console-${label}-${randomUUID()}@test.invalid`
  const id = (await prisma.user.create({ data: { email, name: `Realtime console ${label}` }, select: { id: true } })).id
  userIds.push(id)
  return { id, session: (await createSession(id, email, 'user')).token }
}

/** A project of the owner's, with its workspace schema unless told otherwise. */
async function makeProject(opts: { jwtSecret?: string; schema?: boolean } = {}) {
  const id = (await prisma.project.create({
    data: { name: `rt-console-${randomUUID().slice(0, 8)}`, userId: owner.id, jwtSecret: opts.jwtSecret },
    select: { id: true },
  })).id
  projectIds.push(id)
  if (opts.schema !== false) await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${id}"`)
  return id
}

/** POST /api/projects/:id/realtime-ticket, as the console sends it. */
async function askForTicket(id: string, session: string | null) {
  const res: Response = await issueTicket(
    new NextRequest(`https://backenly.test/api/projects/${id}/realtime-ticket`, {
      method: 'POST',
      headers: session ? { authorization: `Bearer ${session}` } : {},
    }),
    { params: Promise.resolve({ id }) },
  )
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> }
}

async function ticketFor(id: string): Promise<string> {
  const out = await askForTicket(id, owner.session)
  expect(out.status).toBe(200)
  return out.body.ticket
}

/** The data frames a stream sends, parsed, as they arrive. */
function frameReader() {
  const frames: Array<Record<string, any>> = []
  let buffered = ''
  return {
    frames,
    push(chunk: string) {
      buffered += chunk
      for (let end = buffered.indexOf('\n\n'); end >= 0; end = buffered.indexOf('\n\n')) {
        const block = buffered.slice(0, end)
        buffered = buffered.slice(end + 2)
        for (const line of block.split('\n')) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)))
      }
    },
  }
}

interface OpenStream {
  frames: Array<Record<string, any>>
  close(): void
}

/** GET /api/v1/:projectId/realtime on the runtime (Express), as an EventSource opens it. */
function runtimeStream(query: string): OpenStream {
  const reader = frameReader()
  const req = http.get(`${runtimeBase}/api/v1/${projectId}/realtime?${query}`, (res) => {
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => reader.push(chunk))
  })
  req.on('error', () => {})
  return { frames: reader.frames, close: () => req.destroy() }
}

/** The same request to the Next route, which serves it in development. */
async function nextStream(query: string): Promise<OpenStream> {
  const left = new AbortController()
  const res: Response = await (nextStreamRoute as any)(
    new NextRequest(`https://backenly.test/api/v1/${projectId}/realtime?${query}`, { signal: left.signal }),
    { params: Promise.resolve({ projectId }) },
  )
  const reader = frameReader()
  const body = res.body!.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    for (;;) {
      const next = await body.read().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) return
      reader.push(decoder.decode(next.value))
    }
  })()
  return { frames: reader.frames, close: () => left.abort() }
}

async function until(what: string, holds: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const changes = (stream: OpenStream) => stream.frames.filter((f) => ['insert', 'update', 'delete'].includes(f.type))

/** What the app does to one of alice's notes: create it, edit it, delete it. */
async function aliceWritesANote(id: string): Promise<void> {
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}".notes (id, owner_id, body) VALUES ($1::uuid, $2, 'alice private')`, id, alice)
  await prisma.$executeRawUnsafe(`UPDATE "${schema}".notes SET body = 'alice edited' WHERE id = $1::uuid`, id)
  await prisma.$executeRawUnsafe(`DELETE FROM "${schema}".notes WHERE id = $1::uuid`, id)
}

function expectEveryChangeWhole(stream: OpenStream, id: string): void {
  expect(changes(stream)).toEqual([
    expect.objectContaining({ type: 'insert', table: 'notes', data: { id, owner_id: alice, body: 'alice private' } }),
    expect.objectContaining({
      type: 'update',
      table: 'notes',
      data: { id, owner_id: alice, body: 'alice edited' },
      old: { id, owner_id: alice, body: 'alice private' },
    }),
    expect.objectContaining({ type: 'delete', table: 'notes', data: { id, owner_id: alice, body: 'alice edited' } }),
  ])
}

beforeAll(async () => {
  assertSafeTestDatabase()
  // A multi-tenant database, as Cloud runs: the access check resolves the
  // project by id rather than as the deployment's only one.
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  owner = await makeUser('owner')
  stranger = await makeUser('stranger')
  jwtSecret = randomBytes(32).toString('hex')
  projectId = await makeProject({ jwtSecret })
  schema = `workspace_${projectId}`

  // A table only its owners may read, as Backenly secures one.
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}".notes (id uuid PRIMARY KEY, owner_id text, body text)`)
  await prisma.$executeRawUnsafe(jwtClaimFunctionSql(schema))
  await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}".notes ENABLE ROW LEVEL SECURITY`)
  await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}".notes FORCE ROW LEVEL SECURITY`)
  const pred = ownRowsPredicate(schema, 'owner_id')
  await prisma.$executeRawUnsafe(`CREATE POLICY own_rows ON "${schema}".notes FOR ALL USING (${pred}) WITH CHECK (${pred})`)
  expect(await installRealtimeTrigger(projectId, 'notes')).toEqual({ installed: true })

  const [who] = await prisma.$queryRawUnsafe<Array<{ rolsuper: boolean; user: string }>>(
    `SELECT rolsuper, current_user AS "user" FROM pg_roles WHERE rolname = current_user`,
  )
  if (who.rolsuper) {
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_rls_premise') THEN
          CREATE ROLE backenly_rls_premise NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$`)
    await prisma.$executeRawUnsafe(`GRANT "${who.user}" TO backenly_rls_premise`)
    mockPremise.role = 'backenly_rls_premise'
  }

  // The project's anon key, which the page used to stream with.
  const minted = mintKey({ keyType: 'public', serviceRole: false })
  anonKey = minted.key
  await prisma.apiKey.create({
    data: {
      name: 'Public Anon Key', keyPrefix: minted.prefix, keyHash: hashApiKey(anonKey),
      permissions: ['read', 'write'], capabilities: [], userId: owner.id, projectId,
      keyType: 'public', serviceRole: false, rateLimit: 1000,
    },
  })

  runtime = http.createServer(app)
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
  runtimeBase = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await new Promise((resolve) => runtime?.close(resolve))
  await flushRecordedRequests().catch(() => {})
  for (const id of projectIds) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId: id } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {})
}, 60_000)

describe('POST /api/projects/:id/realtime-ticket', () => {
  it('issues a member a ticket that names them, no end user, and reads as the service role', async () => {
    const out = await askForTicket(projectId, owner.session)

    expect(out.status).toBe(200)
    expect(out.headers.get('cache-control')).toContain('no-store')
    const claims = jwt.verify(out.body.ticket, jwtSecret, { algorithms: ['HS256'] }) as Record<string, any>
    expect(claims).toMatchObject({ typ: 'sse', projectId, op: owner.id, svc: true, userId: null, role: null, keyId: null })
    expect(claims.exp - claims.iat).toBe(30)
  })

  it('refuses a caller with no session, and anyone who may not open the project', async () => {
    const anonymous = await askForTicket(projectId, null)
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.ticket).toBeUndefined()

    const theirs = await askForTicket(projectId, stranger.session)
    expect(theirs.status).toBe(404)
    expect(theirs.body.ticket).toBeUndefined()
  })

  it('is spent by the stream that redeems it, and only once', async () => {
    const ticket = await ticketFor(projectId)

    const first = await redeemRealtimeTicketParam(projectId, ticket)
    expect(first).toMatchObject({
      ok: true,
      singleUseEnforced: true,
      claims: { projectId, operatorId: owner.id, serviceRole: true, endUserId: null, endUserRole: null },
    })
    expect(await redeemRealtimeTicketParam(projectId, ticket)).toMatchObject({ ok: false, code: 'ALREADY_USED' })
  })

  it('gives a project that never had a secret one, and the stream verifies the ticket with it', async () => {
    const secretless = await makeProject()

    const ticket = await ticketFor(secretless)

    const stored = await prisma.project.findUnique({ where: { id: secretless }, select: { jwtSecret: true } })
    expect(stored?.jwtSecret).toBeTruthy()
    expect(await redeemRealtimeTicketParam(secretless, ticket)).toMatchObject({ ok: true, claims: { operatorId: owner.id } })
  })

  it('issues no ticket when the project ledger cannot record it as spent', async () => {
    // No workspace schema: the ledger cannot be created, so nothing could spend the ticket.
    const ledgerless = await makeProject({ jwtSecret: randomBytes(32).toString('hex'), schema: false })

    const out = await askForTicket(ledgerless, owner.session)

    expect(out.status).toBe(503)
    expect(out.body).toMatchObject({ code: 'TICKET_LEDGER_UNAVAILABLE' })
    expect(out.body.ticket).toBeUndefined()
  })

  it('is not accepted when the stream cannot record it as spent, while a key ticket still is', async () => {
    const consoleTicket = await ticketFor(projectId)
    const keyTicket = (await mintSseTicket(jwtSecret, { projectId, keyId: 'k1' })).ticket
    await prisma.$executeRawUnsafe(`DROP TABLE "${schema}"."_token_blacklist"`)

    expect(await redeemRealtimeTicketParam(projectId, consoleTicket)).toMatchObject({ ok: false, code: 'NOT_SPENT' })
    // Unchanged for a ticket minted with a key: accepted, and said to be replayable.
    expect(await redeemRealtimeTicketParam(projectId, keyTicket)).toMatchObject({ ok: true, singleUseEnforced: false })
  })
})

describe('the stream a console ticket opens', () => {
  it('receives the insert, the update and the delete whole on the runtime, where the anon key received the delete alone', async () => {
    const operator = runtimeStream(`ticket=${encodeURIComponent(await ticketFor(projectId))}`)
    const anon = runtimeStream(`apiKey=${encodeURIComponent(anonKey)}`)
    try {
      await until('both streams to connect', () => [operator, anon].every((s) => s.frames.some((f) => f.type === 'connected')))
      const id = randomUUID()

      await aliceWritesANote(id)

      await until('the operator stream to receive all three changes', () => changes(operator).length >= 3)
      expectEveryChangeWhole(operator, id)
      // Changes reach a stream in order, so once the delete is in, the insert
      // and the update were decided and withheld.
      await until('the anon stream to receive the delete', () => changes(anon).some((f) => f.type === 'delete'))
      expect(changes(anon)).toEqual([expect.objectContaining({ type: 'delete', table: 'notes', data: { id } })])
    } finally {
      operator.close()
      anon.close()
    }
  })

  it('receives them whole on the Next route too', async () => {
    const operator = await nextStream(`ticket=${encodeURIComponent(await ticketFor(projectId))}`)
    try {
      await until('the stream to connect', () => operator.frames.some((f) => f.type === 'connected'))
      const id = randomUUID()

      await aliceWritesANote(id)

      await until('all three changes', () => changes(operator).length >= 3)
      expectEveryChangeWhole(operator, id)
    } finally {
      operator.close()
    }
  })

  it('is refused once it has been spent', async () => {
    const ticket = await ticketFor(projectId)
    expect((await redeemRealtimeTicketParam(projectId, ticket)).ok).toBe(true)

    const res = await fetch(`${runtimeBase}/api/v1/${projectId}/realtime?ticket=${encodeURIComponent(ticket)}`)

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'ALREADY_USED' })
  })
})

describe('the end-user doors', () => {
  it('take a console ticket as no end user', async () => {
    const ticket = await ticketFor(projectId)

    expect(await resolveEndUserFromToken(projectId, ticket)).toBeNull()
    const next = await v1ApiMiddleware(
      new NextRequest(`https://backenly.test/api/v1/${projectId}/db/notes`, { headers: { 'x-api-key': anonKey, 'x-user-token': ticket } }),
      { projectId },
    )
    expect(next.response).toBeFalsy()
    expect(next.context.endUserId ?? null).toBeNull()
  })

  it('make no session of a console ticket on refresh', async () => {
    const out = await refreshEndUserToken(projectId, await ticketFor(projectId))

    expect(out.status).not.toBe(200)
    expect(out.body?.data?.token).toBeUndefined()
  })
})
