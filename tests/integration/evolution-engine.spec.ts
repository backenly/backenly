/**
 * THE ARCHITECTURE EVOLUTION ENGINE, END TO END — against a real PostgreSQL
 * =========================================================================
 *
 * The loop a real project goes through, with nothing mocked:
 *
 *   propose     the engine assesses, rehearses on a copy, and asks — once —
 *               through the existing approval queue (an `architecture_evolution`
 *               finding that no generic approve path will accept)
 *   approve     a stale version and a second click are refused; consent binds
 *               to the version shown; with mutations off nothing runs
 *   advance     expand, backfill, verify, cut over, each a remembered state
 *   pause       mid-backfill, the chain stops at its cursor; resume continues it
 *   observe     the change is watched; a divergence planted behind the
 *               triggers' back stops it and puts it back in front of the owner
 *   stable      only after the window, enough passes and measured agreement,
 *               with an outcome that never claims more than was measured
 *   undo        lossless; afterwards memory keeps the same change from being
 *               proposed again on the same evidence
 *   decline     "not now" is remembered the same way
 *
 * Every assertion about state reads it from architecture memory, the store the
 * engine itself reads, so the test sees what the next pass will see.
 */

import { randomBytes } from 'node:crypto'
import { prisma } from '@/lib/db'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { rlsSessionParams, rlsSessionSql } from '@/lib/services/rls-session'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { closeMaintenanceLockPool } from '@/lib/autonomy/maintenance/single-flight'
import { EVOLUTION_FINDING_TYPE } from '@/lib/core/types'
import { applyApproval } from '@/lib/ai/approval-manager'
import { buildTrustReport } from '@/lib/autonomy/trust-report'
import {
  advance,
  approveRequest,
  isActionRefusal,
  isApprovalRefusal,
  listChanges,
  observe,
  pause,
  proposeChanges,
  recordDecline,
  resume,
  undo,
} from '@/lib/evolution-engine/engine'
import { decisionTrail, readMemory, summarizeDecisions, priorsFor } from '@/lib/evolution-engine/memory'
import { DEFAULT_POLICY } from '@/lib/evolution-engine/policy'
import type { EvolutionRequestDetails } from '@/lib/evolution-engine/request'
import { handleEvolutionBackfillJob } from '@/lib/structural-evolution/backfill-job'
import { readTableFacts } from '@/lib/structural-evolution/facts'

jest.setTimeout(300_000)

const originalMutations = process.env.ENABLE_EVOLUTION_MUTATIONS
const HOUR = 3_600_000

interface Fixture {
  ownerId: string
  projectId: string
  schema: string
}

const q = (sql: string, ...p: unknown[]) => prisma.$executeRawUnsafe(sql, ...p)

async function asService<T = any>(sql: string, ...p: unknown[]): Promise<T[]> {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }))
    return tx.$queryRawUnsafe<T[]>(sql, ...p)
  })
}

/**
 * A project whose `orders` carries refunds that arrived together, are set on
 * the same rows, and keep changing — the same shape as the structural
 * evolution suite, which the analysis proposes to extract.
 */
async function buildProject(label: string): Promise<Fixture> {
  const ownerId = (await prisma.user.create({
    data: { email: `evo-engine-${label}-${randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'evo' },
  })).id
  const projectId = (await prisma.project.create({ data: { name: `evolution-engine-${label}`, userId: ownerId } })).id
  const schema = await resolveWorkspaceSchema(projectId)
  const t = (n: string) => `"${schema}"."${n}"`
  await q(`CREATE SCHEMA "${schema}"`)
  await q(jwtClaimFunctionSql(schema))
  await q(`CREATE TABLE ${t('orders')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    total numeric NOT NULL,
    status text NOT NULL DEFAULT 'placed',
    created_at timestamptz NOT NULL DEFAULT now(),
    refund_amount numeric CHECK (refund_amount >= 0),
    refund_reason text,
    refunded_at timestamptz,
    coupon_code text,
    discount_amount numeric
  )`)
  await q(
    `INSERT INTO ${t('orders')} (user_id, total, created_at, refund_amount, refund_reason, refunded_at, coupon_code, discount_amount)
     SELECT gen_random_uuid(), (i % 90) + 10, now() - (i || ' hours')::interval,
            CASE WHEN i % 5 = 0 THEN (i % 40) + 1 END,
            CASE WHEN i % 5 = 0 THEN 'damaged' END,
            CASE WHEN i % 5 = 0 THEN now() - (i || ' hours')::interval + interval '2 days' END,
            CASE WHEN i % 5 = 1 THEN 'SAVE10' END,
            CASE WHEN i % 5 = 2 THEN 5 END
       FROM generate_series(1, 300) i`,
  )
  const svc = `"${schema}"."backenly_jwt_claim"('role') = 'service_role'`
  const sub = `"${schema}"."backenly_jwt_claim"('sub')`
  await q(`ALTER TABLE ${t('orders')} ENABLE ROW LEVEL SECURITY`)
  await q(`ALTER TABLE ${t('orders')} FORCE ROW LEVEL SECURITY`)
  await q(`CREATE POLICY orders_rw ON ${t('orders')} FOR ALL USING (${svc} OR user_id::text = ${sub}) WITH CHECK (${svc} OR user_id::text = ${sub})`)
  await q(`ANALYZE ${t('orders')}`)

  const base = ['id', 'user_id', 'total', 'status', 'created_at']
  const snap = (v: number, days: number, cols: string[] | null) =>
    prisma.workspaceSchemaSnapshot.create({
      data: {
        projectId,
        versionNum: v,
        trigger: 'post_migration',
        rawDdl: '',
        createdAt: new Date(Date.now() - days * 86_400_000),
        tables: cols
          ? [{ name: 'orders', columns: cols.map(name => ({ name, type: 'text', nullable: true, default: null, isPrimary: name === 'id' })) }]
          : [],
      },
    })
  await snap(1, 220, null)
  await snap(2, 200, base)
  await snap(3, 60, [...base, 'refund_amount', 'refund_reason', 'refunded_at'])
  await snap(4, 20, [...base, 'refund_amount', 'refund_reason', 'refunded_at', 'coupon_code', 'discount_amount'])
  await prisma.apiRequestLog.createMany({
    data: Array.from({ length: 1_200 }, () => ({
      projectId,
      userId: ownerId,
      method: 'GET',
      path: '/db/orders',
      statusCode: 200,
      duration: 4,
      timestamp: new Date(Date.now() - 86_400_000),
    })),
  })
  return { ownerId, projectId, schema }
}

async function dropProject(f: Fixture): Promise<void> {
  await q(`DROP SCHEMA IF EXISTS "${f.schema}" CASCADE`).catch(() => {})
  await prisma.maintenanceStepExecution.deleteMany({ where: { execution: { projectId: f.projectId } } }).catch(() => {})
  await prisma.maintenanceExecution.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.maintenanceApproval.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.backgroundJob.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.apiRequestLog.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: f.ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: f.ownerId } }).catch(() => {})
}

async function requestsOf(projectId: string) {
  const rows = await prisma.healthFinding.findMany({
    where: { projectId, type: EVOLUTION_FINDING_TYPE },
    orderBy: { detectedAt: 'asc' },
    select: { id: true, status: true, details: true },
  })
  return rows.map(r => ({ id: r.id, status: r.status, details: r.details as Record<string, unknown>, ev: (r.details as { evolution: EvolutionRequestDetails }).evolution }))
}

async function stateOf(projectId: string, decisionId: string) {
  return summarizeDecisions(await decisionTrail(projectId, decisionId))[0]
}

/** Run every queued backfill batch the way the worker would, and mark it done. */
async function drain(projectId: string): Promise<Array<{ refusal?: string; cursor: string | null }>> {
  const results = []
  for (let i = 0; i < 50; i++) {
    const job = await prisma.backgroundJob.findFirst({
      where: { projectId, type: 'evolution_backfill', status: 'queued' },
      orderBy: { createdAt: 'asc' },
    })
    if (!job) break
    const result = await handleEvolutionBackfillJob(job.payload as any)
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'completed', result: result as object, completedAt: new Date() } })
    results.push(result)
  }
  return results
}

afterAll(async () => {
  if (originalMutations === undefined) delete process.env.ENABLE_EVOLUTION_MUTATIONS
  else process.env.ENABLE_EVOLUTION_MUTATIONS = originalMutations
  await closeMaintenanceLockPool()
})

// ── The whole life of one change ─────────────────────────────────────────────

describe('one architecture change, from proposal to undo', () => {
  let f: Fixture
  let findingId = ''
  let decisionId = ''
  let planVersion = ''
  let cutoverAt = new Date()

  beforeAll(async () => {
    delete process.env.ENABLE_EVOLUTION_MUTATIONS
    f = await buildProject('life')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('proposes once: rehearsed first, then asked through the approval queue', async () => {
    const pass = await proposeChanges(f.projectId)
    expect(pass.requested).toBe(1)
    const [req] = await requestsOf(f.projectId)
    expect(req.status).toBe('pending_approval')
    // The three doors that must stay shut.
    expect(req.details).not.toHaveProperty('fix')
    expect(req.details).not.toHaveProperty('tableName')
    expect(req.details).not.toHaveProperty('location')
    expect(req.ev).toMatchObject({ ask: 'approve', subject: 'orders', level: 'executable_proposal' })
    expect(req.ev.rehearsal).toMatchObject({ passed: true })
    expect(req.ev.rehearsal.planVersion).toBe(req.ev.planVersion)
    expect(req.ev.summary.headline).toMatch(/refund/)
    expect(req.ev.summary.compatibility).toMatch(/keeps working/)
    expect(req.ev.technical.steps.some(s => s.humanOnly)).toBe(true)
    findingId = req.id
    decisionId = req.ev.decisionId
    planVersion = req.ev.planVersion

    const trail = await decisionTrail(f.projectId, decisionId)
    expect(trail.filter(e => e.record.event === 'transition').map(e => e.record.state)).toEqual([
      'proposed',
      'rehearsing',
      'rehearsed',
      'awaiting_approval',
    ])
    expect(trail.some(e => e.record.event === 'measured')).toBe(true) // the R snapshot

    // Asking again changes nothing: one request per decision.
    expect((await proposeChanges(f.projectId)).requested).toBe(0)
    expect(await requestsOf(f.projectId)).toHaveLength(1)
  })

  it('is refused by every generic approve path', async () => {
    const r = await applyApproval(f.projectId, findingId)
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/Autonomy page/)
  })

  it('refuses a version the person was not shown', async () => {
    const r = await approveRequest({ projectId: f.projectId, findingId, planVersion: 'stale', userId: f.ownerId })
    expect(isApprovalRefusal(r) && r.status).toBe(409)
    expect(isApprovalRefusal(r) && r.currentPlanVersion).toBe(planVersion)
    expect((await requestsOf(f.projectId))[0].status).toBe('pending_approval')
  })

  it('with mutations off, records consent and runs nothing', async () => {
    const r = await approveRequest({ projectId: f.projectId, findingId, planVersion, userId: f.ownerId })
    expect(r.ok).toBe(true)
    expect(!isApprovalRefusal(r) && r.message).toMatch(/switched off/)
    expect((await stateOf(f.projectId, decisionId)).state).toBe('approved')
    expect((await requestsOf(f.projectId))[0].status).toBe('approved')
    expect(await readTableFacts(f.schema, 'order_refunds')).toBeNull()
  })

  it('cannot be approved twice', async () => {
    const r = await approveRequest({ projectId: f.projectId, findingId, planVersion, userId: f.ownerId })
    expect(isApprovalRefusal(r) && r.status).toBe(409)
  })

  it('with mutations on, expands and hands the backfill to the queue', async () => {
    process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
    const r = await advance({ projectId: f.projectId, decisionId })
    expect(r.state).toBe('backfilling')
    const trail = await decisionTrail(f.projectId, decisionId)
    expect(trail.filter(e => e.record.event === 'transition').map(e => e.record.state).slice(-3)).toEqual([
      'approved',
      'expanding',
      'backfilling',
    ])
    expect(trail.some(e => e.record.event === 'measured' && (e.record.payload as any)?.snapshot?.phase === 'S0')).toBe(true)
  })

  it('pausing stops the backfill at its cursor; resuming continues from it', async () => {
    const p = await pause({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(p.ok).toBe(true)
    expect((await stateOf(f.projectId, decisionId)).state).toBe('blocked')
    const stopped = await drain(f.projectId)
    expect(stopped[0]?.refusal).toMatch(/^paused:/)

    const r = await resume({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(isActionRefusal(r) ? r.error : r.state).toBe('backfilling')
    expect((await drain(f.projectId)).every(x => !x.refusal)).toBe(true)
  })

  it('verifies, cuts over and starts watching', async () => {
    const r = await advance({ projectId: f.projectId, decisionId })
    expect(r.state).toBe('observing')
    const s = await stateOf(f.projectId, decisionId)
    expect(s.state).toBe('observing')
    cutoverAt = s.cutoverAt!
    const milestones = (await decisionTrail(f.projectId, decisionId)).filter(e => e.milestone).map(e => e.sentence)
    expect(milestones.join('\n')).toMatch(/being watched for 24 hours/)
    // Plain sentences only: no internal state names reach a person.
    expect(milestones.join('\n')).not.toMatch(/backfilling|expanding|cutover|awaiting_approval/)
  })

  it('does not call it done before the window, however clean the passes', async () => {
    const r = await observe({ projectId: f.projectId, decisionId, now: new Date(cutoverAt.getTime() + HOUR) })
    expect(r.verdict).toBe('continue')
    expect(r.reason).toMatch(/watching for 24h/)
  })

  it('becomes stable after the window with enough passes, and never claims more than it measured', async () => {
    await observe({ projectId: f.projectId, decisionId, now: new Date(cutoverAt.getTime() + 12 * HOUR) })
    const r = await observe({ projectId: f.projectId, decisionId, now: new Date(cutoverAt.getTime() + 25 * HOUR) })
    expect(r.verdict).toBe('stable')
    expect(r.benefit).toBeDefined()
    // A day of synthetic traffic proves nothing either way; the honest verdict
    // is that it worked and the benefit is not yet measurable.
    expect(['insufficient_evidence', 'neutral']).toContain(r.benefit!.verdict)
    const s = await stateOf(f.projectId, decisionId)
    expect(s.state).toBe('stable')
    expect(s.headline).toMatch(/Existing apps kept working, the data matches, and it can be undone/)
    expect(s.headline).not.toMatch(/improved/)
    // Said once, and with when it will be judged again.
    expect(s.headline).not.toMatch(/It works correctly/)
    expect(s.headline).toMatch(/Backenly will look again a month after the change\.$/)
    expect((await requestsOf(f.projectId))[0].status).toBe('resolved')

    const [view] = await listChanges(f.projectId)
    expect(view).toMatchObject({ decisionId, status: { label: 'Done' }, actions: { undo: true, pause: false } })
  })

  it('reaches the Autonomy page as plain sentences, and the engine\'s notebook does not', async () => {
    const report = await buildTrustReport(f.projectId, 30)
    const arch = report.recentActivity.filter(a => a.kind === 'architecture')
    expect(arch.map(a => a.summary).join('\n')).toMatch(/Existing apps kept working/)
    expect(arch.map(a => a.summary).join('\n')).toMatch(/You approved/)
    // Traces (rehearsing, snapshots, observation passes) are memory, not news.
    expect(report.recentActivity.some(a => /snapshot|consistency: ok|Rehearsing/.test(a.summary))).toBe(false)
    expect(report.architectureChanges.map(c => c.decisionId)).toContain(decisionId)
  })

  it('undoes losslessly, and does not propose the same change again on the same evidence', async () => {
    const r = await undo({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(r.ok).toBe(true)
    expect(await readTableFacts(f.schema, 'order_refunds')).toBeNull()
    expect((await stateOf(f.projectId, decisionId)).state).toBe('rolled_back')

    const priors = priorsFor(summarizeDecisions(await readMemory(f.projectId)))
    expect(priors['orders:refund']).toMatchObject({ kind: 'reversed', regressed: false })
    expect((await proposeChanges(f.projectId)).requested).toBe(0)
    const assessed = (await readMemory(f.projectId)).filter(e => e.record.event === 'assessed' && e.record.concernKey === 'orders:refund')
    expect(assessed[assessed.length - 1].sentence).toMatch(/you undid it/)
  })
})

// ── Stopping on a regression ─────────────────────────────────────────────────

describe('a change that misbehaves under observation', () => {
  let f: Fixture
  let decisionId = ''
  let cutoverAt = new Date()

  beforeAll(async () => {
    process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
    f = await buildProject('regress')
    await proposeChanges(f.projectId)
    const [req] = await requestsOf(f.projectId)
    decisionId = req.ev.decisionId
    const a = await approveRequest({ projectId: f.projectId, findingId: req.id, planVersion: req.ev.planVersion, userId: f.ownerId })
    if (isApprovalRefusal(a)) throw new Error(a.error)
    await drain(f.projectId)
    await advance({ projectId: f.projectId, decisionId })
    cutoverAt = (await stateOf(f.projectId, decisionId)).cutoverAt!
  }, 180_000)
  afterAll(async () => dropProject(f), 60_000)

  it('stops on the first divergence and asks the owner to resume or undo', async () => {
    expect((await stateOf(f.projectId, decisionId)).state).toBe('observing')
    // A write that bypasses the triggers — the one way the two shapes can part.
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`DELETE FROM "${f.schema}"."order_refunds" WHERE ctid IN (SELECT ctid FROM "${f.schema}"."order_refunds" LIMIT 1)`)
    })
    const r = await observe({ projectId: f.projectId, decisionId, now: new Date(cutoverAt.getTime() + HOUR) })
    expect(r.verdict).toBe('regressed')
    expect((await stateOf(f.projectId, decisionId)).state).toBe('blocked')
    const [req] = await requestsOf(f.projectId)
    expect(req.status).toBe('pending_approval')
    expect(req.ev.ask).toBe('resume_or_undo')
    expect(req.ev.stoppedBecause).toMatch(/consistency|disagrees/)
    // Policy: no automatic undo unless the owner turned it on.
    expect(DEFAULT_POLICY.autoRollbackOnRegression).toBe(false)
    expect(await readTableFacts(f.schema, 'order_refunds')).not.toBeNull()
  })

  it('undoes losslessly when the divergence lost nothing: the host still holds every value', async () => {
    // The planted divergence is a MISSING satellite row: the host still has
    // the data, so undo is lossless and proceeds.
    const r = await undo({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(r.ok).toBe(true)
    expect((await stateOf(f.projectId, decisionId)).state).toBe('rolled_back')
    expect(priorsFor(summarizeDecisions(await readMemory(f.projectId)))['orders:refund']).toMatchObject({ kind: 'reversed' })
    const rows = await asService<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM "${f.schema}"."orders" WHERE refund_amount IS NOT NULL`)
    expect(Number(rows[0].n)).toBe(60)
  })
})

// ── "Not now" ────────────────────────────────────────────────────────────────

describe('declining a request', () => {
  let f: Fixture

  beforeAll(async () => {
    f = await buildProject('decline')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('is remembered, and the same change is not asked for again on the same evidence', async () => {
    await proposeChanges(f.projectId)
    const [req] = await requestsOf(f.projectId)
    // What POST /health { findingId } does for this type.
    await prisma.healthFinding.update({ where: { id: req.id }, data: { status: 'dismissed' } })
    await recordDecline(f.projectId, req.id, f.ownerId)

    const priors = priorsFor(summarizeDecisions(await readMemory(f.projectId)))
    expect(priors['orders:refund']).toMatchObject({ kind: 'declined' })
    expect((await proposeChanges(f.projectId)).requested).toBe(0)
    expect((await requestsOf(f.projectId)).filter(r => r.status === 'pending_approval')).toHaveLength(0)
    const assessed = (await readMemory(f.projectId)).filter(e => e.record.event === 'assessed' && e.record.concernKey === 'orders:refund')
    expect(assessed[assessed.length - 1].sentence).toMatch(/you declined this change/)
  })
})

// ── A waiting request follows the table ──────────────────────────────────────

describe('a request waiting while the table changes', () => {
  let f: Fixture
  let findingId = ''
  let firstVersion = ''

  beforeAll(async () => {
    delete process.env.ENABLE_EVOLUTION_MUTATIONS
    f = await buildProject('drift')
    await proposeChanges(f.projectId)
    const [req] = await requestsOf(f.projectId)
    findingId = req.id
    firstVersion = req.ev.planVersion
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('is re-rehearsed for the table as it is now, in the same row, and the old version can no longer be approved', async () => {
    await q(`ALTER TABLE "${f.schema}"."orders" ADD COLUMN note text`)
    const pass = await proposeChanges(f.projectId)
    expect(pass.refreshed).toBe(1)
    const reqs = await requestsOf(f.projectId)
    expect(reqs).toHaveLength(1)
    expect(reqs[0].id).toBe(findingId)
    expect(reqs[0].ev.planVersion).not.toBe(firstVersion)
    expect(reqs[0].ev.rehearsal.planVersion).toBe(reqs[0].ev.planVersion)

    const r = await approveRequest({ projectId: f.projectId, findingId, planVersion: firstVersion, userId: f.ownerId })
    expect(isApprovalRefusal(r) && r.currentPlanVersion).toBe(reqs[0].ev.planVersion)
  })

  it('is withdrawn — not left in the queue — when the concern it was about is gone', async () => {
    const decisionId = (await requestsOf(f.projectId))[0].ev.decisionId
    await q(`ALTER TABLE "${f.schema}"."orders" DROP COLUMN refund_amount, DROP COLUMN refund_reason, DROP COLUMN refunded_at`)
    await proposeChanges(f.projectId)
    const [req] = await requestsOf(f.projectId)
    expect(req.status).toBe('resolved')
    const s = await stateOf(f.projectId, decisionId)
    expect(s.state).toBe('blocked')
    expect(s.headline).toMatch(/withdrew its request/)
    // Never approved, so it is nobody's change to list.
    expect((await listChanges(f.projectId)).map(c => c.decisionId)).not.toContain(decisionId)
  })
})
