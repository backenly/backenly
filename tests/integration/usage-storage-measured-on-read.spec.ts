/**
 * Reading an account's usage measures database storage that is more than five
 * minutes old, and says when it was measured.
 *
 * Production QA (2026-11-09, report 108): the Usage page read "Database
 * storage 2 MB of 512 MB" more than 30 minutes after loading about 300 MB. The
 * size is measured, not counted, and only the hourly sweep measured it, so
 * rows an app wrote showed up to an hour late.
 *
 * Real database: the project's schema and its rows are measured with the same
 * catalog query production uses. Stubbed: the plan (OSS has no quotas, so
 * nothing would be read at all) and the overage policy (commercial).
 */
jest.mock('@/lib/entitlements', () => {
  const actual = jest.requireActual('@/lib/entitlements')
  const plan = {
    planName: 'BUILDER',
    maxMonthlyActiveUsers: 100_000,
    maxPostgresStorageMb: 8 * 1024,
    maxFileStorageMb: 100 * 1024,
    maxAiFunctionInvocationsPerMonth: 100_000,
    includedEgressMb: 250 * 1024,
  }
  return { ...actual, getAccountEntitlements: jest.fn(async () => plan), getOveragePolicy: jest.fn(async () => null) }
})

import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { describeAccountUsage } from '@/lib/usage/describe'

const MB = 1024 * 1024
let ownerId: string
let projectId: string
const month = new Date().toISOString().slice(0, 7)

const storage = async () => (await describeAccountUsage(ownerId))!.axes.find((a) => a.axis === 'db_bytes')!
const reading = (mb: number, minutesAgo: number) =>
  prisma.$executeRawUnsafe(
    `UPDATE "project_usage" SET "dbStorageUsedMb" = $1, "updatedAt" = (now() AT TIME ZONE 'UTC') - make_interval(mins => $2::int) WHERE "projectId" = $3 AND "month" = $4`,
    mb, minutesAgo, projectId, month,
  )

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: { email: `usage-read-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'Usage' },
      select: { id: true },
    })
  ).id
  projectId = (await prisma.project.create({ data: { name: 'usage-read', userId: ownerId }, select: { id: true } })).id
  const schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."product_views" (id serial PRIMARY KEY, body text NOT NULL)`)
  // About 4 MB, the way an app's bulk insert would land it: nothing measures it.
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."product_views" (body) SELECT md5(i::text) || repeat('x', 1000) FROM generate_series(1, 3000) i`)
  await prisma.projectUsage.create({ data: { projectId, month, dbStorageUsedMb: 2 } })
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

it('measures a reading more than five minutes old before saying how much is used, and says when', async () => {
  await reading(2, 30)

  const db = await storage()

  expect(db.used).toBeGreaterThan(3 * MB)
  expect(Date.now() - new Date(db.measuredAt!).getTime()).toBeLessThan(60_000)
})

it('keeps a reading taken in the last five minutes, and says how old it is', async () => {
  await reading(777, 2)

  const db = await storage()

  expect(db.used).toBe(777 * MB)
  const age = Date.now() - new Date(db.measuredAt!).getTime()
  expect(age).toBeGreaterThan(90_000)
  expect(age).toBeLessThan(5 * 60_000)
})

it('says nothing of when for the counters, which are live', async () => {
  const usage = (await describeAccountUsage(ownerId))!
  for (const a of usage.axes.filter((x) => x.axis !== 'db_bytes')) expect(a.measuredAt).toBeNull()
})
