/**
 * Storage runtime correctness (medium findings STO-08, STO-11, STO-12).
 *
 * STO-08: the S3 driver — the one Cloud runs — wrote `isPublic:
 * options?.isPublic ?? bucket.isPublic`, so a caller-supplied `true` planted
 * a world-readable row in a private bucket; only the local driver clamped to
 * the bucket policy at write time.
 *
 * STO-11: the local multipart complete called uploadFile (a second row, a
 * second quota increment) and then marked the ORIGINAL pending row complete
 * — an active phantom at a path no reader serves — and incremented storage
 * usage again on top of uploadFile's own increment. The signed-upload local
 * fallback created the same phantom with a token nothing ever consumed.
 *
 * STO-12: the metadata endpoint (the SDK's getUrl target) downloaded the
 * whole object into memory to report its size.
 *
 * The driver is pinned to local BEFORE any dynamic import, as
 * storage-bucket-policy.spec.ts documents; the S3 clamp is exercised against
 * the real metadata DB with only the S3 network call stubbed.
 */
import '@/tests/helpers/real-web-standard'

process.env.STORAGE_DRIVER = 'local'
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || 'storage-correctness-suite-secret'
process.env.STORAGE_S3_BUCKET = process.env.STORAGE_S3_BUCKET || 'test-bucket'
process.env.STORAGE_S3_REGION = process.env.STORAGE_S3_REGION || 'ap-south-1'
// uploadFile presigns the new object's URL. Presigning is a local HMAC, but the
// SDK still resolves credentials for it and CI has none, so the suite pins
// static fakes; that also keeps a developer's own AWS profile out of the run.
process.env.STORAGE_S3_ACCESS_KEY = 'storage-correctness-not-a-real-key'
process.env.STORAGE_S3_SECRET_KEY = 'storage-correctness-not-a-real-secret'

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import crypto, { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'

import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'

let ownerId: string
let projectId: string
let serviceKey: string
let privateBucketId: string
let uploadsBucketId: string

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `sto-correct-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Storage Correctness Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'storage-correctness', userId: ownerId },
      select: { id: true },
    })
  ).id
  privateBucketId = (
    await prisma.storageBucket.create({
      data: { name: 'secrets', projectId, isPublic: false, accessPolicy: 'private' },
      select: { id: true },
    })
  ).id
  uploadsBucketId = (
    await prisma.storageBucket.create({
      data: { name: 'uploads', projectId, isPublic: true, accessPolicy: 'public_read' },
      select: { id: true },
    })
  ).id
  const raw = `svc_live_${crypto.randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'storage-correctness', keyPrefix: raw.slice(0, 16), permissions: ['read', 'write', 'admin'],
      capabilities: [], userId: ownerId, projectId, keyType: 'public', serviceRole: true, keyHash: hashApiKey(raw),
    },
  })
  serviceKey = raw
}, 120_000)

afterAll(async () => {
  await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('STO-08: the S3 driver clamps isPublic to the bucket policy', () => {
  it('a requested public write lands private in a private bucket', async () => {
    const { S3StorageService } = await import('@/lib/services/s3Storage')
    const { S3Client } = await import('@aws-sdk/client-s3')
    const send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never)
    try {
      const svc = new S3StorageService()
      const stored = await svc.uploadFile(
        privateBucketId,
        { name: 'leak.txt', buffer: Buffer.from('secret'), mimeType: 'text/plain' },
        { isPublic: true, projectId },
      )
      const row = await prisma.storageFile.findUnique({ where: { id: String(stored.id) }, select: { isPublic: true } })
      expect(row?.isPublic).toBe(false)
    } finally {
      send.mockRestore()
    }
  }, 60_000)

  it('control: the same write into a public_read bucket stays public', async () => {
    const { S3StorageService } = await import('@/lib/services/s3Storage')
    const { S3Client } = await import('@aws-sdk/client-s3')
    const send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never)
    try {
      const svc = new S3StorageService()
      const stored = await svc.uploadFile(
        uploadsBucketId,
        { name: 'banner.txt', buffer: Buffer.from('hello'), mimeType: 'text/plain' },
        { isPublic: true, projectId },
      )
      const row = await prisma.storageFile.findUnique({ where: { id: String(stored.id) }, select: { isPublic: true } })
      expect(row?.isPublic).toBe(true)
    } finally {
      send.mockRestore()
    }
  }, 60_000)
})

describe('STO-11: multipart complete leaves exactly one real row', () => {
  it('local complete replaces the pending row and counts the bytes once', async () => {
    const { POST } = await import('@/app/api/v1/[projectId]/storage/upload-multipart/route')
    const uploadId = randomUUID()
    const body = Buffer.from('chunked-bytes-for-the-suite')

    // What ?action=initiate (local) records, written directly so the test
    // controls the uploadId; the chunk is staged where complete reads it.
    const pending = await prisma.storageFile.create({
      data: {
        bucketId: uploadsBucketId,
        projectId,
        name: 'movie.txt',
        path: `${uploadId}/movie.txt`,
        size: BigInt(body.length),
        mimeType: 'text/plain',
        isPublic: true,
        metadata: { uploadId, status: 'uploading', contentType: 'text/plain', bucketId: uploadsBucketId },
      },
      select: { id: true },
    })
    const chunkDir = path.join(process.env.CHUNK_TEMP_DIR || path.join(os.tmpdir(), 'backenly-chunks'), uploadId)
    await fs.mkdir(chunkDir, { recursive: true })
    await fs.writeFile(path.join(chunkDir, 'part_00001'), body)

    const usedBefore = (
      await prisma.project.findUnique({ where: { id: projectId }, select: { storageUsed: true } })
    )?.storageUsed ?? BigInt(0)

    const req = new NextRequest(
      `http://test.local/api/v1/${projectId}/storage/upload-multipart?action=complete&uploadId=${uploadId}&totalParts=1`,
      { method: 'POST', headers: { 'x-api-key': serviceKey } },
    )
    const res = await POST(req, { params: Promise.resolve({ projectId }) })
    const out = await res.json()
    expect(res.status).toBe(200)

    // The pending tracking row is gone; the id handed back is a REAL row at
    // a servable path, and it is the only active row for this name.
    const phantom = await prisma.storageFile.findUnique({ where: { id: pending.id } })
    expect(phantom).toBeNull()
    const rows = await prisma.storageFile.findMany({
      where: { projectId, bucketId: uploadsBucketId, name: { contains: 'movie' }, deletedAt: null },
      select: { id: true, path: true },
    })
    expect(rows).toHaveLength(1)
    expect(String(out.data?.id ?? out.id)).toBe(rows[0].id)
    expect(rows[0].path).not.toContain(uploadId)

    const usedAfter = (
      await prisma.project.findUnique({ where: { id: projectId }, select: { storageUsed: true } })
    )?.storageUsed ?? BigInt(0)
    expect(Number(usedAfter - usedBefore)).toBe(body.length)
  }, 120_000)

  it('the signed-upload local fallback creates no phantom row', async () => {
    const { POST } = await import('@/app/api/v1/[projectId]/storage/signed-upload/route')
    const before = await prisma.storageFile.count({ where: { projectId } })
    const req = new NextRequest(`http://test.local/api/v1/${projectId}/storage/signed-upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': serviceKey },
      body: JSON.stringify({ bucket: 'uploads', filename: 'big.bin', contentType: 'application/octet-stream', contentLength: 123 }),
    })
    const res = await POST(req, { params: Promise.resolve({ projectId }) })
    expect(res.status).toBe(200)
    expect(await prisma.storageFile.count({ where: { projectId } })).toBe(before)
  }, 60_000)
})

describe('STO-12: metadata never fetches the bytes', () => {
  it('answers size and a URL for a row whose bytes are not on this disk', async () => {
    const { GET } = await import('@/app/api/v1/[projectId]/storage/files/[fileId]/route')
    const row = await prisma.storageFile.create({
      data: {
        bucketId: uploadsBucketId,
        projectId,
        name: 'remote-object.txt',
        path: 'projects/elsewhere/remote-object.txt', // nothing at this path locally
        size: BigInt(123456789),
        mimeType: 'text/plain',
        isPublic: true,
      },
      select: { id: true },
    })
    const req = new NextRequest(`http://test.local/api/v1/${projectId}/storage/files/${row.id}`, {
      method: 'GET',
      headers: { 'x-api-key': serviceKey },
    })
    const res = await GET(req, { params: Promise.resolve({ projectId, fileId: row.id }) })
    expect(res.status).toBe(200)
    const out = await res.json()
    const data = out.data ?? out
    expect(Number(data.size)).toBe(123456789)
    expect(typeof data.url).toBe('string')
  }, 60_000)
})
