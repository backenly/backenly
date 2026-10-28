/**
 * THE RUNTIME STORAGE DOORS OBEY THE BUCKET POLICY
 * ================================================
 * Two holes in the v1 storage runtime, both invisible to the old test (which
 * inserted rows directly instead of driving the routes):
 *
 *   - STO-03: the upload route recorded the API key's PLATFORM owner as
 *     `uploadedBy`. owner_only compares `uploadedBy` to the END USER from
 *     X-User-Token, and a platform id never equals an end-user id — so every
 *     owner_only bucket was unreadable by its own uploaders.
 *   - STO-04: list/get ignored the policy entirely: any read key enumerated
 *     every file in a private or owner_only bucket, each row carrying a
 *     WORKING signed URL; any write key deleted any file by id.
 *
 * This suite drives the REAL route handlers with real keys and real end-user
 * JWTs (signed with the project's own jwtSecret), against a real database and
 * the local storage driver.
 */

import '@/tests/helpers/real-web-standard'
import { randomBytes, randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const PROJECT_JWT_SECRET = `storage-policy-${'s'.repeat(40)}`
const USER_A = randomUUID()
const USER_B = randomUUID()

let ownerId = ''
let projectId = ''
let readKey = ''
let svcKey = ''

// Same claim shape the real signin route issues: the middleware accepts only
// tokens carrying THIS project's id (anti cross-project replay), so the claim
// is load-bearing, not decoration.
const tokenFor = (userId: string) =>
  jwt.sign({ userId, projectId, role: 'user' }, PROJECT_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })

function req(opts: {
  method: string
  path: string
  key?: string
  userToken?: string
  form?: FormData
  query?: string
}): any {
  // Real Headers (restored by real-web-standard): the middleware iterates them
  // with Object.fromEntries for the browser-origin check.
  const headers = new Headers()
  if (opts.key) headers.set('x-api-key', opts.key)
  if (opts.userToken) headers.set('x-user-token', opts.userToken)
  return {
    method: opts.method,
    url: `http://localhost:3000${opts.path}${opts.query ?? ''}`,
    nextUrl: { pathname: opts.path, searchParams: new URLSearchParams((opts.query ?? '').replace(/^\?/, '')) },
    headers,
    cookies: { get: () => undefined },
    formData: async () => opts.form,
    json: async () => ({}),
  }
}

async function upload(opts: { key: string; userToken?: string; bucket: string; name: string; isPublic?: boolean }) {
  const { POST } = await import('@/app/api/v1/[projectId]/storage/upload/route')
  const form = new FormData()
  form.set('file', new File([`hello from ${opts.name}`], opts.name, { type: 'text/plain' }))
  form.set('bucket', opts.bucket)
  form.set('path', opts.name)
  if (opts.isPublic) form.set('isPublic', 'true')
  const res: any = await POST(
    req({ method: 'POST', path: `/api/v1/${projectId}/storage/upload`, key: opts.key, userToken: opts.userToken, form }) as any,
    { params: Promise.resolve({ projectId }) }
  )
  const body = await res.json()
  if (res.status !== 200 && res.status !== 201) {
    // Surface the real refusal instead of a silent undefined id downstream.
    throw new Error(`upload ${opts.name} failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 400)}`)
  }
  return { status: res.status, body }
}

async function list(bucket: string, opts: { key: string; userToken?: string }) {
  const { GET } = await import('@/app/api/v1/[projectId]/storage/files/route')
  const res: any = await GET(
    req({ method: 'GET', path: `/api/v1/${projectId}/storage/files`, key: opts.key, userToken: opts.userToken, query: `?bucket=${bucket}` }) as any,
    { params: Promise.resolve({ projectId }) }
  )
  const body = await res.json()
  return { status: res.status, rows: (body?.data ?? body ?? []) as any[] }
}

async function getFile(fileId: string, opts: { key: string; userToken?: string }) {
  const { GET } = await import('@/app/api/v1/[projectId]/storage/files/[fileId]/route')
  const res: any = await GET(
    req({ method: 'GET', path: `/api/v1/${projectId}/storage/files/${fileId}`, key: opts.key, userToken: opts.userToken }) as any,
    { params: Promise.resolve({ projectId, fileId }) }
  )
  return { status: res.status, body: await res.json() }
}

async function del(fileId: string, opts: { key: string; userToken?: string }) {
  const { DELETE } = await import('@/app/api/v1/[projectId]/storage/files/[fileId]/route')
  const res: any = await DELETE(
    req({ method: 'DELETE', path: `/api/v1/${projectId}/storage/files/${fileId}`, key: opts.key, userToken: opts.userToken }) as any,
    { params: Promise.resolve({ projectId, fileId }) }
  )
  return { status: res.status, body: await res.json() }
}

let fileA = '' // uploaded by end user A into the owner_only bucket
let fileB = '' // uploaded by end user B into the owner_only bucket
let filePrivate = '' // key-only upload into the private bucket
let filePublic = '' // public object in the public_read bucket

beforeAll(async () => {
  assertSafeTestDatabase()
  process.env.STORAGE_DRIVER = 'local'
  process.env.STORAGE_DIR = `${require('os').tmpdir()}/.storage-policy-test-${process.pid}`
  process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || `t${'0'.repeat(40)}`

  const u = await prisma.user.create({
    data: { email: `srp-${randomUUID()}@test.invalid`, name: 'Storage Policy Test' },
    select: { id: true },
  })
  ownerId = u.id
  const p = await prisma.project.create({
    data: { name: `srp-${randomUUID().slice(0, 8)}`, userId: u.id, jwtSecret: PROJECT_JWT_SECRET },
    select: { id: true },
  })
  projectId = p.id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)

  const mk = async (serviceRole: boolean) => {
    const raw = `proj_live_${randomBytes(24).toString('hex')}`
    await prisma.apiKey.create({
      data: {
        name: serviceRole ? 'svc' : 'publishable',
        keyPrefix: raw.slice(0, 16),
        keyHash: hashApiKey(raw),
        permissions: ['read', 'write'],
        capabilities: [],
        userId: ownerId,
        projectId,
        keyType: 'public',
        scope: 'runtime',
        serviceRole,
        rateLimit: 1000,
      },
    })
    return raw
  }
  readKey = await mk(false)
  svcKey = await mk(true)

  for (const [name, accessPolicy] of [
    ['avatars', 'owner_only'],
    ['invoices', 'private'],
    ['assets', 'public_read'],
  ] as const) {
    await prisma.storageBucket.create({
      data: { name, projectId, isPublic: accessPolicy === 'public_read', accessPolicy },
    })
  }

  fileA = (await upload({ key: readKey, userToken: tokenFor(USER_A), bucket: 'avatars', name: 'a.txt' })).body?.data?.id
  fileB = (await upload({ key: readKey, userToken: tokenFor(USER_B), bucket: 'avatars', name: 'b.txt' })).body?.data?.id
  filePrivate = (await upload({ key: svcKey, bucket: 'invoices', name: 'inv.txt' })).body?.data?.id
  filePublic = (await upload({ key: svcKey, bucket: 'assets', name: 'logo.txt', isPublic: true })).body?.data?.id
  expect(fileA && fileB && filePrivate && filePublic).toBeTruthy()
}, 120000)

afterAll(async () => {
  await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('STO-03: the uploader of record', () => {
  it('is the end user from X-User-Token, the identity owner_only compares against', async () => {
    const row = await prisma.storageFile.findUnique({ where: { id: fileA }, select: { uploadedBy: true } })
    expect(row?.uploadedBy).toBe(USER_A)
  })

  it('is null for a key-only server upload, never the platform account', async () => {
    const row = await prisma.storageFile.findUnique({ where: { id: filePrivate }, select: { uploadedBy: true } })
    expect(row?.uploadedBy).toBeNull()
  })
})

describe('STO-04: listing obeys the policy', () => {
  it('an owner_only bucket shows an end user their own files only', async () => {
    const asA = await list('avatars', { key: readKey, userToken: tokenFor(USER_A) })
    expect(asA.rows.map((r) => r.id)).toEqual([fileA])
    // Ownership grants the read; the link is still minted per request, not
    // embedded in a bulk listing.
    expect(asA.rows[0].url).toBeNull()
  })

  it('a key with no end user sees nothing in an owner_only bucket', async () => {
    const anon = await list('avatars', { key: readKey })
    expect(anon.rows).toEqual([])
  })

  it('a private bucket is not enumerable by a publishable key', async () => {
    const anon = await list('invoices', { key: readKey })
    expect(anon.rows).toEqual([])
  })

  it('a service key still sees everything, and public objects keep their links', async () => {
    const svc = await list('avatars', { key: svcKey })
    expect(svc.rows.map((r) => r.id).sort()).toEqual([fileA, fileB].sort())

    const pub = await list('assets', { key: readKey })
    expect(pub.rows.map((r) => r.id)).toEqual([filePublic])
    expect(pub.rows[0].url).toBeTruthy()
  })
})

describe('STO-04: single file reads', () => {
  it('another end user gets 404, never the metadata or a working URL', async () => {
    const asB = await getFile(fileA, { key: readKey, userToken: tokenFor(USER_B) })
    expect(asB.status).toBe(404)
  })

  it('the uploader reads their own file', async () => {
    const asA = await getFile(fileA, { key: readKey, userToken: tokenFor(USER_A) })
    expect(asA.status).toBe(200)
  })

  it('a publishable key alone cannot resolve a private file id', async () => {
    const anon = await getFile(filePrivate, { key: readKey })
    expect(anon.status).toBe(404)
  })
})

describe('STO-04: deletion is ownership or operator authority', () => {
  it('a publishable key alone cannot delete by id', async () => {
    const res = await del(fileA, { key: readKey })
    expect(res.status).toBe(403)
  })

  it('another end user cannot delete it either', async () => {
    const res = await del(fileA, { key: readKey, userToken: tokenFor(USER_B) })
    expect(res.status).toBe(403)
  })

  it('the uploader deletes their own file', async () => {
    const res = await del(fileA, { key: readKey, userToken: tokenFor(USER_A) })
    expect(res.status).toBe(200)
  })

  it('a service key deletes anything in the project', async () => {
    const res = await del(filePrivate, { key: svcKey })
    expect(res.status).toBe(200)
  })
})
