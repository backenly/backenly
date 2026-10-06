/**
 * The SQL form of tableOfRequestPath gives the same answer as the function.
 *
 * Request-log aggregates group by the SQL form inside PostgreSQL; the observers
 * classify rows with the function. If they disagreed, a table's traffic would
 * be counted under one name and judged under another.
 */

import { prisma } from '@/lib/db'
import { tableOfRequestPath, tableOfRequestPathSql, nonTableSegmentsParam } from '@/lib/traffic/table-path'

afterAll(async () => {
  await prisma.$disconnect()
})

describe('tableOfRequestPathSql', () => {
  it('agrees with tableOfRequestPath on every shape', async () => {
    const paths = [
      '/db/orders',
      '/db/orders/1',
      '/api/v1/0b6d4c1e/db/orders',
      '/orders',
      '/orders/1',
      '/order_refunds?select=*',
      '/auth/x',
      '/rpc/f',
      '/storage/u',
      '/api/projects/abc/health',
      '/api',
      '/',
    ]
    const rows = await prisma.$queryRawUnsafe<Array<{ p: string; t: string | null }>>(
      `SELECT p, ${tableOfRequestPathSql('p', 1)} AS t FROM unnest($2::text[]) AS p`,
      nonTableSegmentsParam(),
      paths,
    )
    expect(rows.map(r => r.p)).toEqual(paths)
    for (const r of rows) expect([r.p, r.t]).toEqual([r.p, tableOfRequestPath(r.p)])
  })
})
