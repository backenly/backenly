/**
 * A FILE'S ADDRESS IN THE SDK SERVES THE FILE (#616)
 * ==================================================
 * `storage.getUrl(id)` returned the file's metadata route,
 * /api/v1/{projectId}/storage/files/{id}, which answers JSON and only to a
 * caller holding the project's key, so it could not be an `<img src>` even for
 * a public file. It now returns the download route. `upload()` resolves its
 * `url` as an absolute address, where a deployment storing files on its own
 * disk answered a path on its own origin. The supabase-js shim's
 * getPublicUrl() called a storage.getFileUrl() the SDK never had, so its
 * publicUrl was always null.
 *
 * The README's storage example runs here as written, through the routes that
 * serve it and a real database, with the files on local disk:
 *
 *   a public file         served at getUrl(id) to anyone, as uploaded
 *   a file not public     refused at getUrl(id) without a grant, and served
 *                         at the signed url upload() resolved
 *   delete(id)            removes it, and getUrl(id) then answers 404
 *   the supabase shim     getPublicUrl() is that same address
 *
 * The README's examples are compiled against the SDK in
 * tests/unit/sdk-readme-examples.spec.ts.
 */

import '@/tests/helpers/real-web-standard'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'
import { BackenlyClient, createSupabaseCompatClient } from '@backenly/sdk'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'

// Set before the storage modules load, which happens in beforeAll:
// LocalStorageService reads its directory when the module is first imported.
const STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'sdk-storage-urls-'))
const ORIGINAL_ENV = {
  STORAGE_DRIVER: process.env.STORAGE_DRIVER,
  STORAGE_DIR: process.env.STORAGE_DIR,
  STORAGE_SECRET: process.env.STORAGE_SECRET,
  STORAGE_BASE_URL: process.env.STORAGE_BASE_URL,
}
process.env.STORAGE_DRIVER = 'local'
process.env.STORAGE_DIR = STORAGE_ROOT
// Signing refuses a secret shorter than 32 characters (lib/auth/jwt-secret.ts).
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || `sdk-storage-urls-${'s'.repeat(32)}`
// As a self-hosted deployment answers by default: a download path on its own origin.
delete process.env.STORAGE_BASE_URL

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

/** The origin the in-process transport below answers for. */
const NEXT = 'https://next.backenly.test'
const PROJECT_JWT_SECRET = `sdk-storage-urls-${'s'.repeat(40)}`
const ALICE = randomUUID()
/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

let ownerId = ''
let projectId = ''
let clientKey = ''

type Handler = (request: NextRequest, props: { params: Promise<Record<string, string>> }) => Promise<Response>
let routes: { upload: { POST: Handler }; file: { GET: Handler; DELETE: Handler }; download: { GET: Handler } }

const realFetch = globalThis.fetch

/**
 * fetch, answered by the route handlers in this process: the request the SDK
 * builds (or an `<img>` would) goes to the handler as a NextRequest, and the
 * handler's own Response comes back.
 */
const nextFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  if (url.origin !== NEXT) return realFetch(input, init)
  const request = new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1])
  const method = (init?.method ?? 'GET').toUpperCase()
  const v1 = new RegExp(`^/api/v1/${projectId}/storage/(upload|files/([^/]+))$`).exec(url.pathname)
  if (v1?.[1] === 'upload' && method === 'POST') {
    return routes.upload.POST(request, { params: Promise.resolve({ projectId }) })
  }
  if (v1?.[2] && (method === 'GET' || method === 'DELETE')) {
    return routes.file[method as 'GET' | 'DELETE'](request, {
      params: Promise.resolve({ projectId, fileId: decodeURIComponent(v1[2]) }),
    })
  }
  const download = /^\/api\/storage\/files\/([^/]+)\/download$/.exec(url.pathname)
  if (download && method === 'GET') {
    return routes.download.GET(request, { params: Promise.resolve({ fileId: decodeURIComponent(download[1]) }) })
  }
  throw new Error(`no route for ${method} ${url.pathname}`)
}) as typeof fetch

/** The published client, as an app holding the client key and alice's session uses it. */
function aliceClient(): BackenlyClient {
  const backend = new BackenlyClient({ projectId, apiKey: clientKey, apiUrl: NEXT })
  backend.setUserToken(jwt.sign({ userId: ALICE, projectId, role: 'user' }, PROJECT_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }))
  return backend
}

/** What an `<img src>` (or any request with no credentials) gets at an address. */
async function fetchedBare(address: string): Promise<{ status: number; type: string | null; bytes: Buffer }> {
  const res = await nextFetch(address)
  return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) }
}

beforeAll(async () => {
  assertSafeTestDatabase()
  routes = {
    upload: (await import('@/app/api/v1/[projectId]/storage/upload/route')) as any,
    file: (await import('@/app/api/v1/[projectId]/storage/files/[fileId]/route')) as any,
    download: (await import('@/app/api/storage/files/[fileId]/download/route')) as any,
  }

  ownerId = (await prisma.user.create({
    data: { email: `sdk-storage-urls-${randomUUID()}@test.invalid`, name: 'SDK storage URLs' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({
    data: { name: `sdk-storage-urls-${randomUUID().slice(0, 8)}`, userId: ownerId, jwtSecret: PROJECT_JWT_SECRET },
    select: { id: true },
  })).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)

  // The app's client key, as the README's quickstart uses one.
  clientKey = `proj_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'sdk storage urls', keyPrefix: clientKey.slice(0, 16), keyHash: hashApiKey(clientKey),
      permissions: ['read', 'write'], capabilities: [], userId: ownerId, projectId,
      keyType: 'public', scope: 'runtime', serviceRole: false, rateLimit: 1000,
    },
  })
  // The README's bucket: one whose policy lets files be public.
  await prisma.storageBucket.create({ data: { name: 'avatars', projectId, isPublic: true, accessPolicy: 'public_read' } })

  globalThis.fetch = nextFetch
}, 60_000)

afterAll(async () => {
  globalThis.fetch = realFetch
  await flushRecordedRequests().catch(() => {})
  if (projectId) {
    await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(STORAGE_ROOT, { recursive: true, force: true })
}, 60_000)

describe("the README's storage example", () => {
  it('serves a public file at getUrl(id) to anyone, as uploaded, until delete(id)', async () => {
    const backend = aliceClient()
    const file = new File([PNG], 'me.png', { type: 'image/png' })

    // As the README writes it.
    const { id, url } = await backend.storage.upload(file, `${ALICE}.png`, { bucket: 'avatars', isPublic: true })
    const address = backend.storage.getUrl(id)

    expect(address).toBe(`${NEXT}/api/storage/files/${id}/download`)
    expect(url).toBe(address)
    const served = await fetchedBare(address)
    expect(served.status).toBe(200)
    expect(served.type).toBe('image/png')
    expect(served.bytes.equals(PNG)).toBe(true)

    await expect(backend.storage.delete(id)).resolves.toEqual({ success: true })
    expect((await fetchedBare(address)).status).toBe(404)
  })

  it('refuses a file that is not public at getUrl(id), and serves it at the signed url upload() resolved', async () => {
    const backend = aliceClient()
    const file = new File([PNG], 'private.png', { type: 'image/png' })

    // No bucket: the project's private default bucket.
    const { id, url } = await backend.storage.upload(file, 'private.png')

    expect((await fetchedBare(backend.storage.getUrl(id))).status).toBe(401)
    expect(url.startsWith(`${NEXT}/api/storage/files/${id}/download?token=`)).toBe(true)
    const signed = await fetchedBare(url)
    expect(signed.status).toBe(200)
    expect(signed.bytes.equals(PNG)).toBe(true)
  })
})

describe('the supabase-js shim', () => {
  it("gives getUrl's address as getPublicUrl(), and it serves a public file", async () => {
    const backend = aliceClient()
    const { id } = await backend.storage.upload(new File([PNG], 'shared.png', { type: 'image/png' }), 'shared.png', {
      bucket: 'avatars',
      isPublic: true,
    })
    const supabase = createSupabaseCompatClient(`${NEXT}/api/v1/${projectId}`, clientKey)

    const { data } = supabase.storage.from('avatars').getPublicUrl(id)

    expect(data.publicUrl).toBe(backend.storage.getUrl(id))
    expect((await fetchedBare(data.publicUrl)).status).toBe(200)
  })
})
