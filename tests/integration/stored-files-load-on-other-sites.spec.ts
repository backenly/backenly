/**
 * A FILE ANYONE MAY READ LOADS ON ANY SITE; ONE READ ON YOUR IDENTITY DOES NOT
 * ===========================================================================
 *
 * Production QA re-test, 2026-11-16, new finding N3: a store's product photos
 * did not show on the store's own site. The file URL
 * (/api/storage/files/<id>/download) answered `Cross-Origin-Resource-Policy:
 * same-site`, like every response of the domain, and Chromium refuses that in
 * an <img> on any other site, the store's own domain and localhost included
 * (net::ERR_BLOCKED_BY_RESPONSE.NotSameSite). The policy is checked on the 302
 * itself, before the redirect to the CDN is followed.
 *
 * The route now answers by who may read the file: `cross-origin` for a file
 * anyone may read and for a signed link, `same-site` for a read on the caller's
 * own identity and for every refusal. next.config.js leaves the header of this
 * one path to the route (tests/unit/cross-origin-resource-policy.spec.ts).
 *
 * Real database and the real route, through the signed CDN (Backenly Cloud) and
 * through the app's own bytes (a self-hosted install). No network call.
 */

import '../helpers/real-web-standard'

import crypto, { generateKeyPairSync, randomUUID } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import jwt from 'jsonwebtoken'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

// The storage service is built from STORAGE_DRIVER when it is first imported:
// local, so the app's own bytes come from disk. The route chooses the CDN by
// STORAGE_DRIVER at request time, so each test says which it is.
process.env.STORAGE_DRIVER = 'local'
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || 'resource-policy-suite-secret'
process.env.STORAGE_CDN_URL = 'https://files.test.invalid'
process.env.STORAGE_CDN_KEY_PAIR_ID = 'K2TESTKEYPAIR'
process.env.STORAGE_CDN_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n')

import { prisma } from '@/lib/db/prisma'

type DownloadHandler = (req: unknown, ctx: { params: Promise<{ fileId: string }> }) => Promise<any>
let download: DownloadHandler
const users: string[] = []
let dir = ''
let projectId = ''
let ownerId = ''
let ownerSession = ''

const POLICY = 'cross-origin-resource-policy'

function request(opts: { token?: string; bearer?: string } = {}) {
  const params = new URLSearchParams()
  if (opts.token) params.set('token', opts.token)
  return {
    nextUrl: { searchParams: params },
    headers: { get: (n: string) => (n.toLowerCase() === 'authorization' && opts.bearer ? `Bearer ${opts.bearer}` : null) },
    cookies: { get: () => undefined },
  } as any
}

const get = (fileId: string, opts: { token?: string; bearer?: string } = {}) =>
  download(request(opts), { params: Promise.resolve({ fileId }) })

/** A signed link for one object, as storageService mints it. */
function signedToken(fileId: string): string {
  const expires = Date.now() + 600_000
  const hmac = crypto.createHmac('sha256', process.env.STORAGE_SECRET!).update(`${fileId}:${expires}`).digest('hex')
  return `${expires}:${hmac}`
}

/** A real platform session: authenticateRequest wants the JWT and its Session row. */
async function sessionFor(userId: string): Promise<string> {
  const token = jwt.sign({ userId, email: `${userId}@example.test`, role: 'user' }, process.env.JWT_SECRET!, { expiresIn: '10m' })
  await prisma.session.create({ data: { userId, token, expiresAt: new Date(Date.now() + 10 * 60_000) } })
  return token
}

async function file(accessPolicy: 'public_read' | 'private') {
  const bucket = await prisma.storageBucket.create({
    data: { name: `b-${crypto.randomBytes(4).toString('hex')}`, projectId, isPublic: accessPolicy === 'public_read', accessPolicy },
  })
  const path = join(dir, `${crypto.randomBytes(5).toString('hex')}.png`)
  writeFileSync(path, Buffer.from('not really a png'))
  return prisma.storageFile.create({
    data: {
      bucketId: bucket.id,
      projectId,
      name: 'photo.png',
      path,
      isPublic: accessPolicy === 'public_read',
      size: BigInt(16),
      mimeType: 'image/png',
    },
  })
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ;({ GET: download } = (await import('@/app/api/storage/files/[fileId]/download/route')) as any)
  dir = mkdtempSync(join(tmpdir(), 'resource-policy-'))
  ownerId = (await prisma.user.create({ data: { email: `corp-${randomUUID()}@test.invalid`, name: 'corp' }, select: { id: true } })).id
  users.push(ownerId)
  projectId = (await prisma.project.create({ data: { name: 'corp', userId: ownerId }, select: { id: true } })).id
  ownerSession = await sessionFor(ownerId)
}, 180_000)

afterEach(() => {
  process.env.STORAGE_DRIVER = 'local'
})

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: users } } })
  await prisma.storageFile.deleteMany({ where: { projectId } })
  await prisma.storageBucket.deleteMany({ where: { projectId } })
  await prisma.project.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
  rmSync(dir, { recursive: true, force: true })
})

describe('through the signed CDN (Backenly Cloud)', () => {
  beforeEach(() => {
    process.env.STORAGE_DRIVER = 's3'
  })

  it('lets any site embed the redirect for a file anyone may read', async () => {
    const res = await get((await file('public_read')).id)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('https://files.test.invalid/')
    expect(res.headers.get(POLICY)).toBe('cross-origin')
  })

  it('lets any site embed the redirect a signed link grants', async () => {
    const f = await file('private')
    const res = await get(f.id, { token: signedToken(f.id) })
    expect(res.status).toBe(302)
    expect(res.headers.get(POLICY)).toBe('cross-origin')
  })

  it('keeps a private file read on the owner\'s own session to the same site', async () => {
    const f = await file('private')
    const res = await get(f.id, { bearer: ownerSession })
    expect(res.status).toBe(302)
    expect(res.headers.get(POLICY)).toBe('same-site')
  })

  it('keeps every refusal to the same site', async () => {
    const f = await file('private')
    const refused = await get(f.id)
    expect(refused.status).toBe(401)
    expect(refused.headers.get(POLICY)).toBe('same-site')
    const forged = await get(f.id, { token: `${Date.now() + 600_000}:${'0'.repeat(64)}` })
    expect(forged.status).toBe(401)
    expect(forged.headers.get(POLICY)).toBe('same-site')
    const missing = await get(randomUUID())
    expect(missing.status).toBe(404)
    expect(missing.headers.get(POLICY)).toBe('same-site')
  })
})

describe('through the app’s own bytes (self-hosted)', () => {
  it('lets any site embed a file anyone may read', async () => {
    const res = await get((await file('public_read')).id)
    expect(res.status).toBe(200)
    expect(res.headers.get(POLICY)).toBe('cross-origin')
  })

  it('keeps a private file read on the owner\'s own session to the same site', async () => {
    const f = await file('private')
    const res = await get(f.id, { bearer: ownerSession })
    expect(res.status).toBe(200)
    expect(res.headers.get(POLICY)).toBe('same-site')
  })
})
