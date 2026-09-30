/**
 * The local driver applies the same per-file rule as the S3 driver: the
 * bucket's own limit, under the shared ceiling (lib/storage/upload-policy.ts).
 *
 * It used to apply Project.maxFileSize as well, a column nothing can set, 10 MB
 * on every project. So on self-host a bucket its owner raised to 50 MB still
 * refused an 11 MB file, and every multipart upload over 10 MB (which assembles
 * through this same path) failed at the last step, while Backenly Cloud's S3
 * driver accepted the same file.
 *
 * Real database and real file system; only the driver is pinned, before the
 * service singleton is built.
 */
import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.STORAGE_DRIVER = 'local'
const dir = mkdtempSync(join(tmpdir(), 'bkn-upload-size-'))
process.env.STORAGE_DIR = dir
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || randomBytes(32).toString('hex')

const prisma = new PrismaClient()
const MB = 1024 * 1024
let storageService: typeof import('@/lib/services/storage').storageService
let userId: string
let projectId: string

const bucket = (name: string, maxMb: number) =>
  prisma.storageBucket.create({
    data: { name, projectId, isPublic: false, maxFileSizeBytes: BigInt(maxMb * MB) },
  })
const upload = (bucketId: string, sizeMb: number) =>
  storageService.uploadFile(
    bucketId,
    { name: `f-${sizeMb}.txt`, buffer: Buffer.alloc(sizeMb * MB, 'a'), mimeType: 'text/plain' },
    { projectId, uploadedBy: userId },
  )

beforeAll(async () => {
  ;({ storageService } = await import('@/lib/services/storage'))
  const user = await prisma.user.create({
    data: { email: `upload-size-${Date.now()}@example.test`, password: 'x', name: 'upload size' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'upload-size', userId } })
  projectId = project.id
  // The column this used to enforce, at its default, to show it no longer decides.
  expect(project.maxFileSize).toBe(BigInt(10 * MB))
}, 60_000)

afterAll(async () => {
  await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

describe('local driver per-file limit', () => {
  it('accepts a file its raised bucket allows, past the 10 MB project column', async () => {
    const b = await bucket('raised', 50)
    const stored = await upload(b.id, 12)
    expect(stored).toBeTruthy()
    const row = await prisma.storageFile.findFirst({ where: { bucketId: b.id, deletedAt: null } })
    expect(Number(row?.size)).toBe(12 * MB)
  }, 60_000)

  it("refuses a file over its bucket's limit with 413", async () => {
    const b = await bucket('small', 5)
    await expect(upload(b.id, 6)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 })
  }, 60_000)
})
