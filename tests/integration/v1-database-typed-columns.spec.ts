/**
 * THE SDK'S DATA ROUTES WRITE AND FILTER EVERY COLUMN TYPE
 * ========================================================
 * /api/v1/{projectId}/database/insert, /update, /delete and /query are what
 * the SDK's create, update, delete and list call. They bound every value as a
 * bare placeholder, and Prisma binds a JS string as text, which PostgreSQL
 * will not assign to a uuid or timestamp column (42804) or compare with one
 * (42883). So an app could not insert a row with a uuid `owner_id`, update or
 * delete a row by its uuid `id`, or filter an integer column from a query
 * string: each answered 500 "Failed to …". Each value is now cast to its
 * column's type (lib/api/v1/typed-params.ts).
 *
 * The four routes run here against a real table holding each strictly-typed
 * column an app writes, because the defect lives in what PostgreSQL accepts.
 */

import '@/tests/helpers/real-web-standard'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { POST as insertRoute } from '@/app/api/v1/[projectId]/database/insert/route'
import { POST as updateRoute } from '@/app/api/v1/[projectId]/database/update/route'
import { POST as deleteRoute } from '@/app/api/v1/[projectId]/database/delete/route'
import { GET as queryGet, POST as queryPost } from '@/app/api/v1/[projectId]/database/query/route'
import { mintKey } from '@/lib/auth/key-prefix'
import { prisma } from '@/lib/db'
import { closeAllWorkspacePools } from '@/lib/services/workspace-pool'
import { hashApiKey } from '@/server/lib/end-user-identity'

const TABLE = 'typed_rows'
let ownerId = ''
let projectId = ''
let key = ''
const schema = () => `workspace_${projectId}`

type Route = (request: NextRequest, props: { params: Promise<{ projectId: string }> }) => Promise<Response>

/** A GET without a body, a POST with one; the key a server-side app would send. */
const call = (route: Route, path: string, body?: unknown) =>
  route(
    new NextRequest(`https://backenly.test/api/v1/${projectId}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ projectId }) },
  )

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  const user = await prisma.user.create({
    data: { email: `typed-columns-${randomUUID()}@example.test`, name: 'typed columns fixture' },
    select: { id: true },
  })
  ownerId = user.id
  const project = await prisma.project.create({
    data: { name: `typed-columns-${randomUUID()}`, userId: ownerId },
    select: { id: true },
  })
  projectId = project.id

  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema()}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema()}".${TABLE} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       owner_id uuid NOT NULL,
       due_at timestamptz,
       amount numeric(10, 2),
       qty integer,
       done boolean,
       meta jsonb,
       label text
     )`,
  )
  await prisma.table.create({ data: { name: TABLE, projectId } })

  const minted = mintKey({ keyType: 'public', serviceRole: true })
  key = minted.key
  await prisma.apiKey.create({
    data: {
      name: 'typed columns fixture', keyPrefix: minted.prefix, keyHash: hashApiKey(key), keyType: 'public',
      serviceRole: true, permissions: ['read', 'write', 'admin'], capabilities: ['database'],
      projectId, userId: ownerId,
    },
  })
})

afterAll(async () => {
  await closeAllWorkspacePools()
  if (projectId) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema()}" CASCADE`).catch(() => {})
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('the SDK data routes bind each value as its column type', () => {
  const owner = randomUUID()
  const due = '2026-10-18T10:00:00.000Z'
  let id = ''

  it('inserts a uuid, a timestamp, a numeric, an integer, a boolean and jsonb (create)', async () => {
    const res = await call(insertRoute, '/database/insert', {
      table: TABLE,
      data: { owner_id: owner, due_at: due, amount: 12.5, qty: 3, done: true, meta: { tier: 'gold' }, label: 'first' },
    })
    const body = await res.json()
    expect({ status: res.status, body }).toMatchObject({ status: 200 })
    const row = body.data.data
    expect(row.owner_id).toBe(owner)
    expect(new Date(row.due_at).toISOString()).toBe(due)
    expect(Number(row.amount)).toBe(12.5)
    expect(row.qty).toBe(3)
    expect(row.done).toBe(true)
    expect(row.meta).toEqual({ tier: 'gold' })
    id = row.id
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('filters a uuid, an integer and a boolean column from a query string (list)', async () => {
    for (const filter of [`owner_id=${owner}`, 'qty=3', 'done=true', `id=${id}`]) {
      const res = await call(queryGet, `/database/query?table=${TABLE}&${filter}`)
      const body = await res.json()
      expect({ filter, status: res.status }).toEqual({ filter, status: 200 })
      expect(body.data.data.map((r: { id: string }) => r.id)).toEqual([id])
    }
  })

  it('filters with operators on a timestamp, a uuid list and a text pattern (query)', async () => {
    const res = await call(queryPost, '/database/query', {
      table: TABLE,
      where: {
        owner_id: owner,
        due_at: { lt: '2100-01-01T00:00:00Z', gte: due },
        id: { in: [id, randomUUID()] },
        label: { contains: 'irs' },
      },
    })
    const body = await res.json()
    expect({ status: res.status, body }).toMatchObject({ status: 200 })
    expect(body.data.data.map((r: { id: string }) => r.id)).toEqual([id])
  })

  it('updates a row found by its uuid id, writing a timestamp and a boolean (update)', async () => {
    const later = '2026-11-01T09:30:00.000Z'
    const res = await call(updateRoute, '/database/update', { table: TABLE, where: { id }, data: { done: false, due_at: later } })
    const body = await res.json()
    expect({ status: res.status, body }).toMatchObject({ status: 200, body: { data: { updated: 1 } } })
    expect(body.data.data.done).toBe(false)
    expect(new Date(body.data.data.due_at).toISOString()).toBe(later)
  })

  it('deletes a row found by its uuid id (delete)', async () => {
    const res = await call(deleteRoute, '/database/delete', { table: TABLE, where: { id } })
    const body = await res.json()
    expect({ status: res.status, body }).toMatchObject({ status: 200, body: { data: { deleted: 1 } } })
    const left = await prisma.$queryRawUnsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM "${schema()}".${TABLE}`)
    expect(left[0].count).toBe(0)
  })
})
