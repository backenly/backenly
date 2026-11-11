/**
 * A PUBLIC FILE IS ONE A BROWSER MAY KEEP
 * =======================================
 *
 * Production QA (2026-11-09): a store's product image, in a Public bucket,
 * came back from the CDN with no Cache-Control at all, and its lasting URL (the
 * app's download route) redirected with `private, no-store` to a URL signed
 * afresh on every request. A browser could keep neither, so every view of every
 * product image went back through the app and out to the edge.
 *
 * The app's own route already says how long a public file may be kept when it
 * serves the bytes itself (cacheControlFor). Behind the signed CDN that answer
 * was lost twice: the object carried no header, and the redirect forbade
 * keeping it. Proven here against the real metadata database, with only the S3
 * network call stubbed and a real RSA key signing the CDN URLs:
 *
 *   - an object in a public bucket is written with the bucket's public caching,
 *     by the S3 driver and by multipart; a private one is written with none;
 *   - a public file's redirect repeats one URL for a window and may be kept for
 *     the rest of it; a private file's still may not be kept at all.
 */
import '@/tests/helpers/real-web-standard'

process.env.STORAGE_DRIVER = 'local'
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || 'public-files-cacheable-suite-secret'
process.env.STORAGE_S3_BUCKET = process.env.STORAGE_S3_BUCKET || 'test-bucket'
process.env.STORAGE_S3_REGION = process.env.STORAGE_S3_REGION || 'ap-south-1'
// uploadFile presigns the new object's URL; presigning resolves credentials,
// so the suite pins static fakes (as storage-runtime-correctness.spec.ts does).
process.env.STORAGE_S3_ACCESS_KEY = 'public-files-cacheable-not-a-real-key'
process.env.STORAGE_S3_SECRET_KEY = 'public-files-cacheable-not-a-real-secret'

import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { hashApiKey } from '@/server/lib/end-user-identity'

let ownerId: string
let ownerEmail: string
let projectId: string
let serviceKey: string
const buckets: Record<'public_read' | 'cdn_cacheable' | 'private', string> = { public_read: '', cdn_cacheable: '', private: '' }
const originalEdition = process.env.BACKENLY_EDITION

beforeAll(async () => {
  // Several projects share this database, which the single-tenant edition refuses.
  process.env.BACKENLY_EDITION = 'cloud'
  ownerEmail = `cacheable-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, password: 'not-a-real-hash', name: 'owner' } })).id
  projectId = (await prisma.project.create({ data: { name: 'public-files-cacheable', userId: ownerId } })).id
  for (const policy of ['public_read', 'cdn_cacheable', 'private'] as const) {
    buckets[policy] = (
      await prisma.storageBucket.create({
        data: { name: `b-${policy.replace('_', '-')}`, projectId, isPublic: policy !== 'private', accessPolicy: policy },
      })
    ).id
  }
  const raw = `svc_live_${crypto.randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'public-files-cacheable', keyPrefix: raw.slice(0, 16), permissions: ['read', 'write', 'admin'],
      capabilities: [], userId: ownerId, projectId, keyType: 'public', serviceRole: true, keyHash: hashApiKey(raw),
    },
  })
  serviceKey = raw
}, 120_000)

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

/** The commands the S3 client was asked to send, by name. */
async function captureS3<T>(run: () => Promise<T>, answer: Record<string, unknown> = {}) {
  const { S3Client } = await import('@aws-sdk/client-s3')
  const send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue(answer as never)
  try {
    await run()
    return send.mock.calls.map(([command]) => command as { constructor: { name: string }; input: Record<string, unknown> })
  } finally {
    send.mockRestore()
  }
}

describe('an object says how long it may be kept, as its bucket allows', () => {
  const upload = async (bucket: keyof typeof buckets, isPublic?: boolean) => {
    const { S3StorageService } = await import('@/lib/services/s3Storage')
    const commands = await captureS3(() =>
      new S3StorageService().uploadFile(
        buckets[bucket],
        { name: `photo-${crypto.randomBytes(3).toString('hex')}.png`, buffer: Buffer.from('png bytes'), mimeType: 'image/png' },
        { isPublic, projectId },
      ),
    )
    const put = commands.find((c) => c.constructor.name === 'PutObjectCommand')
    expect(put).toBeDefined()
    return put!.input.CacheControl
  }

  it('a file in a Public bucket is kept for a year: its key is new on every upload', async () => {
    expect(await upload('public_read')).toBe('public, max-age=31536000, immutable')
  }, 60_000)

  it('a file in a CDN-cacheable bucket is kept as that policy says', async () => {
    expect(await upload('cdn_cacheable')).toBe('public, max-age=86400, stale-while-revalidate=604800')
  }, 60_000)

  it('a private file carries no caching, and nor does a file kept private in a Public bucket', async () => {
    expect(await upload('private')).toBeUndefined()
    expect(await upload('public_read', false)).toBeUndefined()
  }, 60_000)

  it('a multipart upload sets it on the object its parts assemble into', async () => {
    const { POST } = await import('@/app/api/v1/[projectId]/storage/upload-multipart/route')
    const initiate = async (bucket: string) => {
      const before = process.env.STORAGE_DRIVER
      process.env.STORAGE_DRIVER = 's3'
      try {
        const commands = await captureS3(async () => {
          const res = await POST(
            new NextRequest(`http://test.local/api/v1/${projectId}/storage/upload-multipart?action=initiate`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-api-key': serviceKey },
              body: JSON.stringify({ filename: 'clip.mp4', contentType: 'video/mp4', contentLength: 1024, bucket }),
            }),
            { params: Promise.resolve({ projectId }) },
          )
          expect(res.status).toBe(200)
        }, { UploadId: 'upload-1' })
        const create = commands.find((c) => c.constructor.name === 'CreateMultipartUploadCommand')
        expect(create).toBeDefined()
        return create!.input.CacheControl
      } finally {
        process.env.STORAGE_DRIVER = before
      }
    }
    expect(await initiate('b-public-read')).toBe('public, max-age=31536000, immutable')
    expect(await initiate('b-private')).toBeUndefined()
  }, 60_000)
})

describe('behind the signed CDN, a public file’s redirect may be kept for its window', () => {
  const cdnEnv = ['STORAGE_DRIVER', 'STORAGE_CDN_URL', 'STORAGE_CDN_KEY_PAIR_ID', 'STORAGE_CDN_PRIVATE_KEY'] as const
  const saved: Record<string, string | undefined> = {}
  let publicFileId: string
  let privateFileId: string

  beforeAll(async () => {
    for (const k of cdnEnv) saved[k] = process.env[k]
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    process.env.STORAGE_CDN_URL = 'https://cdn.example.test'
    process.env.STORAGE_CDN_KEY_PAIR_ID = 'K-TEST'
    process.env.STORAGE_CDN_PRIVATE_KEY = privateKey
    const file = (bucketId: string, isPublic: boolean, name: string) =>
      prisma.storageFile.create({
        data: { bucketId, projectId, name, path: `${projectId}/${name}`, size: BigInt(9), mimeType: 'image/png', isPublic },
      })
    publicFileId = (await file(buckets.public_read, true, 'mug.png')).id
    privateFileId = (await file(buckets.private, false, 'invoice.png')).id
  })

  afterAll(() => {
    for (const k of cdnEnv) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  const download = async (fileId: string, cookie?: string) => {
    const { GET } = await import('@/app/api/storage/files/[fileId]/download/route')
    process.env.STORAGE_DRIVER = 's3'
    try {
      return await GET(
        new NextRequest(`http://test.local/api/storage/files/${fileId}/download`, { headers: cookie ? { cookie } : {} }),
        { params: Promise.resolve({ fileId }) },
      )
    } finally {
      process.env.STORAGE_DRIVER = saved.STORAGE_DRIVER
    }
  }

  it('repeats one signed URL, and lets the browser keep the redirect until the window ends', async () => {
    const first = await download(publicFileId)
    const second = await download(publicFileId)
    expect(first.status).toBe(302)
    expect(first.headers.get('location')).toMatch(/^https:\/\/cdn\.example\.test\//)
    expect(second.headers.get('location')).toBe(first.headers.get('location'))
    const maxAge = Number(first.headers.get('cache-control')?.match(/^private, max-age=(\d+)$/)?.[1])
    expect(maxAge).toBeGreaterThan(0)
    expect(maxAge).toBeLessThanOrEqual(15 * 60)
    // The URL outlives the redirect, so a kept redirect never points at an expired URL.
    const expires = Number(new URL(first.headers.get('location')!).searchParams.get('Expires'))
    expect(expires - Math.floor(Date.now() / 1000)).toBeGreaterThan(maxAge)
  }, 60_000)

  it('CONTROL: a private file’s redirect is still never kept', async () => {
    const res = await download(privateFileId, `auth-token=${(await createSession(ownerId, ownerEmail)).token}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  }, 60_000)
})
