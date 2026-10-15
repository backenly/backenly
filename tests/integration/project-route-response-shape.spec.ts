/**
 * THE PROJECT ROUTE ANSWERS THE CLIENT TYPE, NEVER THE RAW ROW
 * ============================================================
 * GET/PUT /api/projects/[id] spread the raw Prisma Project row (plus relations)
 * into the response. The raw row carries `jwtSecret` — the key that signs any
 * end user's identity for the whole project, frequently stored in plaintext —
 * plus the domain verification token and internal state. The route answers to
 * every VIEWER, so each of them (and the browser cache, and any extension on
 * the console page) received the material to mint arbitrary end-user tokens.
 *
 * The route now selects exactly the client type's fields, so the secret never
 * leaves the database layer. This drives the REAL handlers (auth wrapper
 * delegated — its decision is pinned elsewhere; the shape is what is under
 * test) against a real database.
 */

import { randomUUID } from 'crypto'

let currentUserId = ''
jest.mock('@/lib/auth/route-protection', () => {
  const actual = jest.requireActual('@/lib/auth/route-protection')
  return {
    ...actual,
    withAuth: (handler: any) => async (request: any, ctx: any = {}) =>
      handler(request, { user: { userId: currentUserId }, params: ctx.params }),
  }
})

import { prisma } from '@/lib/db/prisma'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const SECRET = `route-shape-secret-${'s'.repeat(32)}`
let ownerId = ''
let projectId = ''

const SECRET_FIELDS = [
  'jwtSecret',
  'anonKey',
  'domainVerificationToken',
  'projectBrain',
  'architecturalMemory',
  'authManifest',
  'workerContainerId',
]

function req(method: string, body?: unknown): any {
  return {
    method,
    url: `http://localhost:3000/api/projects/${projectId}`,
    nextUrl: { pathname: `/api/projects/${projectId}` },
    headers: new Headers(),
    cookies: { get: () => undefined },
    json: async () => body ?? {},
  }
}

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `shape-${randomUUID()}@test.invalid`, name: 'Shape Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: {
        name: `shape-${randomUUID().slice(0, 8)}`,
        userId: ownerId,
        jwtSecret: SECRET,
        domainVerificationToken: 'dvt-not-for-clients',
      },
      select: { id: true },
    })
  ).id
  currentUserId = ownerId
}, 120_000)

afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('GET /api/projects/[id]', () => {
  it('answers the client fields and NOT the signing secret or internals', async () => {
    const { GET } = await import('@/app/api/projects/[id]/route')
    const res: any = await GET(req('GET') as any, {} as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.id).toBe(projectId)
    expect(typeof body.data.storageLimit).toBe('number')
    expect(body.data.metrics.totalTables).toBe(0)

    for (const field of SECRET_FIELDS) {
      expect(body.data[field]).toBeUndefined()
    }
    expect(JSON.stringify(body)).not.toContain(SECRET)
    // Relations are not part of the client type and must not ride along.
    expect(body.data.tables).toBeUndefined()
    expect(body.data.workspaces).toBeUndefined()
    expect(body.data.user).toBeUndefined()
  }, 60_000)
})

describe('PUT /api/projects/[id]', () => {
  it('updates and answers the same clean shape', async () => {
    const { PUT } = await import('@/app/api/projects/[id]/route')
    const res: any = await PUT(req('PUT', { name: 'renamed-by-shape-test' }) as any, {} as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.name).toBe('renamed-by-shape-test')
    for (const field of SECRET_FIELDS) {
      expect(body.data[field]).toBeUndefined()
    }
    expect(JSON.stringify(body)).not.toContain(SECRET)
  }, 60_000)
})
