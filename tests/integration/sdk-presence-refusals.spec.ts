/**
 * WHAT THE PRESENCE ROUTES ANSWER THE PUBLISHED CLIENT (#619)
 * ===========================================================
 * presence.join() resolved whatever the server said, so a user the server
 * refused never appeared online, and the heartbeat went on posting refused
 * requests every 25 seconds. The client is driven here through both servers
 * that answer /api/v1/:projectId/presence: the Next route, in this process,
 * and the runtime (server/routes/presence.ts) on a port. A real project, a
 * public key and real end-user tokens:
 *
 *   before sign-in          join rejects with PRESENCE_TOKEN_REQUIRED (401)
 *   any other id            a username, an email, or 'user-123' as the SDK's
 *                           example once showed, rejects with
 *                           PRESENCE_IDENTITY_MISMATCH (403); none is online
 *   the signed-in user      join resolves and the user is in list()
 *   signed out, not left    the next heartbeat is refused with 401, and the
 *                           heartbeat stops
 *
 * How the module handles every answer, including late ones, is in
 * tests/unit/sdk-presence-refusals.spec.ts.
 */

import '@/tests/helpers/real-web-standard'

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import crypto, { randomUUID } from 'node:crypto'
import { format } from 'node:util'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'

import { BackenlyClient, BackenlyError } from '@backenly/sdk'
import { GET as nextList, POST as nextJoin, DELETE as nextLeave } from '@/app/api/v1/[projectId]/presence/route'
import app from '@/server/app'
import { prisma } from '@/lib/db'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'
import { hashApiKey } from '@/server/lib/end-user-identity'

const HEARTBEAT_MS = 25_000
/** The origin the in-process transport below answers for. */
const NEXT = 'https://next.backenly.test'

let ownerId = ''
let projectId = ''
let jwtSecret = ''
let publicKey = ''
let server: http.Server | undefined
let runtime = ''

const realFetch = globalThis.fetch
const realSetInterval = globalThis.setInterval

const userToken = (userId: string) =>
  jwt.sign({ userId, email: `${userId}@presence.test`, projectId, role: 'user', jti: randomUUID() }, jwtSecret, {
    algorithm: 'HS256',
    expiresIn: '1h',
  })

type Route = (request: NextRequest, props: { params: Promise<{ projectId: string }> }) => Promise<Response>
const NEXT_ROUTES: Record<string, Route> = { GET: nextList, POST: nextJoin, DELETE: nextLeave }

/** fetch, answered by the Next presence route in this process. Anything not addressed to NEXT goes to the network. */
const nextFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  if (url.origin !== NEXT) return realFetch(input, init)
  if (url.pathname !== `/api/v1/${projectId}/presence`) throw new Error(`no Next route for ${url.pathname}`)
  return NEXT_ROUTES[init?.method ?? 'GET'](new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]), {
    params: Promise.resolve({ projectId }),
  })
}) as typeof fetch

/** The user ids the client announced, in order, through `transport`. */
let announced: string[] = []
const counting = (transport: typeof fetch) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && String(input).endsWith('/presence')) announced.push(JSON.parse(String(init.body)).userId)
    return transport(input, init)
  }) as typeof fetch

/** The heartbeats the client scheduled, each fired by hand rather than every 25 seconds. */
let heartbeats: Array<{ beat: () => void; id: object }> = []
let cleared: jest.SpyInstance
let warn: jest.SpyInstance

async function until(done: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ownerId = (
    await prisma.user.create({
      data: { email: `sdk-presence-${randomUUID()}@example.test`, name: 'sdk presence refusals fixture' },
      select: { id: true },
    })
  ).id
  jwtSecret = crypto.randomBytes(32).toString('hex')
  projectId = (
    await prisma.project.create({
      data: { name: `sdk-presence-${randomUUID()}`, userId: ownerId, jwtSecret },
      select: { id: true },
    })
  ).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)

  // The key a browser app ships.
  publicKey = `proj_live_${crypto.randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'sdk presence refusals fixture', keyPrefix: publicKey.slice(0, 16), keyHash: hashApiKey(publicKey),
      keyType: 'public', serviceRole: false, permissions: ['read', 'write'], capabilities: [],
      projectId, userId: ownerId,
    },
  })

  server = http.createServer(app)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  runtime = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // join() is a browser call: it does nothing where there is no window. Set
  // after every import, so no server module sees it when it loads.
  const store = new Map<string, string>()
  Object.assign(globalThis, {
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  })
}, 180_000)

afterAll(async () => {
  delete (globalThis as any).window
  delete (globalThis as any).localStorage
  globalThis.fetch = realFetch
  await flushRecordedRequests().catch(() => {})
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  if (projectId) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

beforeEach(() => {
  announced = []
  heartbeats = []
  jest.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, ms?: number) => {
    if (ms !== HEARTBEAT_MS) return realSetInterval(handler, ms)
    const id = {}
    heartbeats.push({ beat: handler, id })
    return id
  }) as unknown as typeof setInterval)
  cleared = jest.spyOn(globalThis, 'clearInterval')
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  globalThis.fetch = realFetch
  jest.restoreAllMocks()
})

describe.each([
  ['the Next route (Next as the ingress, as on AWS)', NEXT],
  ['the runtime', 'runtime'],
])('through %s', (_, which) => {
  const base = () => (which === NEXT ? NEXT : runtime)
  /** The published client, signed in as `userId` when one is given. */
  const signedIn = (userId?: string) => {
    const client = new BackenlyClient({ projectId, apiKey: publicKey, apiUrl: base() })
    client.setUserToken(userId ? userToken(userId) : null)
    return client
  }
  const online = async () => (await signedIn().presence.list()).map((u) => u.userId)

  beforeEach(() => {
    globalThis.fetch = counting(which === NEXT ? nextFetch : realFetch)
  })

  it('rejects a join before sign-in with PRESENCE_TOKEN_REQUIRED, and starts no heartbeat', async () => {
    const userId = randomUUID()
    const joining = signedIn().presence.join(userId, { name: 'Ada' })

    await expect(joining).rejects.toBeInstanceOf(BackenlyError)
    await expect(joining).rejects.toMatchObject({ code: 'PRESENCE_TOKEN_REQUIRED', status: 401 })
    expect(heartbeats).toEqual([])
    expect(await online()).not.toContain(userId)
  })

  it.each([
    ['a username', 'ada_lovelace'],
    ['an email', 'ada@example.test'],
    ["'user-123', as the SDK's example once showed", 'user-123'],
  ])("rejects a join as %s, not the signed-in user's id, with PRESENCE_IDENTITY_MISMATCH", async (_label, claimed) => {
    const joining = signedIn(randomUUID()).presence.join(claimed, { name: 'Ada' })

    await expect(joining).rejects.toMatchObject({ code: 'PRESENCE_IDENTITY_MISMATCH', status: 403 })
    expect(heartbeats).toEqual([])
    expect(await online()).not.toContain(claimed)
  })

  it("resolves a join as the signed-in user's own id, and the user is online", async () => {
    const userId = randomUUID()
    const client = signedIn(userId)

    await expect(client.presence.join(userId, { name: 'Ada' })).resolves.toBeUndefined()
    expect(heartbeats).toHaveLength(1)
    expect(await online()).toContain(userId)
    await client.presence.leave()
  })

  it('stops the heartbeat when it is refused after the user signed out without leaving', async () => {
    const userId = randomUUID()
    const client = signedIn(userId)
    await client.presence.join(userId)
    client.setUserToken(null)

    heartbeats[0].beat()
    await until(() => cleared.mock.calls.some(([id]) => id === heartbeats[0].id))
    expect(announced).toEqual([userId, userId])
    expect(warn.mock.calls.map((call) => format(...call))).toEqual([
      `[Backenly Presence] Stopped announcing ${userId}, refused with PRESENCE_TOKEN_REQUIRED: ` +
        "Presence identifies callers by their sign-in. Send the end user's X-User-Token " +
        'together with the public key, or use a service-role key for server-side presence.',
    ])
  })
})
