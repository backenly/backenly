/**
 * A PROJECT'S CATALOG ROUTES READ ONLY ITS OWN SCHEMAS
 * ====================================================
 * GET /api/database/schemas, /api/database/indexes and
 * /api/database/relationships verify access to the project the caller names,
 * then read the catalog of that project's database. What they read is that
 * project's own schemas (`workspace_<id>` and its branches'), nothing else in
 * the database.
 *
 * What is pinned here, as the owner of project A, with project B's schema real
 * and populated beside A's in the same database:
 *
 *   schemas      all: A's schema and its branch's, never B's; workspace: A's;
 *                platform: refused
 *   indexes      A's table answers with its index; B's schema is refused 403
 *   relationships A's foreign key answers; B's schema is refused 403
 *
 * Real database and the real handlers. Only the identity wrapper is replaced,
 * by the house pattern: withProjectAccess resolves the user through
 * next/headers, which jest cannot provide, so it is delegated to the real
 * canAccessProject with a test-controlled user.
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

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
let ownerA = ''
let ownerB = ''
let projectA = ''
let projectB = ''
const schemasMade: string[] = []

async function makeOwnedProject(tag: string) {
  const user = await prisma.user.create({ data: { email: `catalog-${tag}-${randomUUID()}@test.invalid`, name: 'catalog test' }, select: { id: true } })
  const project = await prisma.project.create({ data: { name: `catalog-${tag}-${randomUUID().slice(0, 8)}`, userId: user.id }, select: { id: true } })
  return { userId: user.id, projectId: project.id }
}

async function exec(sql: string) {
  await prisma.$executeRawUnsafe(sql)
}

function req(path: string, query: Record<string, string>): any {
  const url = `http://localhost:3000${path}?${new URLSearchParams(query).toString()}`
  return {
    method: 'GET',
    url,
    nextUrl: new URL(url),
    headers: { get: () => null },
    cookies: { get: () => undefined },
  }
}

beforeAll(async () => {
  assertSafeTestDatabase()
  const a = await makeOwnedProject('a')
  const b = await makeOwnedProject('b')
  ownerA = a.userId; projectA = a.projectId
  ownerB = b.userId; projectB = b.projectId

  const sa = `workspace_${projectA}`, sb = `workspace_${projectB}`, branch = `workspace_${projectA}_br_dev`
  schemasMade.push(sa, sb, branch)
  await exec(`CREATE SCHEMA "${sa}"`)
  await exec(`CREATE TABLE "${sa}".authors (id uuid PRIMARY KEY)`)
  await exec(`CREATE TABLE "${sa}".books (id uuid PRIMARY KEY, author_id uuid REFERENCES "${sa}".authors(id))`)
  await exec(`CREATE INDEX books_author_id_idx ON "${sa}".books (author_id)`)
  await exec(`CREATE SCHEMA "${branch}"`)
  await exec(`CREATE SCHEMA "${sb}"`)
  await exec(`CREATE TABLE "${sb}".members (id uuid PRIMARY KEY)`)
  await exec(`CREATE TABLE "${sb}".invoices (id uuid PRIMARY KEY, member_id uuid REFERENCES "${sb}".members(id))`)
  await exec(`CREATE INDEX invoices_member_id_idx ON "${sb}".invoices (member_id)`)
})

beforeEach(() => {
  process.env.BACKENLY_EDITION = 'cloud'
  currentUserId = ownerA
})

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
})

afterAll(async () => {
  for (const s of schemasMade) await exec(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: [projectA, projectB].filter(Boolean) } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerA, ownerB].filter(Boolean) } } }).catch(() => {})
})

describe('GET /api/database/schemas', () => {
  async function schemas(view?: string) {
    const { GET } = await import('@/app/api/database/schemas/route')
    return GET(req('/api/database/schemas', { projectId: projectA, ...(view ? { view } : {}) }) as any) as any
  }

  it('lists the project\'s schema and its branch\'s, and never another tenant\'s', async () => {
    const res = await schemas('all')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual(expect.arrayContaining([`workspace_${projectA}`, `workspace_${projectA}_br_dev`]))
    expect(body.data).not.toContain(`workspace_${projectB}`)
    expect(body.data.every((s: string) => s.startsWith(`workspace_${projectA}`))).toBe(true)
  })

  it('lists the same by default', async () => {
    const body = await (await schemas()).json()
    expect(body.data).not.toContain(`workspace_${projectB}`)
    expect(body.data).toContain(`workspace_${projectA}`)
  })

  it('answers the workspace view with the project\'s own schema', async () => {
    const body = await (await schemas('workspace')).json()
    expect(body.data).toEqual([`workspace_${projectA}`])
  })

  it('refuses the platform view', async () => {
    const res = await schemas('platform')
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('PLATFORM_SCHEMAS_NOT_LISTED')
  })
})

describe('GET /api/database/indexes', () => {
  async function indexes(schema: string, table: string) {
    const { GET } = await import('@/app/api/database/indexes/route')
    return GET(req('/api/database/indexes', { projectId: projectA, schema, table }) as any) as any
  }

  it('answers for the project\'s own table', async () => {
    const res = await indexes(`workspace_${projectA}`, 'books')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.map((i: { name: string }) => i.name)).toEqual(expect.arrayContaining(['books_author_id_idx', 'books_pkey']))
  })

  it('refuses another tenant\'s schema named by the caller', async () => {
    const res = await indexes(`workspace_${projectB}`, 'invoices')
    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body.code).toBe('SCHEMA_NOT_IN_PROJECT')
    expect(JSON.stringify(body)).not.toContain('invoices_member_id_idx')
  })

  it('refuses a platform schema too', async () => {
    const res = await indexes('public', 'users')
    expect(res.status).toBe(403)
  })
})

describe('GET /api/database/relationships', () => {
  async function relationships(query: Record<string, string>) {
    const { GET } = await import('@/app/api/database/relationships/route')
    return GET(req('/api/database/relationships', { projectId: projectA, ...query }) as any) as any
  }

  it('answers the project\'s own foreign keys', async () => {
    const res = await relationships({})
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(JSON.stringify(body.data)).toContain('author_id')
  })

  it('refuses another tenant\'s schema named by the caller', async () => {
    const res = await relationships({ schema: `workspace_${projectB}` })
    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body.code).toBe('SCHEMA_NOT_IN_PROJECT')
    expect(JSON.stringify(body)).not.toContain('member_id')
  })
})

describe('a caller without access to the project', () => {
  it('is refused before any catalog is read', async () => {
    currentUserId = ownerB
    const { GET } = await import('@/app/api/database/indexes/route')
    const res: any = await GET(req('/api/database/indexes', { projectId: projectA, schema: `workspace_${projectA}`, table: 'books' }) as any)
    expect(res.status).toBe(404)
  })
})
