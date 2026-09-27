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
import { prisma } from '@/lib/db/prisma'
import { selfHostedEntitlements } from '@/lib/entitlements/self-hosted'
import type { UserEntitlements } from '@/lib/entitlements/types'

let fileStorageMb: number | null = null
jest.mock('@/lib/entitlements', () => ({
  ...jest.requireActual('@/lib/entitlements'),
  getUserEntitlements: (): Promise<UserEntitlements> =>
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

async function makeProject(storageUsed = BigInt(0)) {
  const user = await prisma.user.create({
    data: { email: `quota-${randomUUID()}@test.invalid`, name: 'Quota Test' },
    select: { id: true },
  })
  createdUserIds.push(user.id)
  const project = await prisma.project.create({
    data: { name: `quota-${randomUUID().slice(0, 8)}`, userId: user.id, storageUsed },
    select: { id: true, storageLimit: true },
  })
  return { userId: user.id, projectId: project.id, column: project.storageLimit }
}

beforeAll(() => {
  assertSafeTestDatabase()
})

afterAll(async () => {
  if (createdUserIds.length) {
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
})

describe('PUT /api/projects/[id]', () => {
  it('ignores usage figures sent by the client', async () => {
    fileStorageMb = PRO_MB
    const { userId, projectId } = await makeProject(BigInt(5) * GiB)
    currentUserId = userId

    const request: any = {
      url: `http://localhost/api/projects/${projectId}`,
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
