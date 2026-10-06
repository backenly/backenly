/**
 * Table traffic is recorded in two shapes, and both must count.
 *
 * PostgREST-native (v2) requests are recorded as `/<table>`; readers that only
 * matched `/db/<table>` saw none of them — including every client that reads a
 * split-out table by embedding it. v1's own routes are never mistaken for a
 * table, even one with the same name.
 */

import { tableOfRequestPath, NON_TABLE_SEGMENTS } from '@/lib/traffic/table-path'
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
    // The platform's own rows: never a table, unless an old full path names one.
    ['/api/projects/abc/health', null],
    ['/api', null],
    ['/', null],
  ])('%s → %s', (path, table) => {
    expect(tableOfRequestPath(path)).toBe(table)
    expect(requestTable(path)).toBe(table)
  })

  it('never takes a v1 route for a table', () => {
    expect(NON_TABLE_SEGMENTS).toContain('auth')
  })
})

// Its SQL form is held to the same answers against a real database in
// tests/integration/table-path-sql.spec.ts.
