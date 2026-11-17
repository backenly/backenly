/**
 * The Database page's rows read (GET /api/database/rows), two truths:
 *
 * 1. It withholds secret columns exactly as the read-only SQL path does
 *    (lib/mcp/read-query.ts redactRows), and names them. The grid showed the
 *    end-user `users` table's password hashes, which the SQL tab never did
 *    (project console rebuild, Data B1).
 * 2. A column filter compares the column as text. The RLS session layer binds
 *    parameters as text, so `"id" = $1` on a uuid column was a 42883 and
 *    every filter but one on a text column failed; updateRow and deleteRow
 *    already cast the id the same way.
 *
 * Database-free: the route's wrapper and the rows read are stubbed, and the
 * filter's SQL is read from the statement handed to the RLS layer.
 */

jest.mock('@/lib/auth/route-protection', () => ({
  withProjectAccess: (handler: any) => async (request: any) =>
    handler(request, { user: { userId: 'u_owner' }, project: { id: 'p1' }, projectId: 'p1' }),
}))

const ROWS = [
  { id: 'a1', email: 'maya@example.com', password: '$2b$10$hash-one', api_key: null, name: 'Maya' },
  { id: 'a2', email: 'leo@example.com', password: '$2b$10$hash-two', api_key: 'k_live_2', name: 'Leo' },
]

const statements: Array<{ sql: string; values: unknown[] }> = []
jest.mock('@/lib/services/workspace-rls', () => ({
  executeWithUserContext: jest.fn(async (_p: string, _u: string, _s: boolean, sql: string, values: unknown[]) => {
    statements.push({ sql, values })
    return /COUNT\(\*\)/.test(sql) ? [{ count: BigInt(ROWS.length) }] : ROWS
  }),
}))
jest.mock('@/lib/data-plane/regional', () => ({ workspaceRawClient: jest.fn(), projectDatabaseUrl: jest.fn() }))
jest.mock('@/lib/db/postgres', () => ({ prisma: {} }))
jest.mock('@/lib/db/mongodb', () => ({ getMongoDB: jest.fn(), getCollection: jest.fn() }))
jest.mock('@/lib/db', () => ({ prisma: {} }))
jest.mock('@/lib/services/databaseProvisioning', () => ({ getWorkspaceDatabaseNames: jest.fn() }))
jest.mock('@/lib/services/workspaceDatabase', () => ({ getWorkspaceMongoDB: jest.fn() }))
jest.mock('@/lib/services/workspace-table-stats', () => ({ invalidateTableStats: jest.fn() }))
jest.mock('@/lib/services/direct-access', () => ({ readOnlyLogin: jest.fn() }))

import { GET } from '@/app/api/database/rows/route'

function get(query: string): any {
  const url = new URL(`http://localhost/api/database/rows?${query}`)
  return { url: url.href, nextUrl: url, headers: new Headers(), method: 'GET' }
}

beforeEach(() => {
  statements.length = 0
})

it('withholds secret columns like the SQL path, and names them', async () => {
  const res = await GET(get('type=postgresql&schema=workspace_p1&table=users&projectId=p1'), {} as any)
  const body = await res.json()
  expect(res.status).toBe(200)
  expect(body.redactedColumns).toEqual(['password', 'api_key'])
  expect(body.data.map((r: any) => r.password)).toEqual(['[redacted]', '[redacted]'])
  // A NULL stays NULL: withheld and empty must not read the same.
  expect(body.data.map((r: any) => r.api_key)).toEqual([null, '[redacted]'])
  expect(body.data[0]).toMatchObject({ id: 'a1', email: 'maya@example.com', name: 'Maya' })
})

it('names nothing when no column is secret', async () => {
  const res = await GET(get('type=postgresql&schema=workspace_p1&table=movies&projectId=p1&sortBy=title'), {} as any)
  const body = await res.json()
  expect(body.redactedColumns).toEqual(expect.any(Array))
  expect(body.pagination).toMatchObject({ total: 2, page: 1 })
})

it('compares a filtered column as text, so a uuid or number column can be filtered', async () => {
  await GET(get('type=postgresql&schema=workspace_p1&table=reviews&projectId=p1&movie_id=m0000001-4c1e&rating=5'), {} as any)
  const where = statements.map((s) => s.sql).find((sql) => /WHERE/.test(sql)) ?? ''
  expect(where).toMatch(/"movie_id"::text = \$1/)
  expect(where).toMatch(/"rating"::text = \$2/)
  // Still parameterised: the values never enter the statement's text.
  expect(where).not.toContain('m0000001-4c1e')
  expect(statements[0].values).toEqual(['m0000001-4c1e', '5'])
})

// 3. Only the project's own rows. The connection that reads and writes rows is
// the platform's own, so every route refuses any schema but the project's
// workspace schema before a statement runs, and MongoDB never reaches the
// platform's database.
describe("only the project's own rows", () => {
  const { POST } = require('@/app/api/database/rows/route')
  const rowRoute = require('@/app/api/database/rows/[rowId]/route')
  const { getCollection } = require('@/lib/db/mongodb')
  const { getWorkspaceMongoDB } = require('@/lib/services/workspaceDatabase')

  function withBody(method: string, path: string, body: unknown): any {
    const url = new URL(`http://localhost${path}`)
    return { url: url.href, nextUrl: url, headers: new Headers(), method, json: async () => body }
  }

  beforeEach(() => {
    getCollection.mockClear()
    getWorkspaceMongoDB.mockClear()
  })

  it.each(['public', 'pg_catalog', 'workspace_p2', 'workspace_p1_br_x', ''])('GET refuses schema %p and runs nothing', async (schema) => {
    const res = await GET(get(`type=postgresql&schema=${schema}&table=users&projectId=p1`), {} as any)
    expect(res.status).toBe(403)
    expect(statements).toEqual([])
  })

  it('GET with no schema is refused, not read from the platform', async () => {
    const res = await GET(get('type=postgresql&table=users&projectId=p1'), {} as any)
    expect(res.status).toBe(403)
    expect(statements).toEqual([])
  })

  it("GET of a MongoDB collection asks the project's own database, whatever the view", async () => {
    await GET(get('type=mongodb&view=platform&table=users&projectId=p1'), {} as any)
    expect(getWorkspaceMongoDB).toHaveBeenCalledWith('p1')
    expect(getCollection).not.toHaveBeenCalled()
  })

  it.each(['public', 'workspace_p2', undefined])('POST refuses schema %p and inserts nothing', async (schema) => {
    const res = await POST(withBody('POST', '/api/database/rows', { type: 'postgresql', schema, table: 'users', data: { email: 'x@example.com' } }), {} as any)
    expect(res.status).toBe(403)
    expect(statements).toEqual([])
  })

  it('POST refuses a type it does not know', async () => {
    const res = await POST(withBody('POST', '/api/database/rows', { type: 'sqlite', schema: 'workspace_p1', table: 't', data: { a: 1 } }), {} as any)
    expect(res.status).toBe(400)
    expect(statements).toEqual([])
  })

  it.each(['public', 'workspace_p2', ''])('PUT and DELETE refuse schema %p and change nothing', async (schema) => {
    const put = await rowRoute.PUT(withBody('PUT', `/api/database/rows/r1?type=postgresql&table=users&schema=${schema}&projectId=p1`, { data: { name: 'x' } }), {} as any)
    const del = await rowRoute.DELETE(withBody('DELETE', `/api/database/rows/r1?type=postgresql&table=users&schema=${schema}&projectId=p1`, {}), {} as any)
    expect(put.status).toBe(403)
    expect(del.status).toBe(403)
    expect(statements).toEqual([])
  })

  it('PUT and DELETE do not edit MongoDB documents through the platform database', async () => {
    const put = await rowRoute.PUT(withBody('PUT', '/api/database/rows/r1?type=mongodb&table=users&projectId=p1', { data: { name: 'x' } }), {} as any)
    const del = await rowRoute.DELETE(withBody('DELETE', '/api/database/rows/r1?type=mongodb&table=users&projectId=p1', {}), {} as any)
    expect(put.status).toBe(400)
    expect(del.status).toBe(400)
    expect(getCollection).not.toHaveBeenCalled()
  })

  it("a quote in a table or column name stays inside one identifier", async () => {
    const put = await rowRoute.PUT(
      withBody('PUT', `/api/database/rows/r1?type=postgresql&table=${encodeURIComponent('t" SET x=1; --')}&schema=workspace_p1&projectId=p1`, { data: { 'a" = 1, "b': 'v' } }),
      {} as any,
    )
    expect(put.status).toBe(200)
    const update = statements.map((s) => s.sql).find((sql) => /^UPDATE/.test(sql)) ?? ''
    expect(update).toContain('"workspace_p1"."t"" SET x=1; --"')
    expect(update).toContain('SET "a"" = 1, ""b" = $1')
    expect(statements.find((s) => /^UPDATE/.test(s.sql))?.values).toEqual(['v', 'r1'])
  })

  it('the own schema still updates and deletes a row', async () => {
    const put = await rowRoute.PUT(withBody('PUT', '/api/database/rows/r1?type=postgresql&table=users&schema=workspace_p1&projectId=p1', { data: { is_blocked: true } }), {} as any)
    const del = await rowRoute.DELETE(withBody('DELETE', '/api/database/rows/r1?type=postgresql&table=users&schema=workspace_p1&projectId=p1', {}), {} as any)
    expect(put.status).toBe(200)
    expect(del.status).toBe(200)
    expect(statements.map((s) => s.sql)).toEqual([
      expect.stringMatching(/^UPDATE "workspace_p1"\."users" SET "is_blocked" = \$1 WHERE "id"::text = \$2/),
      expect.stringMatching(/^DELETE FROM "workspace_p1"\."users" WHERE "id"::text = \$1/),
    ])
  })
})

// #785's thumbnail delete: the recorded path is deleted only when it is the one
// storage processing makes beside the file.
describe('the thumbnail a file delete removes', () => {
  const { ownThumbnailPath } = require('@/lib/services/storage')
  const path = require('path')
  const file = path.join(path.sep, 'storage', 'p1', 'bucket', 'photo-1a2b.png')
  const thumb = path.join(path.sep, 'storage', 'p1', 'bucket', 'thumb_photo-1a2b.webp')

  it('is the thumbnail processing made', () => {
    expect(ownThumbnailPath(file, { thumbnailPath: thumb })).toBe(path.resolve(thumb))
  })

  it.each([
    path.join(path.sep, 'app', '.next', 'BUILD_ID'),
    path.join(path.sep, 'storage', 'p2', 'bucket', 'thumb_photo-1a2b.webp'),
    path.join(path.sep, 'storage', 'p1', 'bucket', '..', 'other', 'thumb_photo-1a2b.webp'),
    path.join(path.sep, 'storage', 'p1', 'bucket', 'photo-1a2b.png'),
  ])('is nothing when the record names %p', (recorded) => {
    expect(ownThumbnailPath(file, { thumbnailPath: recorded })).toBeNull()
  })

  it('is nothing without a record or a file path', () => {
    expect(ownThumbnailPath(file, null)).toBeNull()
    expect(ownThumbnailPath(file, { thumbnailPath: 7 })).toBeNull()
    expect(ownThumbnailPath(null, { thumbnailPath: thumb })).toBeNull()
  })
})
