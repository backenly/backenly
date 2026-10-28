/**
 * A PROJECT IS CHECKED AND REPAIRED BY THE REGION THAT SERVES IT
 * ==============================================================
 * The scheduled observer pass keeps to the projects of the region its process
 * serves (lib/autonomy/region-skip.ts). runObserverForProject is also reached
 * one project at a time, by a mutation's event, the event bus and the
 * console, and those callers ask nothing about regions. So the rule is kept
 * in runObserverForProject itself:
 *
 *   - a process never scans or repairs a project another region serves, and
 *     says which region checks it;
 *   - a project in its own region that this process cannot reach is skipped
 *     and the skip recorded, as the scheduled passes do;
 *   - a project it serves is observed as before.
 *
 * Real PostgreSQL, real Prisma. Each case fails without the guard.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { runObserverForProject } from '@/lib/services/workspace-observer'
import { AUTONOMY_SKIPPED, resetSkipRecords } from '@/lib/autonomy/region-skip'

const prisma = new PrismaClient()

async function project(region: string | null) {
  const userId = randomUUID()
  const projectId = randomUUID()
  await prisma.user.create({
    data: { id: userId, email: `served+${userId.slice(0, 8)}@backenly.test`, name: 'served', password: 'x' },
  })
  await prisma.project.create({
    data: { id: projectId, name: 'served-region', userId, jwtSecret: 'a'.repeat(64), region },
  })
  // Built, so the observer's "is anything here to watch?" gate would let it in.
  await prisma.table.create({ data: { name: 'users', projectId } })
  await prisma.table.create({ data: { name: 'orders', projectId } })
  return { userId, projectId }
}

async function drop(p: { userId: string; projectId: string }) {
  await prisma.project.deleteMany({ where: { id: p.projectId } })
  await prisma.user.deleteMany({ where: { id: p.userId } })
}

async function untouched(projectId: string) {
  const [row, findings] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { lastObservedAt: true } }),
    prisma.healthFinding.count({ where: { projectId } }),
  ])
  expect(row.lastObservedAt).toBeNull()
  expect(findings).toBe(0)
}

const originalServiceRegion = process.env.BACKENLY_SERVICE_REGION
const originalUsEast1 = process.env.DATABASE_URL_US_EAST_1

beforeEach(() => {
  resetSkipRecords()
  delete process.env.DATABASE_URL_US_EAST_1
})

afterEach(() => {
  if (originalServiceRegion === undefined) delete process.env.BACKENLY_SERVICE_REGION
  else process.env.BACKENLY_SERVICE_REGION = originalServiceRegion
  if (originalUsEast1 === undefined) delete process.env.DATABASE_URL_US_EAST_1
  else process.env.DATABASE_URL_US_EAST_1 = originalUsEast1
})

afterAll(async () => {
  // The observer opens a workspace pool per project; CI runs every core suite
  // in one process, and pools left open are what exhaust its connections.
  const { closeAllWorkspacePools } = await import('@/lib/services/workspace-pool')
  await closeAllWorkspacePools()
  await prisma.$disconnect()
})

describe('the observer checks only the projects of the region it serves', () => {
  it('does not scan or repair a project kept in another region from home', async () => {
    delete process.env.BACKENLY_SERVICE_REGION
    const p = await project('us-east-1')
    try {
      const result = await runObserverForProject(p.projectId)
      expect(result).toMatchObject({ skipped: 'served-elsewhere', region: 'us-east-1', findingsDetected: 0, autoFixed: 0 })
      await untouched(p.projectId)
      // The normal division of work between regions is not a failure to record.
      expect(await prisma.auditLog.count({ where: { projectId: p.projectId, action: AUTONOMY_SKIPPED } })).toBe(0)
    } finally {
      await drop(p)
    }
  }, 60_000)

  it('does not scan or repair a home project from another region', async () => {
    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
    const p = await project(null)
    try {
      const result = await runObserverForProject(p.projectId)
      expect(result).toMatchObject({ skipped: 'served-elsewhere', region: 'ap-south-1' })
      await untouched(p.projectId)
    } finally {
      await drop(p)
    }
  }, 60_000)

  it('skips a project of its own region it cannot reach, and records why', async () => {
    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
    const p = await project('us-east-1')
    try {
      const result = await runObserverForProject(p.projectId)
      expect(result).toMatchObject({ skipped: 'unreachable', findingsDetected: 0, autoFixed: 0 })
      await untouched(p.projectId)
      const skip = await prisma.auditLog.findFirstOrThrow({ where: { projectId: p.projectId, action: AUTONOMY_SKIPPED } })
      expect(JSON.parse(skip.details as string)).toMatchObject({ pass: 'observer', region: 'us-east-1', reason: 'REGION_NOT_CONFIGURED' })
    } finally {
      await drop(p)
    }
  }, 60_000)

  it('observes a project it serves, as before', async () => {
    delete process.env.BACKENLY_SERVICE_REGION
    const p = await project(null)
    try {
      const result = await runObserverForProject(p.projectId)
      expect(result.skipped).toBeUndefined()
      expect(result.region).toBeUndefined()
    } finally {
      await drop(p)
    }
  }, 120_000)
})
