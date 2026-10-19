/**
 * THE SDK'S DATA METHODS, THROUGH THE ROUTES THAT SERVE THEM
 * ==========================================================
 * The data routes answer `{ data: <result> }`, and each result carries its rows
 * under a `data` of its own. The SDK read one level too few: create() and
 * update() resolved `{ data: row }`, so `(await backend.notes.create(...)).id`
 * was undefined, and delete() and the query builder resolved the whole answer.
 *
 * Two servers answer these paths. The Next routes
 * (app/api/v1/[projectId]/database/*) serve them wherever Next is the ingress,
 * as on AWS. The runtime (server/routes/database.ts) serves them where traffic
 * reaches it first. The client is driven through each against a real table,
 * and each one's insert answer is pinned, because that shape is what
 * packages/sdk/src/database.ts reads. Several rows are inserted only through
 * the runtime: the Next route's schema takes one row.
 */

import '@/tests/helpers/real-web-standard'

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'

import { BackenlyClient, type TableClient } from '@backenly/sdk'
import { POST as insertRoute } from '@/app/api/v1/[projectId]/database/insert/route'
import { POST as updateRoute } from '@/app/api/v1/[projectId]/database/update/route'
import { POST as deleteRoute } from '@/app/api/v1/[projectId]/database/delete/route'
import { POST as queryRoute } from '@/app/api/v1/[projectId]/database/query/route'
import app from '@/server/app'
import { mintKey } from '@/lib/auth/key-prefix'
import { prisma } from '@/lib/db'
import { closeAllWorkspacePools } from '@/lib/services/workspace-pool'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'
import { hashApiKey } from '@/server/lib/end-user-identity'

interface Note {
  id: string
  title: string
  done: boolean
}

const TABLE = 'notes'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The origin the in-process transport below answers for. */
const NEXT = 'https://next.backenly.test'

let ownerId = ''
let projectId = ''
let key = ''
let server: http.Server | undefined
let runtime = ''
const schema = () => `workspace_${projectId}`

type Route = (request: NextRequest, props: { params: Promise<{ projectId: string }> }) => Promise<Response>
const NEXT_ROUTES: Record<string, Route> = {
  '/database/insert': insertRoute,
  '/database/update': updateRoute,
  '/database/delete': deleteRoute,
  '/database/query': queryRoute,
}

const realFetch = globalThis.fetch

/**
 * fetch, answered by the Next route handlers in this process: the request the
 * SDK builds goes to the handler as a NextRequest and the handler's own
 * Response comes back. Anything not addressed to NEXT goes to the network.
 */
const nextFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  if (url.origin !== NEXT) return realFetch(input, init)
  const route = NEXT_ROUTES[url.pathname.slice(`/api/v1/${projectId}`.length)]
  if (!route) throw new Error(`no Next route for ${url.pathname}`)
  return route(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]), {
    params: Promise.resolve({ projectId }),
  })
}) as typeof fetch

/** The published client, pointed at one of the two servers. */
const sdk = (apiUrl: string) =>
  new BackenlyClient({ projectId, apiKey: key, apiUrl }) as BackenlyClient & { notes: TableClient<Note> }

/** A raw insert, to see the answer itself rather than what the client makes of it. */
const insert = (base: string, data: unknown) =>
  (base === NEXT ? nextFetch : realFetch)(`${base}/api/v1/${projectId}/database/insert`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ table: TABLE, data }),
  })

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ownerId = (
    await prisma.user.create({
      data: { email: `sdk-data-routes-${randomUUID()}@example.test`, name: 'sdk data routes fixture' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `sdk-data-routes-${randomUUID()}`, userId: ownerId },
      select: { id: true },
    })
  ).id

  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema()}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema()}".${TABLE} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       title text NOT NULL,
       done boolean NOT NULL DEFAULT false
     )`,
  )
  await prisma.table.create({ data: { name: TABLE, projectId } })

  // A server-side key, as a server-rendered app would hold.
  const minted = mintKey({ keyType: 'public', serviceRole: true })
  key = minted.key
  await prisma.apiKey.create({
    data: {
      name: 'sdk data routes fixture', keyPrefix: minted.prefix, keyHash: hashApiKey(key), keyType: 'public',
      serviceRole: true, permissions: ['read', 'write', 'admin'], capabilities: ['database'],
      projectId, userId: ownerId,
    },
  })

  server = http.createServer(app)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  runtime = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 180_000)

afterAll(async () => {
  globalThis.fetch = realFetch
  await flushRecordedRequests().catch(() => {})
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  await closeAllWorkspacePools()
  if (projectId) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema()}" CASCADE`).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe('through the Next routes (Next as the ingress, as on AWS)', () => {
  let id = ''

  beforeEach(() => {
    globalThis.fetch = nextFetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('answers an insert with { data: { data: row } }', async () => {
    const res = await insert(NEXT, { title: 'pinned' })
    const body = await res.json()
    expect({ status: res.status, body }).toEqual({
      status: 200,
      body: { data: { data: { id: expect.stringMatching(UUID), title: 'pinned', done: false } } },
    })
  })

  it('create() returns the inserted row', async () => {
    const row = await sdk(NEXT).notes.create({ title: 'first' })
    expect(row).toEqual({ id: expect.stringMatching(UUID), title: 'first', done: false })
    id = row.id
  })

  it('get(), list() and count() read it back', async () => {
    const notes = sdk(NEXT).notes
    expect(await notes.get(id)).toEqual({ id, title: 'first', done: false })
    expect((await notes.list()).map((n) => n.title).sort()).toEqual(['first', 'pinned'])
    expect(await notes.count({ title: 'first' })).toBe(1)
  })

  it('update() returns the updated row', async () => {
    expect(await sdk(NEXT).notes.update(id, { done: true })).toEqual({ id, title: 'first', done: true })
  })

  it('the query builder resolves { data: rows, count } for a select and { data, updated } for an update', async () => {
    const backend = sdk(NEXT)
    expect(await backend.from<Note>(TABLE).select().eq('id', id)).toEqual({
      data: [{ id, title: 'first', done: true }],
      count: 1,
    })
    expect(await backend.from<Note>(TABLE).update({ title: 'renamed' }).eq('id', id).execute()).toEqual({
      data: { id, title: 'renamed', done: true },
      updated: 1,
    })
  })

  it('delete() resolves { success: true, deleted: 1 } and the row is gone', async () => {
    const notes = sdk(NEXT).notes
    expect(await notes.delete(id)).toEqual({ success: true, deleted: 1 })
    expect(await notes.get(id)).toBeNull()
  })
})

describe('through the runtime (server/routes/database.ts)', () => {
  it('answers an insert with { data: { data: row } } for one row and { data: { data: rows } } for several', async () => {
    const one = await insert(runtime, { title: 'runtime one' })
    expect({ status: one.status, body: await one.json() }).toEqual({
      status: 200,
      body: { data: { data: { id: expect.stringMatching(UUID), title: 'runtime one', done: false } } },
    })

    const several = await insert(runtime, [{ title: 'runtime two' }, { title: 'runtime three' }])
    expect({ status: several.status, body: await several.json() }).toEqual({
      status: 200,
      body: {
        data: {
          data: [
            { id: expect.stringMatching(UUID), title: 'runtime two', done: false },
            { id: expect.stringMatching(UUID), title: 'runtime three', done: false },
          ],
        },
      },
    })
  })

  it('create() returns the inserted row', async () => {
    const row = await sdk(runtime).notes.create({ title: 'runtime four' })
    expect(row).toEqual({ id: expect.stringMatching(UUID), title: 'runtime four', done: false })
  })

  it('the query builder resolves { data: rows } for an insert of several', async () => {
    const result = await sdk(runtime)
      .from<Note>(TABLE)
      .insert([{ title: 'runtime five' }, { title: 'runtime six' }] as Note[])
      .execute()
    expect(result).toEqual({
      data: [
        { id: expect.stringMatching(UUID), title: 'runtime five', done: false },
        { id: expect.stringMatching(UUID), title: 'runtime six', done: false },
      ],
    })
  })

  it('list() reads the rows back', async () => {
    const titles = (await sdk(runtime).notes.list({ limit: 100 })).map((n) => n.title)
    expect(titles).toEqual(expect.arrayContaining(['runtime one', 'runtime two', 'runtime four', 'runtime six']))
  })
})
