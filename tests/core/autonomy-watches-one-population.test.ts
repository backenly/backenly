/**
 * AUTONOMY WATCHES ONE POPULATION
 * ===============================
 * Every scheduler, the post-mutation kick and the observer ask the same
 * question before spending a cycle on a project: is something built here, and
 * is it serving? Two ways the loop used to answer differently:
 *
 *   - "has a table OR carries an open finding". A false finding on a project
 *     that had only been named made it permanently active.
 *   - "any audit row in the window". The reconciler writes AUTONOMY_TICK on
 *     every pass, so a project it had visited once stayed active forever.
 *
 * Real PostgreSQL, real Prisma filters. Each case was checked to fail with the
 * old predicate.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { activeProjectsWhere } from '@/lib/autonomy/activity-gate'
import { runReconciler } from '@/lib/autonomy/reconciler'

const prisma = new PrismaClient()
const DAY = 24 * 60 * 60 * 1000

async function project(opts: { built: boolean; createdDaysAgo?: number }) {
  const userId = randomUUID()
  const projectId = randomUUID()
  await prisma.user.create({
    data: { id: userId, email: `onepop+${userId.slice(0, 8)}@backenly.test`, name: 'onepop', password: 'x' },
  })
  await prisma.project.create({
    data: {
      id: projectId,
      name: 'one-population',
      userId,
      jwtSecret: 'a'.repeat(64),
      createdAt: new Date(Date.now() - (opts.createdDaysAgo ?? 0) * DAY),
    },
  })
  await prisma.table.create({ data: { name: 'users', projectId } })
  if (opts.built) await prisma.table.create({ data: { name: 'todos', projectId } })
  return { userId, projectId }
}

async function drop(p: { userId: string; projectId: string }) {
  await prisma.project.deleteMany({ where: { id: p.projectId } })
  await prisma.user.deleteMany({ where: { id: p.userId } })
}

async function isActive(projectId: string): Promise<boolean> {
  const rows = await prisma.project.findMany({
    where: { AND: [{ id: projectId }, activeProjectsWhere()] },
    select: { id: true },
  })
  return rows.length === 1
}

afterAll(async () => {
  await prisma.$disconnect()
})

describe('the loop selects built, serving, active projects and nothing else', () => {
  it('does not select an unbuilt project because it carries a finding', async () => {
    const p = await project({ built: false })
    try {
      await prisma.healthFinding.create({
        data: {
          projectId: p.projectId, type: 'contract_surface_broken', severity: 'critical',
          status: 'pending_approval', details: { surface: 'runtime' },
        },
      })
      expect(await isActive(p.projectId)).toBe(false)
    } finally {
      await drop(p)
    }
  })

  it('selects a newly built project before it has any activity to show', async () => {
    const p = await project({ built: true })
    try {
      expect(await isActive(p.projectId)).toBe(true)
    } finally {
      await drop(p)
    }
  })

  it('does not let the loop keep a project active with its own ticks', async () => {
    const p = await project({ built: true, createdDaysAgo: 90 })
    try {
      await prisma.auditLog.create({
        data: { projectId: p.projectId, action: 'AUTONOMY_TICK', type: 'autonomy', details: '{}', timestamp: new Date() },
      })
      expect(await isActive(p.projectId)).toBe(false)

      // A real governed mutation from an agent is activity.
      await prisma.auditLog.create({
        data: { projectId: p.projectId, action: 'MCP_TOOL_CALL', type: 'mcp', details: '{}', timestamp: new Date() },
      })
      expect(await isActive(p.projectId)).toBe(true)
    } finally {
      await drop(p)
    }
  })

  it('keeps a quiet backend that is serving real traffic', async () => {
    const p = await project({ built: true, createdDaysAgo: 90 })
    try {
      await prisma.apiRequestLog.create({
        data: { projectId: p.projectId, userId: p.userId, method: 'GET', path: '/db/todos', statusCode: 200, duration: 12 },
      })
      expect(await isActive(p.projectId)).toBe(true)
    } finally {
      await drop(p)
    }
  })

  it('never reconciles an unbuilt project, however it is reached', async () => {
    const saved = process.env.ENABLE_AUTONOMY_RECONCILER
    process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
    const p = await project({ built: false })
    try {
      expect(await runReconciler(p.projectId)).toBeNull()
      expect(await prisma.auditLog.count({ where: { projectId: p.projectId } })).toBe(0)
    } finally {
      if (saved === undefined) delete process.env.ENABLE_AUTONOMY_RECONCILER
      else process.env.ENABLE_AUTONOMY_RECONCILER = saved
      await drop(p)
    }
  })
})
