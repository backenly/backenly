/**
 * Table traffic is recorded in two shapes, and both must count.
 *
 * PostgREST-native (v2) requests are recorded as `/<table>`; readers that only
 * matched `/db/<table>` saw none of them — including every client that reads a
 * split-out table by embedding it. v1's own routes are never mistaken for a
 * table, even one with the same name.
 */

import { prisma } from '@/lib/db'
import { tableOfRequestPath, tableOfRequestPathSql, nonTableSegmentsParam, NON_TABLE_SEGMENTS } from '@/lib/traffic/table-path'
import { requestTable } from '@/lib/autonomy/subsystem-recurrence'

describe('tableOfRequestPath', () => {
  it.each([
    ['/db/orders', 'orders'],
    ['/db/orders/123', 'orders'],
    ['/db/orders/vector-search', 'orders'],
    ['/api/v1/0b6d4c1e/db/orders', 'orders'],
    ['/orders', 'orders'],
    ['/orders/123', 'orders'],
    ['/order_refunds?select=*', 'order_refunds'],
    ['/auth/sign-in', null],
    ['/storage/upload', null],
    ['/fn/send-mail', null],
    ['/rpc/my_function', null],
    ['/database/query', null],
    ['/', null],
  ])('%s → %s', (path, table) => {
    expect(tableOfRequestPath(path)).toBe(table)
    expect(requestTable(path)).toBe(table)
  })

  it('agrees with its SQL form', async () => {
    const paths = ['/db/orders', '/db/orders/1', '/orders', '/orders/1', '/auth/x', '/rpc/f', '/storage/u', '/']
    const rows = await prisma.$queryRawUnsafe<Array<{ p: string; t: string | null }>>(
      `SELECT p, ${tableOfRequestPathSql('p', 1)} AS t FROM unnest($2::text[]) AS p`,
      nonTableSegmentsParam(),
      paths,
    )
    for (const r of rows) expect(r.t).toBe(tableOfRequestPath(r.p))
    expect(NON_TABLE_SEGMENTS).toContain('auth')
  })
})
