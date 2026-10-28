/**
 * THE SDK'S FILTERS MEAN THE SAME ON BOTH SERVERS
 * ===============================================
 * Two servers answer /api/v1/{projectId}/database/query, /insert, /update and
 * /delete: the Next routes wherever Next is the ingress, as on AWS, and the
 * runtime (server/routes/database.ts) where traffic reaches it first, as on a
 * self-hosted install. Each built its filters on its own, and each got a
 * different part wrong:
 *
 *   the Next query route compared a null with `=`, so isNull() and
 *   isNotNull() matched no row, and its update and delete knew only
 *   equality, so update().isNull() changed nothing and delete().in() failed;
 *
 *   the runtime bound every value uncast, which PostgreSQL refuses for a
 *   uuid, timestamp, integer or boolean column, so get(id), update(id),
 *   delete(id) and any filter on such a column answered 500.
 *
 * Both answered a value its column cannot take, or a duplicate, with 500, and
 * a filter they could not apply was skipped: the runtime then updated every
 * row. Both now build the filter in one place (lib/api/v1/where.ts) and answer
 * those 400 or 409 (lib/api/v1/data-errors.ts).
 *
 * The published client is driven against both servers on a real table.
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
import { GET as queryGet, POST as queryRoute } from '@/app/api/v1/[projectId]/database/query/route'
import app from '@/server/app'
import { mintKey } from '@/lib/auth/key-prefix'
import { prisma } from '@/lib/db'
import { closeAllWorkspacePools } from '@/lib/services/workspace-pool'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'
import { hashApiKey } from '@/server/lib/end-user-identity'

interface Task {
  id: string
  title: string
  owner_id: string | null
  due_at: string | null
  qty: number | null
  done: boolean
}

const TABLE = 'tasks'
/** The origin the in-process transport below answers for. */
const NEXT = 'https://next.backenly.test'
const OWNER = randomUUID()

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
  new BackenlyClient({ projectId, apiKey: key, apiUrl }) as BackenlyClient & { tasks: TableClient<Task> }

/** A raw request, to see the status and the answer rather than what the client makes of them. */
const post = (base: string, path: string, body: unknown) =>
  (base === NEXT ? nextFetch : realFetch)(`${base}/api/v1/${projectId}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** The titles a select resolved, in order. */
const titles = (result: { data: Task[] }) => result.data.map((task) => task.title).sort()

/** Every row as it stands, to see that a refused request changed nothing. */
const snapshot = () =>
  prisma.$queryRawUnsafe<Array<{ title: string; qty: number | null; done: boolean }>>(
    `SELECT title, qty, done FROM "${schema()}".${TABLE} ORDER BY title`,
  )

/** Three rows: two owned, one with no owner, due date or a single quantity in common. */
async function seed(): Promise<Record<string, string>> {
  await prisma.$executeRawUnsafe(`TRUNCATE "${schema()}".${TABLE}`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema()}".${TABLE} (title, owner_id, due_at, qty, done) VALUES
       ('owned early', $1::uuid, '2026-01-10T00:00:00Z', 1, false),
       ('owned late',  $1::uuid, '2026-06-10T00:00:00Z', 5, true),
       ('unowned',     NULL,     NULL,                   3, false)`,
    OWNER,
  )
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; title: string }>>(
    `SELECT id::text AS id, title FROM "${schema()}".${TABLE}`,
  )
  return Object.fromEntries(rows.map((row) => [row.title, row.id]))
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ownerId = (
    await prisma.user.create({
      data: { email: `sdk-filters-${randomUUID()}@example.test`, name: 'sdk filters fixture' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `sdk-filters-${randomUUID()}`, userId: ownerId },
      select: { id: true },
    })
  ).id

  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema()}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema()}".${TABLE} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       title text NOT NULL UNIQUE,
       owner_id uuid,
       due_at timestamptz,
       qty integer,
       done boolean NOT NULL DEFAULT false
     )`,
  )
  await prisma.table.create({ data: { name: TABLE, projectId } })
  // Soft-deletable without "updatedAt", as a table an agent created by its own SQL can be.
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema()}".notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, deleted_at timestamptz)`,
  )
  await prisma.table.create({ data: { name: 'notes', projectId } })
  // Soft-deletable with "updatedAt" (no default, so a stamp is the delete's), as Backenly's own tables are.
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema()}".stamped (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, deleted_at timestamptz, "updatedAt" timestamptz)`,
  )
  await prisma.table.create({ data: { name: 'stamped', projectId } })

  // A server-side key, as a server-rendered app would hold.
  const minted = mintKey({ keyType: 'public', serviceRole: true })
  key = minted.key
  await prisma.apiKey.create({
    data: {
      name: 'sdk filters fixture', keyPrefix: minted.prefix, keyHash: hashApiKey(key), keyType: 'public',
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

describe.each([
  ['the Next routes (Next as the ingress, as on AWS)', () => NEXT],
  ['the runtime (traffic reaching it first, as self-hosted)', () => runtime],
])('through %s', (_label, base) => {
  let ids: Record<string, string> = {}
  const tasks = () => sdk(base()).from<Task>(TABLE)

  beforeEach(async () => {
    globalThis.fetch = base() === NEXT ? nextFetch : realFetch
    ids = await seed()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('isNull() and isNotNull() match the rows without and with a value', async () => {
    expect(titles(await tasks().select().isNull('owner_id'))).toEqual(['unowned'])
    expect(titles(await tasks().select().isNotNull('owner_id'))).toEqual(['owned early', 'owned late'])
    expect(await sdk(base()).tasks.count({ due_at: null })).toBe(1)
  })

  it('filters a uuid, a timestamp, an integer and a boolean column', async () => {
    expect(titles(await tasks().select().eq('owner_id', OWNER))).toEqual(['owned early', 'owned late'])
    expect(titles(await tasks().select().gt('due_at', '2026-03-01T00:00:00Z'))).toEqual(['owned late'])
    expect(titles(await tasks().select().neq('qty', 1))).toEqual(['owned late', 'unowned'])
    expect(titles(await tasks().select().eq('done', true))).toEqual(['owned late'])
    expect(titles(await tasks().select().in('id', [ids['unowned'], randomUUID()]))).toEqual(['unowned'])
    expect(titles(await tasks().select().in('id', []))).toEqual([])
  })

  it('get(), update() and delete() find a row by its uuid id', async () => {
    const client = sdk(base()).tasks
    expect(await client.get(ids['owned early'])).toMatchObject({ title: 'owned early', qty: 1 })
    expect(await client.update(ids['owned early'], { qty: 2 })).toMatchObject({ title: 'owned early', qty: 2 })
    expect(await client.delete(ids['owned early'])).toEqual({ success: true, deleted: 1 })
    expect(await client.get(ids['owned early'])).toBeNull()
  })

  it('an update applies isNull(), and a delete applies in()', async () => {
    expect(await tasks().update({ done: true }).isNull('owner_id').execute()).toMatchObject({ updated: 1 })
    expect(await tasks().delete().in('id', [ids['owned late'], randomUUID()]).execute()).toEqual({ success: true, deleted: 1 })
    expect(await snapshot()).toEqual([
      { title: 'owned early', qty: 1, done: false },
      { title: 'unowned', qty: 3, done: true },
    ])
  })

  it('a value its column cannot take answers 400 naming the column, not 500', async () => {
    for (const path of ['/database/query', '/database/delete']) {
      const res = await post(base(), path, { table: TABLE, where: { id: 'not-a-uuid' } })
      const body = await res.json()
      expect({ path, status: res.status, error: body.error }).toMatchObject({
        path,
        status: 400,
        error: { code: 'VALIDATION_ERROR', details: { column: 'id', expected: 'uuid' } },
      })
    }
    expect(await snapshot()).toHaveLength(3)
  })

  it('a duplicate of a unique value answers 409', async () => {
    const res = await post(base(), '/database/insert', { table: TABLE, data: { title: 'unowned' } })
    expect({ status: res.status, code: (await res.json()).error?.code }).toEqual({ status: 409, code: 'CONFLICT' })
  })

  it('a filter it cannot apply is refused, and an update or delete with one changes nothing', async () => {
    const before = await snapshot()
    for (const where of [{ title: { equals: 'unowned' } }, { 'title; --': 'unowned' }, { qty: {} }, { qty: { in: 3 } }]) {
      for (const [path, body] of [
        ['/database/query', { table: TABLE, where }],
        ['/database/update', { table: TABLE, where, data: { qty: 99 } }],
        ['/database/delete', { table: TABLE, where }],
      ] as const) {
        const res = await post(base(), path, body)
        const answer = await res.json()
        expect({ path, where, status: res.status, code: answer.error?.code }).toEqual({
          path, where, status: 400, code: 'VALIDATION_ERROR',
        })
      }
    }
    expect(await snapshot()).toEqual(before)
  })

  // The SDK wrote each filter over the one before it on the same column, so
  // this range sent only its last bound and the update or delete reached every
  // row on one side of it.
  it('a range on one column applies both bounds, in a select, an update and a delete', async () => {
    expect(titles(await tasks().select().gte('qty', 2).lt('qty', 5))).toEqual(['unowned'])
    expect(await tasks().update({ done: true }).gte('qty', 2).lt('qty', 5).execute()).toMatchObject({ updated: 1 })
    expect(await tasks().delete().gt('qty', 1).lte('qty', 3).execute()).toEqual({ success: true, deleted: 1 })
    expect(await snapshot()).toEqual([
      { title: 'owned early', qty: 1, done: false },
      { title: 'owned late', qty: 5, done: true },
    ])
  })

  it('two filters that cannot be sent together on one column are refused, and nothing changes', async () => {
    const before = await snapshot()
    await expect(tasks().delete().eq('qty', 3).gt('qty', 0).execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(tasks().update({ qty: 99 }).gt('qty', 0).gt('qty', 2).execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(tasks().select().isNull('owner_id').neq('owner_id', OWNER)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(tasks().delete().like('title', 'own').ilike('title', 'OWN').execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(tasks().delete().neq('qty', 1).isNotNull('qty').execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(await snapshot()).toEqual(before)
  })

  // JSON leaves out a key whose value is undefined, and sends NaN and Infinity
  // as null: the filter was lost, or became IS NULL, while the others applied.
  it('a filter whose value JSON cannot carry is refused, and nothing changes', async () => {
    const before = await snapshot()
    await expect(tasks().delete().eq('id', undefined).eq('done', false).execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(tasks().update({ qty: 99 }).gt('qty', undefined).lt('qty', 5).execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(tasks().delete().eq('qty', Number.NaN).execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(tasks().delete().in('qty', [1, Number.POSITIVE_INFINITY]).execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    // An invalid Date became null, so neq() was IS NOT NULL; a function was left out; a bigint threw uncoded.
    await expect(tasks().delete().neq('due_at', new Date('not a date')).execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(tasks().delete().eq('id', () => 1).eq('done', false).execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(tasks().delete().eq('qty', BigInt(3)).execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(tasks().delete().in('qty', [[1, undefined]]).execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(await snapshot()).toEqual(before)
  })

  it('in() and a range on one column both apply', async () => {
    expect(await tasks().delete().in('qty', [1, 3, 5]).gt('qty', 2).execute()).toEqual({ success: true, deleted: 2 })
    expect(await snapshot()).toEqual([{ title: 'owned early', qty: 1, done: false }])
  })

  it('an update with no condition is refused, and changes nothing', async () => {
    const before = await snapshot()
    await expect(tasks().update({ qty: 99 }).execute()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    for (const body of [{ table: TABLE, data: { qty: 99 } }, { table: TABLE, where: {}, data: { qty: 99 } }]) {
      const res = await post(base(), '/database/update', body)
      expect({ body, status: res.status, code: (await res.json()).error?.code }).toEqual({
        body, status: 400, code: 'VALIDATION_ERROR',
      })
    }
    expect(await snapshot()).toEqual(before)
  })
})

describe('the Next delete route on a table with deleted_at and no "updatedAt"', () => {
  it('soft-deletes the row instead of failing on the missing column', async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE "${schema()}".notes`)
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema()}".notes (title) VALUES ('keep'), ('drop')`)
    globalThis.fetch = nextFetch
    try {
      expect(await sdk(NEXT).from('notes').delete().eq('title', 'drop').execute()).toEqual({ success: true, deleted: 1 })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(
      await prisma.$queryRawUnsafe(`SELECT title, deleted_at IS NOT NULL AS deleted FROM "${schema()}".notes ORDER BY title`),
    ).toEqual([{ title: 'drop', deleted: true }, { title: 'keep', deleted: false }])
  })

  it('still stamps "updatedAt" on a table that has it, as every table Backenly creates does', async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE "${schema()}".stamped`)
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema()}".stamped (title) VALUES ('keep'), ('drop')`)
    globalThis.fetch = nextFetch
    try {
      expect(await sdk(NEXT).from('stamped').delete().eq('title', 'drop').execute()).toEqual({ success: true, deleted: 1 })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(
      await prisma.$queryRawUnsafe(
        `SELECT title, deleted_at IS NOT NULL AS deleted, "updatedAt" IS NOT NULL AS stamped FROM "${schema()}".stamped ORDER BY title`,
      ),
    ).toEqual([{ title: 'drop', deleted: true, stamped: true }, { title: 'keep', deleted: false, stamped: false }])
  })
})

describe('the Next query route from a query string', () => {
  beforeEach(async () => {
    await seed()
  })

  it('answers a value its column cannot take with 400 naming the column', async () => {
    const res = await queryGet(
      new NextRequest(`${NEXT}/api/v1/${projectId}/database/query?table=${TABLE}&qty=many`, {
        headers: { 'x-api-key': key },
      }),
      { params: Promise.resolve({ projectId }) },
    )
    const body = await res.json()
    expect({ status: res.status, error: body.error }).toMatchObject({
      status: 400,
      error: { code: 'VALIDATION_ERROR', details: { column: 'qty', expected: 'integer' } },
    })
  })
})
