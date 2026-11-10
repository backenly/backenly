/**
 * What leaves the graph with a table: its entity, the API entries that serve
 * it, and the relationships other tables hold to it. Nothing else.
 */
import { withoutTables } from '@/lib/orchestration/graph-tables'
import { createEmptyGraph, type BackendStateGraph } from '@/lib/orchestration/backend-state-graph'

const rel = (from: string, to: string) => ({ from, to, type: 'one-to-many' as const, reason: `${to}.${from}_id`, createdBy: 'real-fk' })
const entity = (name: string, relationships: ReturnType<typeof rel>[] = []) => ({
  name, reason: 'test', fields: {}, relationships, createdAt: '2026-11-10T00:00:00.000Z', createdBy: 'test', dependencies: [],
})
const api = (path: string, extra: Record<string, unknown> = {}) => ({
  path, methods: ['GET'], requiresAuth: false, rateLimit: 100, reason: 'generated', createdBy: 'test', dependsOn: [], ...extra,
})

function graph(): BackendStateGraph {
  return {
    ...createEmptyGraph('p1'),
    entities: {
      users: entity('users', [rel('users', 'reviews'), rel('users', 'orders')]),
      Reviews: entity('Reviews', [rel('reviews', 'products')]),
      products: entity('products'),
      orders: entity('orders'),
    },
    apis: {
      '/reviews': api('/reviews'),
      '/reviews/:id': api('/reviews/:id'),
      '/reviews_archive': api('/reviews_archive'),
      '/feedback': api('/feedback', { entity: 'reviews' }),
      '/orders': api('/orders'),
    },
  }
}

describe('withoutTables', () => {
  it('takes out the table, any case, with its API entries and the relationships that name it', () => {
    const before = graph()
    const after = withoutTables(before, ['reviews'])!
    expect(Object.keys(after.entities)).toEqual(['users', 'products', 'orders'])
    expect(after.entities.users.relationships).toEqual([rel('users', 'orders')])
    expect(Object.keys(after.apis)).toEqual(['/reviews_archive', '/orders'])
  })

  it('leaves everything else as it was, and the graph it was given untouched', () => {
    const before = graph()
    const copy = JSON.parse(JSON.stringify(before))
    const after = withoutTables(before, ['reviews'])!
    expect(after.entities.products).toBe(before.entities.products)
    expect(after.entities.orders).toBe(before.entities.orders)
    expect(after.auth).toBe(before.auth)
    expect(before).toEqual(copy)
  })

  it('takes out what names a table even when the graph has no entity for it', () => {
    const before = { ...graph(), apis: { ...graph().apis, '/carts': api('/carts') } }
    const after = withoutTables(before, ['carts', 'orders'])!
    expect(Object.keys(after.entities)).toEqual(['users', 'Reviews', 'products'])
    expect(after.entities.users.relationships).toEqual([rel('users', 'reviews')])
    expect(Object.keys(after.apis)).not.toContain('/carts')
  })

  it('returns null when nothing in the graph names the tables', () => {
    expect(withoutTables(graph(), ['invoices'])).toBeNull()
    expect(withoutTables(graph(), [])).toBeNull()
  })
})
