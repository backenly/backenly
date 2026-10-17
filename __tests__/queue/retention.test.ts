/**
 * WHAT THE DAILY CLEANUP KEEPS, AND FOR HOW LONG
 * ===============================================
 * Two platform records can hold an end user's data: an approval request keeps
 * the exact arguments of the call it parked, and a security event an end
 * user's network and the path they asked for. The founders set both to 90 days
 * (2026-10-16): an approval request from its decision, or from its expiry when
 * nobody decided; a security event from when it was recorded. The daily
 * `old_logs` cleanup (lib/queue/worker.ts) enforces it, against a real database,
 * once BACKENLY_RETENTION_PURGE is `enforce`. Until then it only counts what is
 * past 90 days and keeps every row; `off` neither counts nor deletes.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { handleCleanupJob, retentionPurgeMode } from '@/lib/queue/worker'

const DAY_MS = 24 * 60 * 60 * 1000
const DB_URL = process.env.TEST_DATABASE_URL ?? ''

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId = ''
let projectId = ''

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({ data: { email: `retention-${randomUUID()}@example.test`, name: 'retention fixture' }, select: { id: true } })
  ).id
  projectId = (await prisma.project.create({ data: { name: `retention-${randomUUID()}`, userId: ownerId }, select: { id: true } })).id
})

const savedMode = process.env.BACKENLY_RETENTION_PURGE
afterEach(async () => {
  if (savedMode === undefined) delete process.env.BACKENLY_RETENTION_PURGE
  else process.env.BACKENLY_RETENTION_PURGE = savedMode
  await prisma.agentApprovalRequest.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.securityEvent.deleteMany({ where: { projectId } }).catch(() => {})
})

afterAll(async () => {
  await prisma.securityEvent.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

const ago = (days: number) => new Date(Date.now() - days * DAY_MS)

async function approval(fields: { status: string; decidedAt?: Date; expiresAt: Date }) {
  return (
    await prisma.agentApprovalRequest.create({
      data: {
        projectId,
        userId: ownerId,
        message: 'delete the file ann@example.com uploaded',
        tool: 'delete_file',
        toolArgs: { path: 'uploads/ann@example.com.pdf' },
        target: 'a file',
        ...fields,
      },
      select: { id: true },
    })
  ).id
}

async function securityEvent(createdAt: Date) {
  return (
    await prisma.securityEvent.create({
      data: { kind: 'auth_anomaly', projectId, ip: '203.0.113.0/24', summary: 'retention fixture', createdAt },
      select: { id: true },
    })
  ).id
}

it('reads the mode as dry-run unless it says off or enforce', () => {
  expect(retentionPurgeMode(undefined)).toBe('dry-run')
  expect(retentionPurgeMode('')).toBe('dry-run')
  expect(retentionPurgeMode('yes')).toBe('dry-run')
  expect(retentionPurgeMode(' Enforce ')).toBe('enforce')
  expect(retentionPurgeMode('OFF')).toBe('off')
})

async function fixtures() {
  return {
    decidedLongAgo: await approval({ status: 'executed', decidedAt: ago(91), expiresAt: ago(90) }),
    decidedRecently: await approval({ status: 'rejected', decidedAt: ago(89), expiresAt: ago(88) }),
    expiredLongAgo: await approval({ status: 'pending', expiresAt: ago(91) }),
    stillPending: await approval({ status: 'pending', expiresAt: new Date(Date.now() + DAY_MS) }),
    oldEvent: await securityEvent(ago(91)),
    recentEvent: await securityEvent(ago(89)),
  }
}

async function kept() {
  return {
    approvals: (await prisma.agentApprovalRequest.findMany({ where: { projectId }, select: { id: true } })).map((r) => r.id).sort(),
    events: (await prisma.securityEvent.findMany({ where: { projectId }, select: { id: true } })).map((r) => r.id).sort(),
  }
}

it('by default only counts what is past 90 days and deletes nothing', async () => {
  delete process.env.BACKENLY_RETENTION_PURGE
  const f = await fixtures()
  const result = await handleCleanupJob({ cleanupType: 'old_logs' })
  expect(result.retentionMode).toBe('dry-run')
  expect(result.approvalRequests).toBe(0)
  expect(result.securityEvents).toBe(0)
  expect(result.retentionDue.approvalRequests).toBeGreaterThanOrEqual(2)
  expect(result.retentionDue.securityEvents).toBeGreaterThanOrEqual(1)
  const left = await kept()
  expect(left.approvals).toEqual([f.decidedLongAgo, f.decidedRecently, f.expiredLongAgo, f.stillPending].sort())
  expect(left.events).toEqual([f.oldEvent, f.recentEvent].sort())
})

it('neither counts nor deletes when off', async () => {
  process.env.BACKENLY_RETENTION_PURGE = 'off'
  const f = await fixtures()
  const result = await handleCleanupJob({ cleanupType: 'old_logs' })
  expect(result).toMatchObject({ retentionMode: 'off', approvalRequests: 0, securityEvents: 0 })
  expect(result.retentionDue).toBeUndefined()
  const left = await kept()
  expect(left.approvals).toHaveLength(4)
  expect(left.events).toEqual([f.oldEvent, f.recentEvent].sort())
})

it('deletes approval requests 90 days after their decision or expiry, and security events after 90 days, once enforced', async () => {
  process.env.BACKENLY_RETENTION_PURGE = 'enforce'
  const decidedLongAgo = await approval({ status: 'executed', decidedAt: ago(91), expiresAt: ago(90) })
  const decidedRecently = await approval({ status: 'rejected', decidedAt: ago(89), expiresAt: ago(88) })
  const expiredLongAgo = await approval({ status: 'pending', expiresAt: ago(91) })
  const stillPending = await approval({ status: 'pending', expiresAt: new Date(Date.now() + DAY_MS) })
  const oldEvent = await securityEvent(ago(91))
  const recentEvent = await securityEvent(ago(89))

  const result = await handleCleanupJob({ cleanupType: 'old_logs' })
  expect(result.retentionMode).toBe('enforce')
  expect(result.approvalRequests).toBeGreaterThanOrEqual(2)
  expect(result.securityEvents).toBeGreaterThanOrEqual(1)

  const approvalsLeft = (await prisma.agentApprovalRequest.findMany({ where: { projectId }, select: { id: true } })).map((r) => r.id)
  expect(approvalsLeft.sort()).toEqual([decidedRecently, stillPending].sort())
  const eventsLeft = (await prisma.securityEvent.findMany({ where: { projectId }, select: { id: true } })).map((r) => r.id)
  expect(eventsLeft).toEqual([recentEvent])
  expect(eventsLeft).not.toContain(oldEvent)
  expect(approvalsLeft).not.toContain(decidedLongAgo)
  expect(approvalsLeft).not.toContain(expiredLongAgo)
})
