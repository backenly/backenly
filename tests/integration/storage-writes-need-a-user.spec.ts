/**
 * Writing to a project's storage through the public API needs a signed-in end
 * user, or a server with a service-role key. A key alone is not enough: every
 * key but a service-role key may sit in a browser bundle, and the publishable
 * key sits in every one.
 *
 * Each write route is called the way a stranger would call it: with the app's
 * publishable key and no user. Nothing may be stored, started or removed.
 */

import '@/tests/helpers/real-web-standard'
import { randomBytes, randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'

const PROJECT_JWT_SECRET = `storage-writers-${'s'.repeat(40)}`
const USER = randomUUID()

let ownerId = ''
let projectId = ''
let bucketId = ''
let publishableKey = ''
let readOnlyKey = ''
let serviceKey = ''

const tokenFor = (userId: string) =>
  jwt.sign({ userId, projectId, role: 'user' }, PROJECT_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })

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
const filesIn = () => prisma.storageFile.count({ where: { projectId } })

async function upload(key: string, userToken?: string) {
  const { POST } = await import('@/app/api/v1/[projectId]/storage/upload/route')
  const form = new FormData()
  form.set('file', new File(['hello'], 'note.txt', { type: 'text/plain' }))
  form.set('bucket', 'uploads')
  form.set('path', `note-${randomBytes(3).toString('hex')}.txt`)
  const res: any = await POST(req({ method: 'POST', path: `/api/v1/${projectId}/storage/upload`, key, userToken, form }) as any, params())
  return { status: res.status as number, body: await res.json() }
}

beforeAll(async () => {
  process.env.STORAGE_DRIVER = 'local'
  process.env.STORAGE_DIR = `${require('os').tmpdir()}/.storage-writers-test-${process.pid}`
  process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || `t${'0'.repeat(40)}`
  ownerId = (await prisma.user.create({ data: { email: `sw-${randomUUID()}@test.invalid`, name: 'Storage writers' }, select: { id: true } })).id
  projectId = (await prisma.project.create({
    data: { name: `sw-${randomUUID().slice(0, 8)}`, userId: ownerId, jwtSecret: PROJECT_JWT_SECRET },
    select: { id: true },
  })).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
  const mk = async (name: string, permissions: string[], serviceRole: boolean) => {
    const raw = `proj_live_${randomBytes(24).toString('hex')}`
    await prisma.apiKey.create({
      data: {
        name, keyPrefix: raw.slice(0, 16), keyHash: hashApiKey(raw), permissions, capabilities: [],
        userId: ownerId, projectId, keyType: 'public', scope: 'runtime', serviceRole, rateLimit: 1000,
      },
    })
    return raw
  }
  publishableKey = await mk('publishable', ['read', 'write'], false)
  readOnlyKey = await mk('read only', ['read'], false)
  serviceKey = await mk('server', ['read', 'write'], true)
  bucketId = (await prisma.storageBucket.create({
    data: { name: 'uploads', projectId, isPublic: true, accessPolicy: 'public_read' },
    select: { id: true },
  })).id
}, 120_000)

afterAll(async () => {
  await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('who may write to storage', () => {
  it('refuses an upload with the publishable key and no user, and stores nothing', async () => {
    const before = await filesIn()
    const r = await upload(publishableKey)
    expect(r.status).toBe(401)
    expect(r.body?.error?.code ?? r.body?.code).toBe('SIGN_IN_REQUIRED')
    expect(await filesIn()).toBe(before)
  })

  it('accepts the same upload from a signed-in end user, recorded as theirs', async () => {
    const r = await upload(publishableKey, tokenFor(USER))
    expect([200, 201]).toContain(r.status)
    const row = await prisma.storageFile.findUnique({ where: { id: r.body?.data?.id }, select: { uploadedBy: true } })
    expect(row?.uploadedBy).toBe(USER)
  })

  it('accepts an upload from a server with a service-role key', async () => {
    const r = await upload(serviceKey)
    expect([200, 201]).toContain(r.status)
  })

  it('refuses a signed upload URL to the publishable key and no user', async () => {
    const { POST } = await import('@/app/api/v1/[projectId]/storage/signed-upload/route')
    const res: any = await POST(req({
      method: 'POST', path: `/api/v1/${projectId}/storage/signed-upload`, key: publishableKey,
      json: { bucket: 'uploads', path: 'big.bin', contentType: 'application/octet-stream', size: 10 },
    }) as any, params())
    expect(res.status).toBe(401)
  })

  it('refuses to confirm an upload for the publishable key and no user', async () => {
    const { POST } = await import('@/app/api/v1/[projectId]/storage/confirm-upload/route')
    const res: any = await POST(req({
      method: 'POST', path: `/api/v1/${projectId}/storage/confirm-upload`, key: publishableKey, json: { fileId: randomUUID() },
    }) as any, params())
    expect(res.status).toBe(401)
  })

  it('refuses to start a multipart upload for the publishable key and no user', async () => {
    const { POST } = await import('@/app/api/v1/[projectId]/storage/upload-multipart/route')
    const res: any = await POST(req({
      method: 'POST', path: `/api/v1/${projectId}/storage/upload-multipart`, key: publishableKey, query: '?action=initiate',
      json: { bucket: 'uploads', filename: 'big.bin', contentType: 'application/octet-stream', contentLength: 10 },
    }) as any, params())
    expect(res.status).toBe(401)
  })

  it("will not let a read-only key, or another user, abort someone's upload", async () => {
    const uploadId = randomUUID()
    const row = await prisma.storageFile.create({
      data: {
        bucketId, projectId, name: 'started.bin', path: `${uploadId}/started.bin`, size: BigInt(10),
        mimeType: 'application/octet-stream', isPublic: false, uploadedBy: USER,
        metadata: { uploadId, status: 'uploading' },
      },
    })
    const { DELETE } = await import('@/app/api/v1/[projectId]/storage/upload-multipart/route')
    const abort = async (key: string, userToken?: string) =>
      (await DELETE(req({ method: 'DELETE', path: `/api/v1/${projectId}/storage/upload-multipart`, key, userToken, query: `?uploadId=${uploadId}` }) as any, params()) as any).status
    expect(await abort(readOnlyKey)).toBe(403)
    expect(await abort(publishableKey)).toBe(401)
    expect(await abort(publishableKey, tokenFor(randomUUID()))).toBe(403)
    expect(await prisma.storageFile.findUnique({ where: { id: row.id } })).not.toBeNull()
    // The user who started it may.
    expect(await abort(publishableKey, tokenFor(USER))).toBeLessThan(300)
  })

  it('continues and completes a multipart upload only for the end user who started it, or a service key', async () => {
    const { POST, PUT } = await import('@/app/api/v1/[projectId]/storage/upload-multipart/route')
    const path = `/api/v1/${projectId}/storage/upload-multipart`
    const started: any = await POST(req({
      method: 'POST', path, key: publishableKey, userToken: tokenFor(USER), query: '?action=initiate',
      json: { bucket: 'uploads', filename: 'clip.txt', contentType: 'text/plain', contentLength: 11 },
    }) as any, params())
    expect(started.status).toBe(200)
    const uploadId = (await started.json()).data.uploadId as string
    const part = async (userToken: string | undefined, bytes: string, key = publishableKey) =>
      (await PUT(req({ method: 'PUT', path, key, userToken, bytes, query: `?action=upload&uploadId=${uploadId}&partNumber=1&totalParts=1` }) as any, params()) as any).status
    const complete = async (userToken: string | undefined, key = publishableKey) =>
      (await POST(req({ method: 'POST', path, key, userToken, query: `?action=complete&uploadId=${uploadId}&totalParts=1` }) as any, params()) as any)

    const someoneElse = tokenFor(randomUUID())
    expect(await part(someoneElse, 'B wrote this instead')).toBe(403)
    expect(await part(tokenFor(USER), 'part from A')).toBe(200)
    expect((await complete(someoneElse)).status).toBe(403)
    const tracking = await prisma.storageFile.findFirst({ where: { projectId, metadata: { path: ['uploadId'], equals: uploadId } }, select: { id: true } })
    expect(tracking).not.toBeNull()

    const done = await complete(tokenFor(USER))
    expect(done.status).toBe(200)
    const file = (await done.json()).data
    expect(file.size).toBe('part from A'.length)
    expect(await prisma.storageFile.findUnique({ where: { id: file.id }, select: { uploadedBy: true } })).toEqual({ uploadedBy: USER })
  })

  it("lets a server's service key carry on an upload an end user started", async () => {
    const { POST, PUT } = await import('@/app/api/v1/[projectId]/storage/upload-multipart/route')
    const path = `/api/v1/${projectId}/storage/upload-multipart`
    const started: any = await POST(req({
      method: 'POST', path, key: publishableKey, userToken: tokenFor(USER), query: '?action=initiate',
      json: { bucket: 'uploads', filename: 'clip2.txt', contentType: 'text/plain', contentLength: 6 },
    }) as any, params())
    const uploadId = (await started.json()).data.uploadId as string
    const put: any = await PUT(req({ method: 'PUT', path, key: serviceKey, bytes: 'server', query: `?action=upload&uploadId=${uploadId}&partNumber=1&totalParts=1` }) as any, params())
    expect(put.status).toBe(200)
    const done: any = await POST(req({ method: 'POST', path, key: serviceKey, query: `?action=complete&uploadId=${uploadId}&totalParts=1` }) as any, params())
    expect(done.status).toBe(200)
  })

  it('confirms a signed upload, and hands back its link, only for the end user who started it or a service key', async () => {
    const { POST } = await import('@/app/api/v1/[projectId]/storage/confirm-upload/route')
    const payslips = await prisma.storageBucket.create({
      data: { name: 'payslips', projectId, isPublic: false, accessPolicy: 'private' },
      select: { id: true },
    })
    const started = (uploadedBy: string | null) =>
      prisma.storageFile.create({
        data: {
          bucketId: payslips.id, projectId, name: 'payslip.pdf', path: `projects/${projectId}/buckets/payslips/${randomUUID()}/payslip.pdf`,
          size: BigInt(10), mimeType: 'application/pdf', isPublic: false, uploadedBy,
          metadata: { uploadId: randomUUID(), status: 'pending' },
        },
        select: { id: true },
      })
    const confirm = async (fileId: string, key: string, userToken?: string) => {
      const res: any = await POST(req({
        method: 'POST', path: `/api/v1/${projectId}/storage/confirm-upload`, key, userToken, json: { fileId },
      }) as any, params())
      return { status: res.status as number, body: await res.json() }
    }
    const status = async (fileId: string) =>
      ((await prisma.storageFile.findUnique({ where: { id: fileId }, select: { metadata: true } }))!.metadata as any).status

    const theirs = await started(USER)
    const other = await confirm(theirs.id, publishableKey, tokenFor(randomUUID()))
    expect(other.status).toBe(403)
    expect(JSON.stringify(other.body)).not.toContain('token=')
    expect(await status(theirs.id)).toBe('pending')

    const mine = await confirm(theirs.id, publishableKey, tokenFor(USER))
    expect(mine.status).toBe(200)
    expect(mine.body.data).toMatchObject({ id: theirs.id, status: 'complete' })

    const anyones = await started(USER)
    expect((await confirm(anyones.id, serviceKey)).status).toBe(200)
  })
})
