/**
 * THE CONSOLE SAYS WHO SENT EACH FILE
 * ===================================
 *
 * Production QA (2026-11-09): a store's bucket held anon.png, sent by a caller
 * with only the public key, and the Storage page had no way to show it: the
 * console listing carried no uploader, and the only record of one,
 * `uploadedBy`, is null for an anonymous upload, a server's upload and the
 * owner's own upload alike.
 *
 * Through the real upload routes and the console's listing, against a real
 * database: each upload path records who sent the file, and the listing names
 * them, a signed-in end user by their email from the project's own users
 * table. A file uploaded before this was recorded says nothing rather than
 * guessing.
 */
import '@/tests/helpers/real-web-standard'
import os from 'os'
import { randomBytes, randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { hashApiKey } from '@/server/lib/end-user-identity'

const PROJECT_JWT_SECRET = `who-uploaded-${'s'.repeat(40)}`
const SHOPPER = randomUUID()
const originalEdition = process.env.BACKENLY_EDITION

let ownerId = ''
let ownerEmail = ''
let projectId = ''
let publicKey = ''
let serviceKey = ''

const shopperToken = () =>
  jwt.sign({ userId: SHOPPER, projectId, role: 'user' }, PROJECT_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })

async function apiUpload(name: string, key: string, userToken?: string) {
  const { POST } = await import('@/app/api/v1/[projectId]/storage/upload/route')
  const form = new FormData()
  form.set('file', new File([`bytes of ${name}`], name, { type: 'text/plain' }))
  form.set('bucket', 'photos')
  form.set('path', name)
  const headers: Record<string, string> = { 'x-api-key': key }
  if (userToken) headers['x-user-token'] = userToken
  const res = await POST(
    new NextRequest(`http://localhost:3000/api/v1/${projectId}/storage/upload`, { method: 'POST', headers, body: form }),
    { params: Promise.resolve({ projectId }) },
  )
  expect(res.status).toBe(200)
}

const session = async () => `auth-token=${(await createSession(ownerId, ownerEmail)).token}`

async function consoleUpload(name: string) {
  const { POST } = await import('@/app/api/storage/upload/route')
  const bucket = await prisma.storageBucket.findFirstOrThrow({ where: { projectId, name: 'photos' } })
  const form = new FormData()
  form.set('file', new File([`bytes of ${name}`], name, { type: 'text/plain' }))
  form.set('bucketId', bucket.id)
  const res = await POST(
    new NextRequest('http://localhost:3000/api/storage/upload', {
      method: 'POST',
      headers: { cookie: await session(), 'x-project-id': projectId },
      body: form,
    }),
  )
  expect(res.status).toBe(200)
}

async function consoleListing() {
  const { GET } = await import('@/app/api/storage/files/route')
  const res = await GET(
    new NextRequest(`http://localhost:3000/api/storage/files?limit=50`, {
      headers: { cookie: await session(), 'x-project-id': projectId },
    }),
  )
  expect(res.status).toBe(200)
  const body = await res.json()
  return Object.fromEntries(
    (body.files as Array<{ name: string; uploader: unknown }>).map((f) => [f.name.split('/').pop(), f.uploader]),
  )
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.STORAGE_DRIVER = 'local'
  process.env.STORAGE_DIR = `${os.tmpdir()}/.storage-who-uploaded-${process.pid}`
  process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || `t${'0'.repeat(40)}`

  ownerEmail = `who-uploaded-${randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, password: 'not-a-real-hash', name: 'Store Owner' } })).id
  projectId = (
    await prisma.project.create({ data: { name: `who-${randomUUID().slice(0, 8)}`, userId: ownerId, jwtSecret: PROJECT_JWT_SECRET } })
  ).id

  // The project's own users table, where the console reads an end user's email.
  const schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."users" (id uuid PRIMARY KEY, email text NOT NULL, is_blocked boolean NOT NULL DEFAULT false)`)
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."users" (id, email) VALUES ($1::uuid, 'shopper@example.test')`, SHOPPER)

  const mint = async (name: string, serviceRole: boolean) => {
    const raw = `proj_live_${randomBytes(24).toString('hex')}`
    await prisma.apiKey.create({
      data: {
        name, keyPrefix: raw.slice(0, 16), keyHash: hashApiKey(raw), permissions: ['read', 'write'], capabilities: [],
        userId: ownerId, projectId, keyType: 'public', scope: 'runtime', serviceRole, rateLimit: 1000,
      },
    })
    return raw
  }
  publicKey = await mint('web app', false)
  serviceKey = await mint('backend', true)
  await prisma.storageBucket.create({ data: { name: 'photos', projectId, isPublic: true, accessPolicy: 'public_read' } })

  await apiUpload('mug.txt', publicKey, shopperToken())
  await apiUpload('anon.txt', publicKey)
  await apiUpload('feed.txt', serviceKey)
  await consoleUpload('banner.txt')
  // A file from before the uploader was recorded: nothing but a null uploadedBy.
  const bucket = await prisma.storageBucket.findFirstOrThrow({ where: { projectId, name: 'photos' } })
  await prisma.storageFile.create({
    data: { bucketId: bucket.id, projectId, name: 'old.txt', path: `${projectId}/old.txt`, size: BigInt(3), mimeType: 'text/plain' },
  })
}, 120_000)

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('the Storage page names who sent each file', () => {
  it('an upload with only the public key is Anonymous', async () => {
    expect((await consoleListing())['anon.txt']).toEqual({ kind: 'anonymous', label: 'Anonymous' })
  })

  it('a signed-in user of the app is named by their email', async () => {
    expect((await consoleListing())['mug.txt']).toEqual({ kind: 'end_user', label: 'shopper@example.test' })
  })

  it('a server is named by its key', async () => {
    expect((await consoleListing())['feed.txt']).toEqual({ kind: 'server_key', label: 'Server key “backend”' })
  })

  it('the owner’s own upload from the console is named by their account', async () => {
    expect((await consoleListing())['banner.txt']).toEqual({ kind: 'console', label: 'Store Owner' })
  })

  it('a file uploaded before this was recorded says nothing, rather than guessing', async () => {
    expect((await consoleListing())['old.txt']).toBeNull()
  })
})

describe('every upload path records who sent the file', () => {
  const pending = (uploadId: string) =>
    prisma.storageFile.findFirstOrThrow({
      where: { projectId, metadata: { path: ['uploadId'], equals: uploadId } },
      select: { uploadedBy: true, metadata: true },
    })

  it('a multipart upload records the end user on its tracking row', async () => {
    const { POST } = await import('@/app/api/v1/[projectId]/storage/upload-multipart/route')
    const res = await POST(
      new NextRequest(`http://localhost:3000/api/v1/${projectId}/storage/upload-multipart?action=initiate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': publicKey, 'x-user-token': shopperToken() },
        body: JSON.stringify({ filename: 'clip.mp4', contentType: 'video/mp4', contentLength: 1024, bucket: 'photos' }),
      }),
      { params: Promise.resolve({ projectId }) },
    )
    expect(res.status).toBe(200)
    const row = await pending((await res.json()).data.uploadId)
    expect(row.uploadedBy).toBe(SHOPPER)
    expect((row.metadata as any).uploader).toEqual({ kind: 'end_user' })
  }, 60_000)

  it('a signed upload records an anonymous caller and the key it used', async () => {
    const { POST } = await import('@/app/api/v1/[projectId]/storage/signed-upload/route')
    const before = { driver: process.env.STORAGE_DRIVER, bucket: process.env.STORAGE_S3_BUCKET, region: process.env.STORAGE_S3_REGION }
    process.env.STORAGE_DRIVER = 's3'
    process.env.STORAGE_S3_BUCKET = process.env.STORAGE_S3_BUCKET || 'test-bucket'
    process.env.STORAGE_S3_REGION = process.env.STORAGE_S3_REGION || 'ap-south-1'
    process.env.STORAGE_S3_ACCESS_KEY = process.env.STORAGE_S3_ACCESS_KEY || 'who-uploaded-not-a-real-key'
    process.env.STORAGE_S3_SECRET_KEY = process.env.STORAGE_S3_SECRET_KEY || 'who-uploaded-not-a-real-secret'
    try {
      const res = await POST(
        new NextRequest(`http://localhost:3000/api/v1/${projectId}/storage/signed-upload`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': publicKey },
          body: JSON.stringify({ filename: 'movie.mp4', contentType: 'video/mp4', contentLength: 2048, bucket: 'photos' }),
        }),
        { params: Promise.resolve({ projectId }) },
      )
      expect(res.status).toBe(200)
      const { fileId } = (await res.json()).data
      const row = await prisma.storageFile.findUniqueOrThrow({ where: { id: fileId }, select: { uploadedBy: true, metadata: true } })
      const key = await prisma.apiKey.findFirstOrThrow({ where: { projectId, name: 'web app' }, select: { id: true } })
      expect(row.uploadedBy).toBeNull()
      expect((row.metadata as any).uploader).toEqual({ kind: 'anonymous', apiKeyId: key.id })
    } finally {
      process.env.STORAGE_DRIVER = before.driver
    }
  }, 60_000)
})
