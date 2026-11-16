/**
 * A bucket says who may upload into it.
 *
 * Writing to storage through the public API needs a signed-in end user or a
 * service-role key (storage-writes-need-a-user.spec.ts). Each bucket now also
 * says which of them may upload into it: `signed_in` (any signed-in end user of
 * the app; each still changes only their own files) or `server_only` (only a
 * service-role key, and the project's team from the console).
 *
 *   a bucket made on purpose takes server_only unless whoever makes it asks for
 *   signed_in, and its creation says who may upload and how to change it
 *   every way an end user uploads is held to it: the form upload, a signed
 *   upload, a multipart upload (each of its steps) and confirming a signed one
 *   a service-role key always uploads
 *   a bucket an upload creates (the SDK's `default`) takes signed_in, and so
 *   does every bucket from before buckets said this
 *   changing it is one entry in History, and restoring the entry puts the old
 *   rule back; the console changes it too
 *
 * Real routes, the real executor and History, a real database, the local
 * storage driver.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', logRetentionDays: 7 }) }
})
// No PostgREST runs beside the tests; registering a schema with it is not what
// these cases are about.
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})
// The console's routes read the session through next/headers, which only a
// real Next request carries. The session behind the token is a real row.
let mockSessionToken = ''
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'auth-token' && mockSessionToken ? { value: mockSessionToken } : undefined),
  }),
  headers: async () => new Map<string, string>(),
}))

import '@/tests/helpers/real-web-standard'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomBytes, randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { createProvisionedProject } from '@/lib/projects/provision'
import { createSession } from '@/lib/auth/session'
import { executeAction } from '@/lib/ai/minimal-executor'
import { recoverChange } from '@/lib/changes/recovery'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { storageAdapter } from '@/lib/changes/resources/storage'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

const PROJECT_JWT_SECRET = `bucket-uploads-${'u'.repeat(40)}`
const USER = randomUUID()
const MIGRATION = 'prisma/migrations-canonical/20261116140000_bucket_upload_policy/migration.sql'

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

let ownerId = ''
let sessionToken = ''
let projectId = ''
let schema = ''
let publishableKey = ''
let serviceKey = ''

const tokenFor = (userId: string) =>
  jwt.sign({ userId, projectId, role: 'user' }, PROJECT_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })
const signedIn = () => tokenFor(USER)

const act = (action: string, params: Record<string, unknown>) =>
  executeAction({ action, params } as any, projectId, undefined, 0, undefined, false) as Promise<any>
const bucket = (name: string) => prisma.storageBucket.findFirst({ where: { projectId, name } })
const filesIn = (name: string) => prisma.storageFile.count({ where: { projectId, bucket: { name } } })

/** The subset of a Next request the v1 routes read. */
function req(opts: { method: string; path: string; key: string; userToken?: string; form?: FormData; json?: unknown; query?: string; bytes?: string }): any {
  const headers = new Headers()
  headers.set('x-api-key', opts.key)
  if (opts.userToken) headers.set('x-user-token', opts.userToken)
  if (opts.json !== undefined) headers.set('content-type', 'application/json')
  return {
    method: opts.method,
    url: `http://localhost:3000${opts.path}${opts.query ?? ''}`,
    nextUrl: { pathname: opts.path, searchParams: new URLSearchParams((opts.query ?? '').replace(/^\?/, '')) },
    headers,
    cookies: { get: () => undefined },
    formData: async () => opts.form,
    json: async () => opts.json ?? {},
    text: async () => JSON.stringify(opts.json ?? {}),
    arrayBuffer: async () => new TextEncoder().encode(opts.bytes ?? '').buffer,
  }
}
const params = () => ({ params: Promise.resolve({ projectId }) })
const answer = async (res: any) => ({ status: res.status as number, body: await res.json() })
const codeOf = (body: any) => body?.error?.code ?? body?.code

/** POST /storage/upload, as the SDK sends it. No bucket: the SDK's 'default'. */
async function upload(key: string, opts: { bucket?: string; userToken?: string } = {}) {
  const { POST } = await import('@/app/api/v1/[projectId]/storage/upload/route')
  const form = new FormData()
  form.set('file', new File(['hello'], 'note.txt', { type: 'text/plain' }))
  if (opts.bucket) form.set('bucket', opts.bucket)
  form.set('path', `note-${randomBytes(3).toString('hex')}.txt`)
  return answer(await POST(req({ method: 'POST', path: `/api/v1/${projectId}/storage/upload`, key, userToken: opts.userToken, form }), params()))
}

/** POST /storage/signed-upload. */
async function signedUpload(key: string, bucketName: string, userToken?: string) {
  const { POST } = await import('@/app/api/v1/[projectId]/storage/signed-upload/route')
  return answer(await POST(req({
    method: 'POST', path: `/api/v1/${projectId}/storage/signed-upload`, key, userToken,
    json: { bucket: bucketName, filename: 'clip.mp4', contentType: 'video/mp4', contentLength: 10 },
  }), params()))
}

const MULTIPART = () => `/api/v1/${projectId}/storage/upload-multipart`

/** POST /storage/upload-multipart?action=initiate. */
async function startMultipart(key: string, bucketName: string, userToken?: string) {
  const { POST } = await import('@/app/api/v1/[projectId]/storage/upload-multipart/route')
  return answer(await POST(req({
    method: 'POST', path: MULTIPART(), key, userToken, query: '?action=initiate',
    json: { bucket: bucketName, filename: 'clip.txt', contentType: 'text/plain', contentLength: 11 },
  }), params()))
}

/** The console's own request: a signed-in platform session, for this project. */
function consoleReq(method: string, url: string, body?: unknown): any {
  mockSessionToken = sessionToken
  const headers: Record<string, string> = {
    authorization: `Bearer ${sessionToken}`,
    'content-type': 'application/json',
    'x-project-id': projectId,
  }
  return {
    method,
    url: `http://localhost:3000${url}`,
    nextUrl: new URL(`http://localhost:3000${url}`),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => body ?? {},
    clone() {
      return this
    },
  }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  process.env.STORAGE_DRIVER = 'local'
  process.env.STORAGE_DIR = path.join(os.tmpdir(), `.bucket-uploads-test-${process.pid}`)
  process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || `t${'0'.repeat(40)}`
  await installChangeLedgerGuard()
  const email = `bucket-uploads-${randomUUID()}@test.invalid`
  ownerId = (await prisma.user.create({ data: { email, name: 'Bucket uploads' }, select: { id: true } })).id
  sessionToken = (await createSession(ownerId, email, 'user')).token
  const project = await createProvisionedProject({ name: `bucket-uploads-${randomUUID().slice(0, 8)}`, userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await prisma.project.update({ where: { id: projectId }, data: { jwtSecret: PROJECT_JWT_SECRET } })
  const mk = async (name: string, serviceRole: boolean) => {
    const raw = `${serviceRole ? 'svc' : 'proj'}_live_${randomBytes(24).toString('hex')}`
    await prisma.apiKey.create({
      data: {
        name, keyPrefix: raw.slice(0, 16), keyHash: hashApiKey(raw), permissions: ['read', 'write'], capabilities: [],
        userId: ownerId, projectId, keyType: 'public', scope: 'runtime', serviceRole, rateLimit: 1000,
      },
    })
    return raw
  }
  publishableKey = await mk('publishable', false)
  serviceKey = await mk('server', true)
}, 120_000)

afterAll(async () => {
  await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  fs.rmSync(process.env.STORAGE_DIR!, { recursive: true, force: true })
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

describe('a bucket made on purpose', () => {
  it('takes uploads only from the app’s server, and its creation says so and how to change it', async () => {
    const made = await act('CREATE_BUCKET', { bucketName: 'products', isPublic: true })
    expect(made.success).toBe(true)
    expect(made.data).toMatchObject({ bucketName: 'products', uploads: 'server_only' })
    expect(made.message).toContain("Only your app's server can upload into products")
    expect(made.message).toContain('storage { action: "set_uploads", bucketName: "products", uploads: "signed_in" }')
    expect((await bucket('products'))?.uploadPolicy).toBe('server_only')
  }, 60_000)

  it('refuses a signed-in end user’s upload, by every way an end user uploads, and stores nothing', async () => {
    const form = await upload(publishableKey, { bucket: 'products', userToken: signedIn() })
    expect(form.status).toBe(403)
    expect(codeOf(form.body)).toBe('UPLOADS_SERVER_ONLY')
    expect(form.body.error.message).toContain('Bucket "products" takes uploads only from your app\'s server')
    expect(form.body.error.message).toContain('set_uploads')

    const signed = await signedUpload(publishableKey, 'products', signedIn())
    expect(signed.status).toBe(403)
    expect(codeOf(signed.body)).toBe('UPLOADS_SERVER_ONLY')

    const multipart = await startMultipart(publishableKey, 'products', signedIn())
    expect(multipart.status).toBe(403)
    expect(codeOf(multipart.body)).toBe('UPLOADS_SERVER_ONLY')

    expect(await filesIn('products')).toBe(0)
  })

  it('takes the same upload from a server with a service-role key', async () => {
    const r = await upload(serviceKey, { bucket: 'products' })
    expect(r.status).toBe(200)
    expect(await filesIn('products')).toBe(1)
    const started = await startMultipart(serviceKey, 'products')
    expect(started.status).toBe(200)
  })

  it('takes uploads from signed-in users when it is made with uploads: signed_in', async () => {
    const made = await act('CREATE_BUCKET', { bucketName: 'avatars', uploads: 'signed_in' })
    expect(made.success).toBe(true)
    expect(made.data).toMatchObject({ uploads: 'signed_in' })
    expect((await bucket('avatars'))?.uploadPolicy).toBe('signed_in')
    const r = await upload(publishableKey, { bucket: 'avatars', userToken: signedIn() })
    expect(r.status).toBe(200)
    const row = await prisma.storageFile.findUnique({ where: { id: r.body.data.id }, select: { uploadedBy: true } })
    expect(row?.uploadedBy).toBe(USER)
  }, 60_000)

  it('refuses an uploads value it does not know, and makes nothing', async () => {
    const made = await act('CREATE_BUCKET', { bucketName: 'mystery', uploads: 'everyone' })
    expect(made.success).toBe(false)
    expect(made.error).toBe('UNKNOWN_UPLOADS_RULE')
    expect(made.message).toContain('signed_in')
    expect(await bucket('mystery')).toBeNull()
  }, 60_000)
})

describe('set_uploads', () => {
  it('lets signed-in users upload, and server_only stops them again', async () => {
    const open = await act('SET_BUCKET_UPLOADS', { bucketName: 'products', uploads: 'signed_in' })
    expect(open.success).toBe(true)
    expect(open.data).toMatchObject({ bucketName: 'products', uploads: 'signed_in' })
    expect((await upload(publishableKey, { bucket: 'products', userToken: signedIn() })).status).toBe(200)

    const closed = await act('SET_BUCKET_UPLOADS', { bucketName: 'products', uploads: 'server_only' })
    expect(closed.success).toBe(true)
    const again = await upload(publishableKey, { bucket: 'products', userToken: signedIn() })
    expect(again.status).toBe(403)
    expect(codeOf(again.body)).toBe('UPLOADS_SERVER_ONLY')
  }, 60_000)

  it('refuses a value it does not know and a bucket that does not exist, changing nothing', async () => {
    const unknown = await act('SET_BUCKET_UPLOADS', { bucketName: 'products', uploads: 'anyone' })
    expect(unknown.success).toBe(false)
    expect(unknown.error).toBe('UNKNOWN_UPLOADS_RULE')
    expect((await bucket('products'))?.uploadPolicy).toBe('server_only')
    const missing = await act('SET_BUCKET_UPLOADS', { bucketName: 'nope', uploads: 'signed_in' })
    expect(missing.success).toBe(false)
  }, 60_000)
})

describe('a bucket that takes uploads from signed-in users, as every bucket did before', () => {
  it('keeps taking a signed-in end user’s upload', async () => {
    await prisma.storageBucket.create({ data: { projectId, name: 'posts', isPublic: true, accessPolicy: 'public_read', uploadPolicy: 'signed_in' } })
    const r = await upload(publishableKey, { bucket: 'posts', userToken: signedIn() })
    expect(r.status).toBe(200)
  })

  it('is what the migration gives every existing bucket, and every bucket made without naming the column, as the release before this one makes them', async () => {
    const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), 'utf8')
    const scratch = `upload_rule_${randomBytes(4).toString('hex')}`
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query(`CREATE SCHEMA "${scratch}"`)
      await client.query(`SET LOCAL search_path TO "${scratch}"`)
      await client.query('CREATE TABLE storage_buckets (id text PRIMARY KEY, name text NOT NULL)')
      await client.query(`INSERT INTO storage_buckets (id, name) VALUES ('existing', 'photos')`)
      await client.query(sql)
      // While a release that predates the column still runs, the buckets it
      // creates keep taking the uploads they would have. This release states
      // the value on every bucket it makes (the other cases here).
      await client.query(`INSERT INTO storage_buckets (id, name) VALUES ('later', 'documents')`)
      const { rows } = await client.query('SELECT id, "uploadPolicy" FROM storage_buckets ORDER BY id')
      expect(rows).toEqual([
        { id: 'existing', uploadPolicy: 'signed_in' },
        { id: 'later', uploadPolicy: 'signed_in' },
      ])
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await client.end()
    }
  })
})

describe('a bucket an upload creates', () => {
  it('is the SDK’s default bucket: private, and it takes the signed-in end user’s upload that created it', async () => {
    expect(await bucket('default')).toBeNull()
    const r = await upload(publishableKey, { userToken: signedIn() })
    expect(r.status).toBe(200)
    expect(await bucket('default')).toMatchObject({ uploadPolicy: 'signed_in', accessPolicy: 'private', isPublic: false })
    expect((await upload(publishableKey, { userToken: tokenFor(randomUUID()) })).status).toBe(200)
  })

  it('takes signed-in users when a signed upload or a multipart upload creates it', async () => {
    expect((await signedUpload(publishableKey, 'clips', signedIn())).status).toBe(200)
    expect((await bucket('clips'))?.uploadPolicy).toBe('signed_in')
    expect((await startMultipart(publishableKey, 'recordings', signedIn())).status).toBe(200)
    expect((await bucket('recordings'))?.uploadPolicy).toBe('signed_in')
  })
})

describe('an upload under way', () => {
  it('follows the bucket’s rule at each step of a multipart upload; the end user may still abort it', async () => {
    await act('CREATE_BUCKET', { bucketName: 'drafts', uploads: 'signed_in' })
    const { POST, PUT, DELETE } = await import('@/app/api/v1/[projectId]/storage/upload-multipart/route')
    const started = await startMultipart(publishableKey, 'drafts', signedIn())
    expect(started.status).toBe(200)
    const uploadId = started.body.data.uploadId as string
    const part = async () => answer(await PUT(req({
      method: 'PUT', path: MULTIPART(), key: publishableKey, userToken: signedIn(), bytes: 'hello world',
      query: `?action=upload&uploadId=${uploadId}&partNumber=1&totalParts=1`,
    }), params()))
    expect((await part()).status).toBe(200)

    await act('SET_BUCKET_UPLOADS', { bucketName: 'drafts', uploads: 'server_only' })
    const refusedPart = await part()
    expect(refusedPart.status).toBe(403)
    expect(codeOf(refusedPart.body)).toBe('UPLOADS_SERVER_ONLY')
    const complete = await answer(await POST(req({
      method: 'POST', path: MULTIPART(), key: publishableKey, userToken: signedIn(),
      query: `?action=complete&uploadId=${uploadId}&totalParts=1`,
    }), params()))
    expect(complete.status).toBe(403)
    expect(codeOf(complete.body)).toBe('UPLOADS_SERVER_ONLY')
    expect(await prisma.storageFile.count({ where: { projectId, bucket: { name: 'drafts' }, metadata: { path: ['status'], equals: 'complete' } } })).toBe(0)

    const aborted = await DELETE(req({ method: 'DELETE', path: MULTIPART(), key: publishableKey, userToken: signedIn(), query: `?uploadId=${uploadId}` }), params())
    expect(aborted.status).toBe(200)
    expect(await filesIn('drafts')).toBe(0)
  }, 60_000)

  it('confirms a signed upload into a server_only bucket only for a service-role key', async () => {
    const { POST } = await import('@/app/api/v1/[projectId]/storage/confirm-upload/route')
    const drafts = await bucket('drafts')
    const pending = await prisma.storageFile.create({
      data: {
        bucketId: drafts!.id, projectId, name: 'clip.mp4', path: `projects/${projectId}/buckets/drafts/${randomUUID()}/clip.mp4`,
        size: BigInt(10), mimeType: 'video/mp4', isPublic: false, uploadedBy: USER,
        metadata: { uploadId: randomUUID(), status: 'pending' },
      },
    })
    const confirm = async (key: string, userToken?: string) =>
      answer(await POST(req({ method: 'POST', path: `/api/v1/${projectId}/storage/confirm-upload`, key, userToken, json: { fileId: pending.id } }), params()))
    const mine = await confirm(publishableKey, signedIn())
    expect(mine.status).toBe(403)
    expect(codeOf(mine.body)).toBe('UPLOADS_SERVER_ONLY')
    expect(((await prisma.storageFile.findUnique({ where: { id: pending.id } }))!.metadata as any).status).toBe('pending')
    expect((await confirm(serviceKey)).status).toBe(200)
  })
})

describe('changing who may upload', () => {
  it('is one entry in History, and restoring it puts the old rule back', async () => {
    await act('CREATE_BUCKET', { bucketName: 'gallery', uploads: 'signed_in' })
    const changed = await act('SET_BUCKET_UPLOADS', { bucketName: 'gallery', uploads: 'server_only' })
    expect(changed.success).toBe(true)
    expect(changed.change?.id).toBeTruthy()
    const entry = await prisma.backendChange.findUniqueOrThrow({ where: { id: changed.change.id } })
    expect(entry.resources).toEqual(['storage'])
    expect(entry.summary).toBe('Changed bucket gallery: upload policy')
    expect((await upload(publishableKey, { bucket: 'gallery', userToken: signedIn() })).status).toBe(403)

    const restored = await recoverChange(projectId, changed.change.id, { mode: 'manual', actorUserId: ownerId, acknowledged: null })
    expect(restored).toMatchObject({ ok: true, status: 'restored' })
    expect((await bucket('gallery'))?.uploadPolicy).toBe('signed_in')
    expect((await upload(publishableKey, { bucket: 'gallery', userToken: signedIn() })).status).toBe(200)
  }, 120_000)

  it('reads a bucket that takes signed-in users as a change recorded before buckets said this does, and restores one to it', async () => {
    const legacy = await prisma.storageBucket.create({ data: { projectId, name: 'legacy', uploadPolicy: 'signed_in' } })
    const key = `bucket:${legacy.id}`
    const recorded = (await storageAdapter.capture(projectId))[key]
    // Recorded as every bucket was before: no uploadPolicy among its settings.
    expect(recorded.fields).not.toHaveProperty('uploadPolicy')
    await prisma.storageBucket.update({ where: { id: legacy.id }, data: { uploadPolicy: 'server_only' } })
    expect((await storageAdapter.capture(projectId))[key].fields).toMatchObject({ uploadPolicy: 'server_only' })
    await prisma.$transaction((tx) =>
      storageAdapter.apply(tx, projectId, { resource: 'storage', key, before: recorded, after: { ...recorded, fields: { ...recorded.fields, isPublic: true } } }),
    )
    expect((await bucket('legacy'))?.uploadPolicy).toBe('signed_in')
  })

  it('is offered by the console, which lists each bucket’s rule and refuses a value it does not know', async () => {
    const products = await bucket('products')
    const { PATCH } = await import('@/app/api/storage/buckets/[bucketId]/route')
    const { GET } = await import('@/app/api/storage/buckets/route')
    const patch = async (body: unknown) =>
      answer(await PATCH(consoleReq('PATCH', `/api/storage/buckets/${products!.id}`, body), { params: Promise.resolve({ bucketId: products!.id }) }))

    const listed = await answer(await GET(consoleReq('GET', '/api/storage/buckets')))
    expect(listed.status).toBe(200)
    expect(listed.body.buckets.find((b: any) => b.name === 'products')).toMatchObject({ uploads: 'server_only' })
    expect(listed.body.buckets.find((b: any) => b.name === 'avatars')).toMatchObject({ uploads: 'signed_in' })

    const open = await patch({ uploads: 'signed_in' })
    expect(open.status).toBe(200)
    expect(open.body.bucket).toMatchObject({ name: 'products', uploads: 'signed_in' })
    expect((await bucket('products'))?.uploadPolicy).toBe('signed_in')

    const bad = await patch({ uploads: 'everyone' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('signed_in')
    expect((await bucket('products'))?.uploadPolicy).toBe('signed_in')
  }, 60_000)
})
