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

// ── Every repair answers to the owner's dial ─────────────────────────────────

import { runObserverForProject } from '@/lib/services/workspace-observer'
import { permitInlineRepair } from '@/lib/authority/gate'

describe("every autonomous repair answers to the owner's dial", () => {
  const saved = {
    reconciler: process.env.ENABLE_AUTONOMY_RECONCILER,
    live: process.env.ENABLE_AUTONOMY_LIVE_EXECUTION,
  }
  beforeEach(() => {
    process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
    process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'
  })
  afterEach(() => {
    for (const [k, v] of [
      ['ENABLE_AUTONOMY_RECONCILER', saved.reconciler],
      ['ENABLE_AUTONOMY_LIVE_EXECUTION', saved.live],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('permits by flag, then dial, then tier', async () => {
    const p = await project({ built: true })
    try {
      await prisma.project.update({ where: { id: p.projectId }, data: { autonomyLevel: 'AGGRESSIVE' } as any })
      expect((await permitInlineRepair(p.projectId, 'missing_rls', 1)).allowed).toBe(true)
      expect((await permitInlineRepair(p.projectId, 'missing_fk', 2)).allowed).toBe(false)

      await prisma.project.update({ where: { id: p.projectId }, data: { autonomyLevel: 'OFF' } as any })
      expect((await permitInlineRepair(p.projectId, 'infra_hot_table', 0)).allowed).toBe(false)

      await prisma.project.update({ where: { id: p.projectId }, data: { autonomyLevel: 'AGGRESSIVE' } as any })
      process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'false'
      const refused = await permitInlineRepair(p.projectId, 'infra_hot_table', 0)
      expect(refused.allowed).toBe(false)
      expect(refused.reason).toMatch(/live execution/)
    } finally {
      await drop(p)
    }
  })

  it('the observer leaves the schema alone when the owner set autonomy to Off', async () => {
    // detectMissingRls carries an inline fix. It used to run whatever the dial
    // said, while the dashboard told the owner nothing was being repaired.
    const p = await project({ built: true })
    const schema = `workspace_${p.projectId}`
    try {
      await prisma.project.update({ where: { id: p.projectId }, data: { autonomyLevel: 'OFF' } as any })
      await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
      await prisma.$executeRawUnsafe(
        `CREATE TABLE "${schema}".todos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text)`,
      )
      // Reachable by the data plane, which is what makes RLS-off an exposure.
      await prisma.$executeRawUnsafe(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE 'GRANT USAGE ON SCHEMA "${schema}" TO anon';
            EXECUTE 'GRANT SELECT ON "${schema}".todos TO anon';
          END IF;
        END $$`)

      await runObserverForProject(p.projectId)

      const row = await prisma.healthFinding.findFirst({
        where: { projectId: p.projectId, type: 'missing_rls' },
        select: { status: true, details: true },
      })
      expect(row).not.toBeNull()
      expect(row!.status).toBe('open')
      expect(String((row!.details as any).notAppliedBecause)).toMatch(/Off/)

      const rls = await prisma.$queryRawUnsafe<Array<{ on: boolean }>>(
        `SELECT relrowsecurity AS on FROM pg_class WHERE oid = '"${schema}".todos'::regclass`,
      )
      expect(rls[0].on).toBe(false)
    } finally {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await drop(p)
    }
  }, 120_000)
})
