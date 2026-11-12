/**
 * @jest-environment jsdom
 */

/**
 * THE SCHEMA DIAGRAM OPENS WITH THREE READS, HOWEVER MANY TABLES THERE ARE
 * =======================================================================
 * Production QA (2026-11-09), Database: "Mapping relational schema graph…"
 * for more than 6 s on first open, with 2 requests per table. The diagram
 * asked /structure and /relationships once for every table, after the list.
 * Each relationship also came back twice, once from each end.
 *
 * It now asks for the list, every table's columns and every relationship, side
 * by side. These render the real component against route answers.
 */

import { act, render, screen } from '@testing-library/react'
import SchemaDiagram from '@/components/database/SchemaDiagram'

const TABLES = ['users', 'orders', 'order_items', 'products', 'reviews']
const col = (name: string, extra: Record<string, unknown> = {}) => ({
  name, type: 'text', nullable: true, primary: false, foreign: false, unique: false, indexed: false, ...extra,
})
const STRUCTURE: Record<string, unknown[]> = {
  users: [col('id', { type: 'uuid', primary: true, nullable: false }), col('email', { unique: true })],
  orders: [col('id', { type: 'uuid', primary: true }), col('user_id', { type: 'uuid', foreign: true })],
  order_items: [col('id', { primary: true }), col('order_id', { foreign: true }), col('product_id', { foreign: true })],
  products: [col('id', { primary: true }), col('title')],
  reviews: [col('id', { primary: true }), col('product_id', { foreign: true }), col('body')],
}
const fk = (child: string, column: string, parent: string) => ({
  name: `${child}_${column}_fkey`, type: 'foreign_key', relationType: 'one-to-many',
  from: { table: parent, column: 'id' }, to: { table: child, column },
})
const RELATIONSHIPS = [
  fk('orders', 'user_id', 'users'),
  fk('order_items', 'order_id', 'orders'),
  fk('order_items', 'product_id', 'products'),
  fk('reviews', 'product_id', 'products'),
]

const calls: string[] = []

function respond(body: unknown, status = 200): Response {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300, status, statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => body, text: async () => text,
  } as unknown as Response
}

function answer(input: string): Response {
  calls.push(input)
  const url = new URL(input, 'http://localhost')
  const table = url.searchParams.get('table')
  switch (url.pathname) {
    case '/api/database/tables':
      return respond({ success: true, data: TABLES.map((name) => ({ name, rows: 0 })) })
    case '/api/database/structure':
      return respond({ success: true, data: table ? STRUCTURE[table] : STRUCTURE })
    case '/api/database/relationships':
      return respond({
        success: true,
        data: table ? RELATIONSHIPS.filter((r) => r.from.table === table || r.to.table === table) : RELATIONSHIPS,
      })
    default:
      return respond({ success: false }, 404)
  }
}

beforeAll(() => {
  ;(global as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

beforeEach(() => {
  calls.length = 0
  global.fetch = jest.fn((input: RequestInfo | URL) => Promise.resolve(answer(String(input)))) as unknown as typeof fetch
})

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

it('asks for the list, every table, and every relationship: three reads', async () => {
  render(<SchemaDiagram projectId="p1" activeSchema="workspace_p1" />)
  await settle()

  expect(await screen.findByText(/5 tables · 4 rels/)).toBeTruthy()
  const reads = calls.map((c) => {
    const url = new URL(c, 'http://localhost')
    return `${url.pathname}${url.searchParams.has('table') ? ' (one table)' : ''}`
  })
  expect(reads.sort()).toEqual(['/api/database/relationships', '/api/database/structure', '/api/database/tables'])
})

it('draws the columns it was given for each table', async () => {
  render(<SchemaDiagram projectId="p1" activeSchema="workspace_p1" />)
  await settle()

  expect(await screen.findByText(/5 tables · 4 rels/)).toBeTruthy()
  expect(screen.getAllByText('user_id').length).toBeGreaterThan(0)
  expect(screen.getAllByText('product_id').length).toBeGreaterThan(0)
})
