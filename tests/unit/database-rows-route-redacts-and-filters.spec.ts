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
