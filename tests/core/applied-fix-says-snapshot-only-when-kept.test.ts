/**
 * An applied fix claims a snapshot only when one was kept.
 *
 * Production QA (2026-11-09): the activity feed said "Applied your approved
 * fix: slow query missing index — re-checked and confirmed, snapshot captured"
 * while the approve API had returned snapshotId: null. The approve route
 * records the snapshot's id on the HEALTH_FIX_EXECUTED row; a fix that takes
 * none (adding an index) records null, and the sentence said "snapshot" anyway.
 */
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { buildTrustReport } from '@/lib/autonomy/trust-report'

const prisma = new PrismaClient()
let userId: string
let projectId: string

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  await prisma.user.create({
    data: { id: userId, email: `snapshot+${userId.slice(0, 8)}@backenly.test`, name: 'snapshot', password: 'not-a-real-hash' },
  })
  await prisma.project.create({ data: { id: projectId, name: 'snapshot-honesty', userId } as any })
  const executed = (details: Record<string, unknown>) =>
    prisma.auditLog.create({
      data: { projectId, action: 'HEALTH_FIX_EXECUTED', type: 'autonomy', details: JSON.stringify(details), timestamp: new Date() },
    })
  await executed({ findingType: 'slow_query_missing_index', title: 'index on orders', verification: 'confirmed', snapshotId: null })
  await executed({ findingType: 'missing_fk_index', title: 'index on items', verification: 'confirmed', snapshotId: 'snap_1' })
  await executed({ findingType: 'missing_rls', title: 'policy on notes', verification: 'unverifiable', snapshotId: null })
  await executed({ findingType: 'missing_rls', title: 'policy on posts', verification: 'unverifiable', snapshotId: 'snap_2' })
}, 60_000)

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 60_000)

async function line(title: string): Promise<string> {
  const report = await buildTrustReport(projectId, 30)
  const found = report.recentActivity.map((a) => a.summary).find((s) => s.includes(title))
  expect(found).toBeDefined()
  return found as string
}

it('a confirmed fix that kept no snapshot does not claim one', async () => {
  expect(await line('index on orders')).toBe('Applied your approved fix: index on orders — re-checked and confirmed')
}, 60_000)

it('a confirmed fix that kept one says so', async () => {
  expect(await line('index on items')).toBe('Applied your approved fix: index on items — re-checked and confirmed, snapshot captured')
}, 60_000)

it('an unconfirmed fix claims a snapshot only when it kept one', async () => {
  expect(await line('policy on notes')).toBe('Applied your approved fix: policy on notes — applied (not independently re-checked)')
  expect(await line('policy on posts')).toBe('Applied your approved fix: policy on posts — applied and snapshotted (not independently re-checked)')
}, 60_000)
