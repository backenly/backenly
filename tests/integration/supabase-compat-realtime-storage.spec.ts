/**
 * THE SUPABASE-JS SHIM, ON A REAL STREAM AND THE STORAGE ROUTES (#615)
 * ====================================================================
 * The shim read a change's row from `row` or `new`, which Backenly never sends,
 * handed the stream's `connected` frame to an `event: '*'` handler as a change,
 * uploaded every file to the `default` bucket under its own name, and answered
 * getPublicUrl() with null. A handler written for supabase-js
 * (`payload.new.id`) threw on every event.
 *
 * Here the shim runs as a supabase-js frontend uses it:
 *
 *   realtime   a table's realtime trigger and its notifications, the runtime's
 *              stream (server/app.ts) opened with a ticket as the SDK opens it,
 *              and its frames read as a browser's EventSource reads them. The
 *              handler gets each insert and update with the row in `new`, each
 *              delete with the row's key in `old`, and never the `connected`
 *              frame
 *   storage    the upload, file and download routes, with the files on local
 *              disk. A file lands in the bucket it was uploaded to, under the
 *              path it was given, a Blob too, and getPublicUrl() serves it to
 *              anyone when the bucket is public, and not otherwise
 *
 * Each kind of frame, and the status that subscribe()'s callback receives, are
 * pinned in tests/unit/supabase-compat-realtime-storage.spec.ts.
 */

import '@/tests/helpers/real-web-standard'

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'
import { createSupabaseCompatClient } from '@backenly/sdk'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { installRealtimeTrigger } from '@/lib/services/realtimeTriggers'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'

// Set before the storage modules load, which happens in beforeAll:
// LocalStorageService reads its directory when the module is first imported.
const STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'supabase-compat-'))
const ORIGINAL_ENV = {
  STORAGE_DRIVER: process.env.STORAGE_DRIVER,
  STORAGE_DIR: process.env.STORAGE_DIR,
  STORAGE_SECRET: process.env.STORAGE_SECRET,
  STORAGE_BASE_URL: process.env.STORAGE_BASE_URL,
}
process.env.STORAGE_DRIVER = 'local'
process.env.STORAGE_DIR = STORAGE_ROOT
// Signing refuses a secret shorter than 32 characters (lib/auth/jwt-secret.ts).
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || `supabase-compat-${'s'.repeat(32)}`
delete process.env.STORAGE_BASE_URL

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

/** The origin the in-process storage transport below answers for. */
const NEXT = 'https://next.backenly.test'
const PROJECT_JWT_SECRET = randomBytes(32).toString('hex')
const ALICE = randomUUID()
/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

let ownerId = ''
let projectId = ''
let schema = ''
let clientKey = ''
let runtime: http.Server | undefined
let runtimeBase = ''

type Handler = (request: NextRequest, props: { params: Promise<Record<string, string>> }) => Promise<Response>
let routes: { upload: { POST: Handler }; file: { GET: Handler; DELETE: Handler }; download: { GET: Handler } }

const realFetch = globalThis.fetch

/**
 * fetch, with the storage routes answered by their handlers in this process:
 * the request the SDK builds (or an `<img>` would) goes to the handler as a
 * NextRequest, and the handler's own Response comes back. Anything else, such
 * as the runtime's ticket route, goes over the network.
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

/** A browser's EventSource, over node's http: the frames a stream sends, as `onmessage` receives them. */
class NodeEventSource {
  static readonly CLOSED = 2
  static opened: NodeEventSource[] = []
  readyState = 0
  onmessage: ((msg: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  /** Every frame the server sent, parsed. */
  readonly frames: Array<Record<string, any>> = []
  private readonly request: http.ClientRequest

  constructor(readonly url: string) {
    NodeEventSource.opened.push(this)
    this.request = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return this.fail()
      }
      this.readyState = 1
      res.setEncoding('utf8')
      let buffered = ''
      res.on('data', (chunk: string) => {
        buffered += chunk
        for (let end = buffered.indexOf('\n\n'); end >= 0; end = buffered.indexOf('\n\n')) {
          const block = buffered.slice(0, end)
          buffered = buffered.slice(end + 2)
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n')
          // A block with no data is a keepalive comment.
          if (!data) continue
          this.frames.push(JSON.parse(data))
          this.onmessage?.({ data })
        }
      })
      res.on('end', () => this.fail())
    })
    this.request.on('error', () => this.fail())
  }

  close() {
    this.readyState = NodeEventSource.CLOSED
    this.request.destroy()
  }

  private fail() {
    if (this.readyState === NodeEventSource.CLOSED) return
    this.readyState = NodeEventSource.CLOSED
    this.onerror?.()
  }
}

/**
 * The SDK opens a stream only in a browser, which it decides when a channel
 * subscribes. The server runs in this process too, so this is a browser for
 * that call only, never while the server handles a request.
 */
function asBrowser<T>(run: () => T): T {
  ;(globalThis as any).window = {}
  try {
    return run()
  } finally {
    delete (globalThis as any).window
  }
}

async function until(what: string, holds: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** What an `<img src>` (or any request with no credentials) gets at an address. */
async function fetchedBare(address: string): Promise<{ status: number; type: string | null; bytes: Buffer }> {
  const res = await nextFetch(address)
  return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) }
}

async function storedFile(id: string) {
  const row = await prisma.storageFile.findUnique({
    where: { id },
    select: { name: true, isPublic: true, bucket: { select: { name: true } } },
  })
  return row && { bucket: row.bucket.name, name: row.name, isPublic: row.isPublic }
}

type Payload = { eventType: string; new: Record<string, any>; old: Record<string, any>; table: string; schema: string }

beforeAll(async () => {
  assertSafeTestDatabase()
  routes = {
    upload: (await import('@/app/api/v1/[projectId]/storage/upload/route')) as any,
    file: (await import('@/app/api/v1/[projectId]/storage/files/[fileId]/route')) as any,
    download: (await import('@/app/api/storage/files/[fileId]/download/route')) as any,
  }

  ownerId = (await prisma.user.create({
    data: { email: `supabase-compat-${randomUUID()}@test.invalid`, name: 'supabase-js shim' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({
    data: { name: `supabase-compat-${randomUUID().slice(0, 8)}`, userId: ownerId, jwtSecret: PROJECT_JWT_SECRET },
    select: { id: true },
  })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}".messages (id uuid PRIMARY KEY, body text)`)
  expect(await installRealtimeTrigger(projectId, 'messages')).toEqual({ installed: true })

  // The anon key a frontend is given.
  clientKey = `proj_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'supabase-js shim', keyPrefix: clientKey.slice(0, 16), keyHash: hashApiKey(clientKey),
      permissions: ['read', 'write'], capabilities: [], userId: ownerId, projectId,
      keyType: 'public', scope: 'runtime', serviceRole: false, rateLimit: 1000,
    },
  })
  // A public bucket, as a Supabase app keeps its avatars in.
  await prisma.storageBucket.create({ data: { name: 'avatars', projectId, isPublic: true, accessPolicy: 'public_read' } })

  const { default: app } = await import('@/server/app')
  runtime = http.createServer(app)
  await new Promise<void>((resolve) => runtime!.listen(0, '127.0.0.1', resolve))
  runtimeBase = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}`

  globalThis.fetch = nextFetch
  ;(globalThis as any).EventSource = NodeEventSource
  // Loading the routes and the runtime is most of this, and slow on a cold cache.
}, 120_000)

afterAll(async () => {
  for (const stream of NodeEventSource.opened) stream.close()
  delete (globalThis as any).EventSource
  globalThis.fetch = realFetch
  await new Promise((resolve) => (runtime ? runtime.close(resolve) : resolve(undefined)))
  await flushRecordedRequests().catch(() => {})
  if (projectId) {
    await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
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

describe('postgres_changes, from a real stream', () => {
  it("hands a supabase-js handler each change's row in `new`, a deleted row in `old`, and none of the stream's own frames", async () => {
    const supabase = createSupabaseCompatClient(`${runtimeBase}/api/v1/${projectId}`, clientKey)
    const received: Payload[] = []
    const messages = new Map<string, string>()
    const channel = supabase
      .channel('room')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (payload: Payload) => {
        received.push(payload)
        // As a supabase-js app writes it.
        if (payload.eventType === 'DELETE') messages.delete(payload.old.id)
        else messages.set(payload.new.id, payload.new.body)
      })
    asBrowser(() => channel.subscribe())
    try {
      // The runtime loads the ticket and stream routes' modules on the first request.
      await until('the stream to connect', () => NodeEventSource.opened.some((s) => s.frames.some((f) => f.type === 'connected')), 45_000)
      const first = randomUUID()
      const second = randomUUID()

      await prisma.$executeRawUnsafe(`INSERT INTO "${schema}".messages (id, body) VALUES ($1::uuid, 'hello')`, first)
      await prisma.$executeRawUnsafe(`INSERT INTO "${schema}".messages (id, body) VALUES ($1::uuid, 'there')`, second)
      // An insert reaches a stream only while its row can still be read, so the
      // rows stay until both have.
      await until('both inserts', () => received.length >= 2)
      await prisma.$executeRawUnsafe(`UPDATE "${schema}".messages SET body = 'edited' WHERE id = $1::uuid`, first)
      await prisma.$executeRawUnsafe(`DELETE FROM "${schema}".messages WHERE id = $1::uuid`, second)
      await until('four changes', () => received.length >= 4)

      expect(received).toEqual([
        { eventType: 'INSERT', new: { id: first, body: 'hello' }, old: {}, table: 'messages', schema: 'public' },
        { eventType: 'INSERT', new: { id: second, body: 'there' }, old: {}, table: 'messages', schema: 'public' },
        // A stream that is not a service-role one gets an update's previous row, and a deleted row, as its key.
        { eventType: 'UPDATE', new: { id: first, body: 'edited' }, old: { id: first }, table: 'messages', schema: 'public' },
        { eventType: 'DELETE', new: {}, old: { id: second }, table: 'messages', schema: 'public' },
      ])
      expect([...messages]).toEqual([[first, 'edited']])
      // The stream did send its own frame first, and the handler was not given it.
      expect(NodeEventSource.opened[0].frames[0]).toMatchObject({ type: 'connected', projectId })
    } finally {
      supabase.removeChannel(channel)
    }
  }, 90_000)
})

describe('storage.from(bucket), through the storage routes', () => {
  /** The shim as a signed-in frontend holds it: a file is removed by the end user who uploaded it. */
  function signedIn() {
    const supabase = createSupabaseCompatClient(`${NEXT}/api/v1/${projectId}`, clientKey)
    supabase.backenly.setUserToken(
      jwt.sign({ userId: ALICE, projectId, role: 'user' }, PROJECT_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }),
    )
    return supabase
  }

  it('stores a file in its bucket under its path, served to anyone at getPublicUrl() in a public bucket, until remove()', async () => {
    const supabase = signedIn()

    const { data, error } = await supabase.storage
      .from('avatars')
      .upload('team/alice.png', new File([PNG], 'IMG_0001.png', { type: 'image/png' }))

    expect(error).toBeNull()
    expect(await storedFile(data!.id!)).toEqual({ bucket: 'avatars', name: 'team/alice.png', isPublic: true })
    const { publicUrl } = supabase.storage.from('avatars').getPublicUrl(data!.path!).data
    const served = await fetchedBare(publicUrl)
    expect(served.status).toBe(200)
    expect(served.type).toBe('image/png')
    expect(served.bytes.equals(PNG)).toBe(true)

    expect(await supabase.storage.from('avatars').remove([data!.path!])).toEqual({ data: [{ name: data!.path }], error: null })
    expect((await fetchedBare(publicUrl)).status).toBe(404)
  })

  it('stores a Blob under the path it is given, and getPublicUrl() does not serve it from a bucket that is not public', async () => {
    const supabase = signedIn()

    // The project's `default` bucket, which is private.
    const { data, error } = await supabase.storage
      .from('default')
      .upload('notes/today.txt', new Blob(['dear diary'], { type: 'text/plain' }))

    expect(error).toBeNull()
    expect(await storedFile(data!.id!)).toEqual({ bucket: 'default', name: 'notes/today.txt', isPublic: false })
    const { publicUrl } = supabase.storage.from('default').getPublicUrl(data!.path!).data
    expect((await fetchedBare(publicUrl)).status).toBe(401)
  })
})
