/**
 * WHICH RESPONSES SAY /db IS DEPRECATED, AND WHERE THEY POINT
 * ===========================================================
 *
 * /api/v2/{projectId}/{table} is the project's one REST API (production QA,
 * #22: two dialects over the same tables). /db keeps working for existing apps
 * and marks every response the standard way: Deprecation (RFC 9745, a
 * Structured Field Date) and Link rel="successor-version" (RFC 5829) to the
 * same table on /api/v2. The servers that send them are pinned in
 * tests/integration/v1-db-deprecated-on-both-servers.spec.ts; this is the rule.
 */

import { V1_DB_DEPRECATION, v1DbDeprecationHeaders, v1TableDeprecationHeaders } from '@/lib/api/v1/deprecation'

const P = '6f1c2a8e-4b3d-4c5e-9f60-718293a4b5c6'
const ROW = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

describe('the Deprecation header', () => {
  it('is an RFC 9745 Date: @ and the seconds of 2026-11-17T00:00:00Z', () => {
    expect(V1_DB_DEPRECATION).toMatch(/^@\d+$/)
    expect(new Date(Number(V1_DB_DEPRECATION.slice(1)) * 1000).toISOString()).toBe('2026-11-17T00:00:00.000Z')
  })
})

describe('a /db route', () => {
  it('points a table at the same table on /api/v2', () => {
    expect(v1DbDeprecationHeaders(`/api/v1/${P}/db/orders?status=paid&limit=5`)).toEqual({
      Deprecation: V1_DB_DEPRECATION,
      Link: `</api/v2/${P}/orders>; rel="successor-version"`,
    })
  })

  it('points a record at the same record', () => {
    expect(v1DbDeprecationHeaders(`/api/v1/${P}/db/orders/${ROW}`)?.Link).toBe(`</api/v2/${P}/orders/${ROW}>; rel="successor-version"`)
    expect(v1DbDeprecationHeaders(`/api/v1/${P}/db/orders/42`)?.Link).toBe(`</api/v2/${P}/orders/42>; rel="successor-version"`)
  })

  it('points a sub-route at its table, not at a record of that name', () => {
    expect(v1DbDeprecationHeaders(`/api/v1/${P}/db/orders/search?q=x`)?.Link).toBe(`</api/v2/${P}/orders>; rel="successor-version"`)
  })

  it('with no table, says it is deprecated and names no successor', () => {
    expect(v1DbDeprecationHeaders(`/api/v1/${P}/db`)).toEqual({ Deprecation: V1_DB_DEPRECATION })
    expect(v1DbDeprecationHeaders(`/api/v1/${P}/db/`)).toEqual({ Deprecation: V1_DB_DEPRECATION })
  })

  it('leaves vector search unmarked: /api/v2 has nothing that replaces it', () => {
    expect(v1DbDeprecationHeaders(`/api/v1/${P}/db/orders/vector-search?q=shoes`)).toBeNull()
  })
})

describe('anything else', () => {
  it.each([
    `/api/v2/${P}/orders`,
    `/api/v1/${P}/fn/hello`,
    `/api/v1/${P}/database/query`,
    `/api/v1/${P}/dbx/orders`,
    `/api/v1/${P}/auth/signin`,
    `/api/v1/${P}`,
  ])('%s carries neither header', (path) => {
    expect(v1DbDeprecationHeaders(path)).toBeNull()
  })
})

describe('a table answered by v1 CRUD on any of its paths', () => {
  it('names the table, or the record, on /api/v2', () => {
    expect(v1TableDeprecationHeaders(P, 'orders')).toEqual({
      Deprecation: V1_DB_DEPRECATION,
      Link: `</api/v2/${P}/orders>; rel="successor-version"`,
    })
    expect(v1TableDeprecationHeaders(P, 'orders', '7').Link).toBe(`</api/v2/${P}/orders/7>; rel="successor-version"`)
  })

  it('puts nothing into the link that is not a plain path segment', () => {
    expect(v1TableDeprecationHeaders(P, 'or"ders>')).toEqual({ Deprecation: V1_DB_DEPRECATION })
    expect(v1TableDeprecationHeaders(P, 'orders', 'a b').Link).toBe(`</api/v2/${P}/orders>; rel="successor-version"`)
  })
})
