/**
 * BEHIND A SIGNED CDN, EVERY FILE LEAVES FROM THE EDGE, AND ONLY AFTER OUR CHECKS
 * ==============================================================================
 * With a signed CDN configured (Backenly Cloud's CloudFront), the download
 * route still decides who may read (bucket policy, pause, usage restriction)
 * and then redirects to a short-lived CloudFront signed URL instead of
 * streaming the bytes through the app; private file URLs are signed CDN URLs
 * rather than presigned S3 ones; and nothing is signed for a restricted or
 * unauthorised reader.
 *
 * The signature is checked with the matching public key over the exact canned
 * policy CloudFront verifies. Real database and the real route; the S3 driver
 * is selected, but no network call is made on any path under test.
 */

import '../../tests/helpers/real-web-standard'

import { createVerify, generateKeyPairSync, randomBytes, randomUUID } from 'crypto'

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

process.env.STORAGE_DRIVER = 's3'
process.env.STORAGE_S3_BUCKET = 'backenly-app-test-bucket'
process.env.STORAGE_S3_REGION = 'ap-south-1'
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || 'signed-cdn-suite-secret'
process.env.NEXT_PUBLIC_APP_URL = 'https://app.test.invalid'
process.env.STORAGE_CDN_URL = 'https://files.test.invalid'
process.env.STORAGE_CDN_KEY_PAIR_ID = 'K2TESTKEYPAIR'
process.env.STORAGE_CDN_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n') // as Secrets Manager hands it over

import { prisma } from '@/lib/db/prisma'
import { cannedPolicy, signCdnUrl, signedCdnConfig } from '@/lib/storage/cdn'
import { invalidateRestrictions } from '@/lib/usage/restrictions'

type DownloadHandler = (req: unknown, ctx: { params: Promise<{ fileId: string }> }) => Promise<any>
let download: DownloadHandler
let storageService: any

const DB_URL = process.env.TEST_DATABASE_URL ?? ''
const users: string[] = []

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

/** Undo CloudFront's URL-safe base64 and check the signature over the canned policy. */
function verifies(url: string): boolean {
  const u = new URL(url)
  const expires = Number(u.searchParams.get('Expires'))
  const sig = (u.searchParams.get('Signature') ?? '').replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/')
  const resource = `${u.origin}${u.pathname}`
  const v = createVerify('RSA-SHA1')
  v.update(cannedPolicy(resource, expires))
  return v.verify(publicKey, Buffer.from(sig, 'base64'))
}

async function owner() {
  const user = await prisma.user.create({ data: { email: `cdn-${randomUUID()}@test.invalid`, name: 'CDN' }, select: { id: true } })
  users.push(user.id)
  const project = await prisma.project.create({ data: { name: 'cdn', userId: user.id }, select: { id: true } })
  return { userId: user.id, projectId: project.id }
}

async function file(projectId: string, accessPolicy: 'public_read' | 'private') {
  const bucket = await prisma.storageBucket.create({
    data: { name: `b-${randomBytes(4).toString('hex')}`, projectId, isPublic: accessPolicy === 'public_read', accessPolicy },
  })
  return prisma.storageFile.create({
    data: {
      bucketId: bucket.id,
      projectId,
      name: 'a b.png',
      path: `${projectId}/${bucket.id}/a b.png`,
      isPublic: accessPolicy === 'public_read',
      size: BigInt(10),
      mimeType: 'image/png',
    },
  })
}

function anonymous() {
  return { nextUrl: { searchParams: new URLSearchParams() }, headers: { get: () => null }, cookies: { get: () => undefined } } as any
}

beforeAll(async () => {
  assertSafeTestDatabase()
  ;({ GET: download } = (await import('@/app/api/storage/files/[fileId]/download/route')) as any)
  ;({ storageService } = await import('@/lib/services/storage'))
}, 180_000)

beforeEach(() => invalidateRestrictions())

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "usage_limit_states" WHERE "billingAccountId" = ANY(${users}::text[])`
  await prisma.storageFile.deleteMany({ where: { project: { userId: { in: users } } } })
  await prisma.storageBucket.deleteMany({ where: { project: { userId: { in: users } } } })
  await prisma.project.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
})

describe('the signature', () => {
  it('is the canned policy CloudFront verifies, over exactly this object', () => {
    const cfg = signedCdnConfig()!
    const now = new Date('2026-09-28T12:00:00Z')
    const url = signCdnUrl('p1/b1/a b.png', 900, cfg, now)

    expect(url.startsWith('https://files.test.invalid/p1/b1/a%20b.png?Expires=')).toBe(true)
    const u = new URL(url)
    expect(Number(u.searchParams.get('Expires'))).toBe(Math.floor(now.getTime() / 1000) + 900)
    expect(u.searchParams.get('Key-Pair-Id')).toBe('K2TESTKEYPAIR')
    expect(u.searchParams.get('Signature')).toMatch(/^[A-Za-z0-9\-_~]+$/)
    expect(verifies(url)).toBe(true)
    // A different object under the same signature does not verify.
    expect(verifies(url.replace('a%20b.png', 'other.png'))).toBe(false)
  })

  it('clamps the lifetime to between a minute and a day', () => {
    const cfg = signedCdnConfig()!
    const now = new Date('2026-09-28T12:00:00Z')
    const exp = (ttl: number) => Number(new URL(signCdnUrl('k', ttl, cfg, now)).searchParams.get('Expires')) - now.getTime() / 1000
    expect(exp(1)).toBe(60)
    expect(exp(10 * 86_400)).toBe(86_400)
  })

  it('is configured only with an https CDN, a key pair id and a private key', () => {
    expect(signedCdnConfig({ STORAGE_CDN_URL: 'https://x.invalid' } as any)).toBeNull()
    expect(signedCdnConfig({ STORAGE_CDN_URL: 'http://x.invalid', STORAGE_CDN_KEY_PAIR_ID: 'K', STORAGE_CDN_PRIVATE_KEY: 'p' } as any)).toBeNull()
    expect(signedCdnConfig()!.privateKey).toContain('\n') // escaped newlines restored
  })
})

describe('delivery', () => {
  it('redirects a permitted download to a signed CDN URL for that object', async () => {
    const { projectId } = await owner()
    const f = await file(projectId, 'public_read')

    const res = await download(anonymous(), { params: Promise.resolve({ fileId: f.id }) })

    expect(res.status).toBe(302)
    const location = res.headers.get('location')
    expect(location).toContain(`https://files.test.invalid/${projectId}/`)
    expect(verifies(location)).toBe(true)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('signs nothing for a reader the bucket refuses, or while egress is restricted', async () => {
    const { userId, projectId } = await owner()
    const priv = await file(projectId, 'private')
    expect((await download(anonymous(), { params: Promise.resolve({ fileId: priv.id }) })).status).toBe(401)

    const pub = await file(projectId, 'public_read')
    await prisma.usageLimitState.create({
      data: { billingAccountId: userId, axis: 'egress_bytes', overSince: new Date(Date.now() - 9 * 86_400_000) },
    })
    invalidateRestrictions()
    const refused = await download(anonymous(), { params: Promise.resolve({ fileId: pub.id }) })
    expect(refused.status).toBe(403)
    expect(refused.headers.get('location')).toBeNull()
  })

  it('hands out signed CDN URLs for private files and the app route for public ones', async () => {
    const { userId, projectId } = await owner()
    const priv = await file(projectId, 'private')
    const pub = await file(projectId, 'public_read')

    const privateUrl = await storageService.getFileUrl(priv.id, projectId, 600)
    expect(privateUrl.startsWith('https://files.test.invalid/')).toBe(true)
    expect(verifies(privateUrl)).toBe(true)
    expect(await storageService.getFileUrl(pub.id, projectId)).toBe(`https://app.test.invalid/api/storage/files/${pub.id}/download`)

    // Restricted: no signed URL at all; the app route answers with the reason.
    await prisma.usageLimitState.create({
      data: { billingAccountId: userId, axis: 'egress_bytes', overSince: new Date(Date.now() - 9 * 86_400_000) },
    })
    invalidateRestrictions()
    expect(await storageService.getFileUrl(priv.id, projectId, 600)).toBe(`https://app.test.invalid/api/storage/files/${priv.id}/download`)
  })
})
