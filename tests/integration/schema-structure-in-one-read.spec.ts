/**
 * THE SCHEMA DIAGRAM READS EVERY TABLE'S COLUMNS IN ONE REQUEST
 * =============================================================
 * Production QA (2026-11-09), Database: the schema graph showed "Mapping
 * relational schema graph…" for more than 6 s on first open, and made 2
 * requests per table: /structure and /relationships for each one, each
 * running its own catalog queries.
 *
 * GET /api/database/structure without `table` now answers every table's
 * columns from one catalog query, exactly as the per-table call answers each
 * one (pinned here table by table), and /relationships without `table`
 * already answered every relationship once.
 *
 * Real database and the real handlers. Only the identity wrapper is replaced,
 * by the house pattern (see catalog-routes-own-schema.test.ts).
 */

import { randomUUID } from 'crypto'

let currentUserId = ''
jest.mock('@/lib/auth/route-protection', () => {
  const actual = jest.requireActual('@/lib/auth/route-protection')
  return {
    ...actual,
    withProjectAccess: (handler: any) => async (request: any) => {
      const { canAccessProject } = jest.requireActual('@/lib/edition/guard')
      const projectId = new URL(request.url).searchParams.get('projectId') ?? ''
      if (!(await canAccessProject(currentUserId, projectId))) {
        const { NextResponse } = jest.requireActual('next/server')
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
      return handler(request, { user: { userId: currentUserId }, projectId })
    },
  }
})

import { prisma } from '@/lib/db/prisma'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { GET as structure } from '@/app/api/database/structure/route'
import { GET as relationships } from '@/app/api/database/relationships/route'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
let projectId = ''
let schema = ''

function req(path: string, query: Record<string, string>): any {
  const url = `http://localhost:3000${path}?${new URLSearchParams(query).toString()}`
  return { method: 'GET', url, nextUrl: new URL(url), headers: { get: () => null }, cookies: { get: () => undefined } }
}

const exec = (sql: string) => prisma.$executeRawUnsafe(sql)

/** One GET through the real handler: its status and body. */
async function get(handler: unknown, path: string, query: Record<string, string>) {
  const res = await (handler as (r: unknown) => Promise<Response>)(req(path, query))
  return { status: res.status, body: await res.json() }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  currentUserId = (await prisma.user.create({
    data: { email: `schema-graph-${randomUUID()}@test.invalid`, name: 'schema graph' }, select: { id: true },
  })).id
  projectId = (await prisma.project.create({
    data: { name: `schema-graph-${randomUUID().slice(0, 8)}`, userId: currentUserId }, select: { id: true },
  })).id
  schema = `workspace_${projectId}`
  await exec(`CREATE SCHEMA "${schema}"`)
  await exec(`CREATE TABLE "${schema}".users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, created_at timestamptz DEFAULT now())`)
  // email sits in two indexes (its UNIQUE constraint's and this one): still one column.
  await exec(`CREATE INDEX users_email_lookup ON "${schema}".users (email)`)
  await exec(`CREATE TABLE "${schema}".orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES "${schema}".users(id), total numeric(10,2), status text DEFAULT 'new')`)
  await exec(`CREATE TABLE "${schema}".order_items (id serial PRIMARY KEY, order_id uuid NOT NULL REFERENCES "${schema}".orders(id), sku text, qty integer NOT NULL)`)
  await exec(`CREATE INDEX order_items_sku ON "${schema}".order_items (sku)`)
  await exec(`CREATE TABLE "${schema}"."Projects" (id bigserial PRIMARY KEY, "ownerId" uuid, title varchar(200))`)
}, 60_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: currentUserId } }).catch(() => {})
}, 60_000)

const TABLES = ['users', 'orders', 'order_items', 'Projects']

describe('GET /api/database/structure without a table', () => {
  it('answers every table, each exactly as its own request answers it', async () => {
    const { status, body } = await get(structure, '/api/database/structure', { projectId, type: 'postgresql' })
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(Object.keys(body.data).sort()).toEqual([...TABLES].sort())

    for (const table of TABLES) {
      const { body: one } = await get(structure, '/api/database/structure', { projectId, type: 'postgresql', table })
      expect(one.success).toBe(true)
      expect(body.data[table]).toEqual(one.data)
    }
  }, 60_000)

  it('carries the flags the diagram draws', async () => {
    const { body } = await get(structure, '/api/database/structure', { projectId, type: 'postgresql' })
    const col = (table: string, name: string) => body.data[table].find((c: any) => c.name === name)
    expect(col('users', 'id')).toMatchObject({ primary: true, nullable: false })
    expect(col('users', 'email')).toMatchObject({ unique: true, indexed: true, nullable: false })
    expect(body.data.users.filter((c: any) => c.name === 'email')).toHaveLength(1)
    expect(col('orders', 'user_id')).toMatchObject({ foreign: true })
    expect(col('order_items', 'sku')).toMatchObject({ indexed: true, unique: false })
    expect(body.data.orders.map((c: any) => c.name)).toEqual(['id', 'user_id', 'total', 'status'])
  }, 60_000)

  it('answers an empty map for a project with no tables yet', async () => {
    const emptyProject = (await prisma.project.create({
      data: { name: `schema-graph-empty-${randomUUID().slice(0, 8)}`, userId: currentUserId }, select: { id: true },
    })).id
    try {
      const { body } = await get(structure, '/api/database/structure', { projectId: emptyProject, type: 'postgresql' })
      expect(body).toMatchObject({ success: true, data: {} })
    } finally {
      await prisma.project.delete({ where: { id: emptyProject } }).catch(() => {})
    }
  }, 60_000)
})

describe('GET /api/database/relationships without a table', () => {
  it('answers each foreign key once', async () => {
    const { body } = await get(relationships, '/api/database/relationships', { projectId, schema })
    expect(body.success).toBe(true)
    const edges = body.data.map((r: any) => `${r.to.table}.${r.to.column}->${r.from.table}.${r.from.column}`)
    expect(edges.filter((e: string) => e === 'orders.user_id->users.id')).toHaveLength(1)
    expect(edges.filter((e: string) => e === 'order_items.order_id->orders.id')).toHaveLength(1)
  }, 60_000)
})
