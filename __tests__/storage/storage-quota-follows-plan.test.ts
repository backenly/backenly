/**
 * THE PLAN DECIDES A PROJECT'S FILE STORAGE, AND THE SERVER MEASURES IT
 * ====================================================================
 * Three defects, one theme: the number that bounded file storage was not the
 * plan's, and the number it was measured against was not the server's.
 *
 *   1. getProjectQuota preferred Project.storageLimit over the plan. Nothing
 *      ever writes that column, so every project carried its 1 GiB default and
 *      Pro's advertised 100 GB was 1 GiB in practice.
 *   2. The S3 upload path enforced a hardcoded 10 GB per project on top, and
 *      the local driver compared against the raw column.
 *   3. PUT /api/projects/[id] accepted storageUsed from the client, so any
 *      project writer could reset the counter to 0 and upload past the quota.
 *
 * Real database for the project rows and counters. Only the entitlements
 * provider is stubbed, because the plan is the input under test and the public
 * edition has no Plan table.
 */

import { randomUUID } from 'crypto'

process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || 'test-storage-secret-must-be-at-least-32-chars-long-for-security-tests'

import { prisma } from '@/lib/db/prisma'
import { selfHostedEntitlements } from '@/lib/entitlements/self-hosted'
import type { UserEntitlements } from '@/lib/entitlements/types'

let fileStorageMb: number | null = null
jest.mock('@/lib/entitlements', () => ({
  ...jest.requireActual('@/lib/entitlements'),
  getAccountEntitlements: (): Promise<UserEntitlements> =>
    Promise.resolve({ ...selfHostedEntitlements(), planName: 'TEST', maxFileStorageMb: fileStorageMb }),
}))

// Who may write a project is not under test here, and the single-tenant
// resolver rightly refuses to pick one project out of a shared test database.
jest.mock('@/lib/edition/guard', () => ({
  ...jest.requireActual('@/lib/edition/guard'),
  canWriteProject: () => Promise.resolve(true),
}))

let currentUserId = ''
jest.mock('@/lib/auth/server', () => ({
  ...jest.requireActual('@/lib/auth/server'),
  requireUser: () => Promise.resolve({ userId: currentUserId, email: 'quota@test.invalid', role: 'user' }),
}))

const { getProjectQuota, assertQuotaAvailable, QuotaExceededError } = require('@/lib/services/storageQuota')
const { enforceStorageQuota } = require('@/lib/storage/storage-lifecycle')
const { LocalStorageService } = require('@/lib/services/storage')
const { UploadRejectedError } = require('@/lib/storage/upload-policy')
const { PUT: updateProjectRoute } = require('@/app/api/projects/[id]/route')

const GiB = BigInt(1024 * 1024 * 1024)
const MiB = BigInt(1024 * 1024)
const PRO_MB = 102_400
const FREE_MB = 1_024
const UNLIMITED = BigInt('9223372036854775807')

const DB_URL = process.env.TEST_DATABASE_URL ?? ''
const createdUserIds: string[] = []

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

async function makeProject(storageUsed = BigInt(0), maxFilesPerBucket = 1000) {
  const user = await prisma.user.create({
    data: { email: `quota-${randomUUID()}@test.invalid`, name: 'Quota Test' },
    select: { id: true },
  })
  createdUserIds.push(user.id)
  const project = await prisma.project.create({
    data: { name: `quota-${randomUUID().slice(0, 8)}`, userId: user.id, storageUsed, maxFilesPerBucket },
    select: { id: true, storageLimit: true, maxFilesPerBucket: true },
  })
  return { userId: user.id, projectId: project.id, column: project.storageLimit, maxFilesPerBucket: project.maxFilesPerBucket }
}

beforeAll(() => {
  assertSafeTestDatabase()
})

afterAll(async () => {
  if (createdUserIds.length) {
    const projects = await prisma.project.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } })
    const projectIds = projects.map(p => p.id)
    await prisma.storageFile.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
    await prisma.storageBucket.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
    await prisma.project.deleteMany({ where: { userId: { in: createdUserIds } } })
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

describe('the file storage limit is the plan', () => {
  it('gives a Pro project its plan cap, not the 1 GiB column default', async () => {
    fileStorageMb = PRO_MB
    const { projectId, column } = await makeProject()

    // The precondition that made this a bug: the column still says 1 GiB.
    expect(column).toBe(GiB)

    const quota = await getProjectQuota(projectId)
    expect(quota.limit).toBe(BigInt(PRO_MB) * MiB)
    await expect(assertQuotaAvailable(projectId, BigInt(2) * GiB)).resolves.toBeUndefined()
  })

  it('still refuses an upload past a smaller plan', async () => {
    fileStorageMb = FREE_MB
    const { projectId } = await makeProject(BigInt(512) * MiB)

    await expect(assertQuotaAvailable(projectId, BigInt(600) * MiB)).rejects.toBeInstanceOf(QuotaExceededError)
    await expect(assertQuotaAvailable(projectId, BigInt(100) * MiB)).resolves.toBeUndefined()
  })

  it('treats an unlimited plan as unlimited', async () => {
    fileStorageMb = null
    const { projectId } = await makeProject()

    expect((await getProjectQuota(projectId)).limit).toBe(UNLIMITED)
  })
})

describe('the S3 upload path', () => {
  it('uses the plan instead of a hardcoded 10 GB', async () => {
    fileStorageMb = PRO_MB
    const { projectId } = await makeProject(BigInt(11) * GiB)

    const decision = await enforceStorageQuota(projectId, MiB)
    expect(decision.allowed).toBe(true)
  })

  it('still blocks past the plan', async () => {
    fileStorageMb = FREE_MB
    const { projectId } = await makeProject(GiB)

    const decision = await enforceStorageQuota(projectId, MiB)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/quota exceeded/i)
  })

  it('allows more than 10,000 files when storage bytes permit (#592)', async () => {
    fileStorageMb = PRO_MB
    const { projectId } = await makeProject(GiB)

    // Simulate 12,000 existing active files in the project
    const countSpy = jest.spyOn(prisma.storageFile, 'count').mockResolvedValueOnce(12_000)
    try {
      const decision = await enforceStorageQuota(projectId, MiB)
      expect(decision.allowed).toBe(true)
    } finally {
      countSpy.mockRestore()
    }
  })

  it('still blocks when an explicit file count limit is configured and exceeded', async () => {
    fileStorageMb = PRO_MB
    const { projectId } = await makeProject(GiB)

    const countSpy = jest.spyOn(prisma.storageFile, 'count').mockResolvedValueOnce(50)
    try {
      const decision = await enforceStorageQuota(projectId, MiB, {
        maxFileSize: MiB * BigInt(100),
        maxFileCount: 50,
        maxOrphansAllowed: 100,
      })
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toMatch(/Project file count limit reached \(50 files maximum\)/)
    } finally {
      countSpy.mockRestore()
    }
  })
})

describe('the self-host local upload path (#592)', () => {
  it('does not cap bucket files at the legacy default 1000', async () => {
    fileStorageMb = PRO_MB
    const { projectId } = await makeProject()
    const bucket = await prisma.storageBucket.create({
      data: { name: `unlimited-${randomUUID().slice(0, 8)}`, projectId, accessPolicy: 'private' },
    })

    const svc = new LocalStorageService()
    // Simulate 1500 active files in the bucket (well beyond the legacy 1000 default)
    const countSpy = jest.spyOn(prisma.storageFile, 'count').mockResolvedValueOnce(1500)
    try {
      const stored = await svc.uploadFile(
        bucket.id,
        { name: 'file-1501.txt', buffer: Buffer.from('hello'), mimeType: 'text/plain' },
        { projectId },
      )
      expect(stored).toBeDefined()
      expect(stored.name).toBe('file-1501.txt')
    } finally {
      countSpy.mockRestore()
    }
  })

  it('rejects with a 413 UploadRejectedError when an explicit bucket limit is reached', async () => {
    fileStorageMb = PRO_MB
    const { projectId } = await makeProject(BigInt(0), 5) // explicit custom limit: 5 files
    const bucket = await prisma.storageBucket.create({
      data: { name: `limited-${randomUUID().slice(0, 8)}`, projectId, accessPolicy: 'private' },
    })

    const svc = new LocalStorageService()
    const countSpy = jest.spyOn(prisma.storageFile, 'count').mockResolvedValueOnce(5)
    try {
      await expect(
        svc.uploadFile(
          bucket.id,
          { name: 'file-6.txt', buffer: Buffer.from('hello'), mimeType: 'text/plain' },
          { projectId },
        )
      ).rejects.toMatchObject({
        name: 'UploadRejectedError',
        code: 'STORAGE_QUOTA_EXCEEDED',
        status: 413,
      })
    } finally {
      countSpy.mockRestore()
    }
  })

  it('rejects with a 413 UploadRejectedError when options.maxFilesPerBucket is passed and reached', async () => {
    fileStorageMb = PRO_MB
    const { projectId } = await makeProject()
    const bucket = await prisma.storageBucket.create({
      data: { name: `options-limited-${randomUUID().slice(0, 8)}`, projectId, accessPolicy: 'private' },
    })

    const svc = new LocalStorageService()
    const countSpy = jest.spyOn(prisma.storageFile, 'count').mockResolvedValueOnce(3)
    try {
      await expect(
        svc.uploadFile(
          bucket.id,
          { name: 'file-4.txt', buffer: Buffer.from('hello'), mimeType: 'text/plain' },
          { projectId, maxFilesPerBucket: 3 },
        )
      ).rejects.toMatchObject({
        name: 'UploadRejectedError',
        code: 'STORAGE_QUOTA_EXCEEDED',
        status: 413,
      })
    } finally {
      countSpy.mockRestore()
    }
  })
})

describe('PUT /api/projects/[id]', () => {
  it('ignores usage figures sent by the client', async () => {
    fileStorageMb = PRO_MB
    const { userId, projectId } = await makeProject(BigInt(5) * GiB)
    currentUserId = userId

    const request: any = {
      url: `http://localhost/api/projects/${projectId}`,
      // The response names the project's API address, read from the request.
      headers: new Headers(),
      json: async () => ({ name: 'renamed', storageUsed: 0, activeUsers: 99, apiRequests: 0 }),
    }
    const res = await updateProjectRoute(request, {})
    const body = await res.json()

    expect(res.status).toBe(200)
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { name: true, storageUsed: true, activeUsers: true },
    })
    expect(row.name).toBe('renamed')
    expect(row.storageUsed).toBe(BigInt(5) * GiB)
    expect(row.activeUsers).toBe(0)
    // And it reports the plan's cap, not the unused column.
    expect(body.data.storageLimit).toBe(Number(BigInt(PRO_MB) * MiB))
  })
})
