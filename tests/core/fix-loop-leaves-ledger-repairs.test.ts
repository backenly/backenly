/**
 * THE AGENTIC FIX LOOP LEAVES REPAIRS OUTSIDE THE LEDGER TO A PERSON
 * ==================================================================
 *
 * The fix loop that runs after an agent's build reaches the executor two ways
 * on its own: its first phase drains open findings through the repair kernel,
 * and a later one applies candidates from three proposers (the curated mapping
 * of failed checks, the scan harvest and, behind a flag, a model). None of them
 * may run FIX_API, FIX_WORKFLOW, ADOPT_EXTERNAL_SCHEMA or REGISTER_SCHEMA. They
 * run outside the change ledger, so History could not undo them, and a person
 * approves each one first. Other candidates still apply.
 *
 * Stood in for: the behavioral verifier, which signs real end users up against
 * a running runtime; the scan harvest and the fix author, so each proposer can
 * name one of the four, including without saying it needs approval, as an older
 * producer or a model might; the incident freeze, held open; and the executor,
 * which records each call and then makes the real one. The repair kernel, the
 * classifier and the database are real.
 */

const mockExecuted: string[] = []
jest.mock('@/lib/ai/minimal-executor', () => {
  const actual = jest.requireActual('@/lib/ai/minimal-executor')
  return {
    ...actual,
    executeAction: jest.fn(async (action: { action: string }, ...rest: unknown[]) => {
      mockExecuted.push(action.action)
      return (actual.executeAction as (...a: unknown[]) => unknown)(action, ...rest)
    }),
  }
})

jest.mock('@/lib/ai/behavioral-verifier', () => ({
  runBehavioralVerification: jest.fn(async (projectId: string) => ({
    projectId,
    passed: false,
    verdict: 'failed',
    checksRun: 3,
    checksSkipped: 0,
    checks: [
      // Both map to FIX_API in the curated registry.
      { id: 'crud_lifecycle', name: 'CRUD lifecycle', passed: false, skipped: false, error: 'update returned 404', details: [] },
      { id: 'live_api_endpoints', name: 'Live endpoints', passed: false, skipped: false, error: 'GET /db/notes returned 404', details: [] },
      // No curated mapping, so the fix author is asked.
      { id: 'contract_shape', name: 'Response shape', passed: false, skipped: false, error: 'unexpected shape', details: [] },
    ],
  })),
}))

jest.mock('@/lib/ai/scan/scan-to-fixes', () => ({
  harvestScanFixes: jest.fn(async () => ({
    candidates: [
      // None of these says it needs approval: the loop must know regardless.
      { id: 's1', action: 'FIX_API', params: { tableName: 'notes' }, reason: 'API build step failed', sourceCheckId: 'scan:ledger_failed:notes' },
      { id: 's2', action: 'FIX_WORKFLOW', params: { workflow: 'user_auth_flow' }, reason: 'workflow incomplete', sourceCheckId: 'scan:workflow' },
      { id: 's3', action: 'ADOPT_EXTERNAL_SCHEMA', params: {}, reason: 'external DDL', sourceCheckId: 'scan:drift' },
      { id: 's4', action: 'REGISTER_SCHEMA', params: {}, reason: 'PGRST106', sourceCheckId: 'scan:registry' },
      // A repair inside the ledger, which still applies.
      { id: 's5', action: 'CREATE_INDEX', params: { tableName: 'line_items', columnName: 'order_id' }, reason: 'unindexed reference', sourceCheckId: 'scan:missing_index:line_items.order_id' },
    ],
    uncovered: [],
  })),
}))

jest.mock('@/lib/ai/agentic-fix-author', () => ({
  MAX_AUTHORED_FIXES_PER_BUILD: 5,
  // A model's proposal that names FIX_API and does not ask for approval.
  authorFixForCheck: jest.fn(async ({ check }: { check: { id: string } }) => ({
    candidate: { id: 'a1', action: 'FIX_API', params: {}, reason: 'regenerate the endpoints', sourceCheckId: check.id, requiresApproval: false },
    reason: 'authored',
    telemetry: { model: 'stand-in', durationMs: 0 },
  })),
}))

jest.mock('@/lib/autonomy/change-freeze', () => ({
  ...jest.requireActual('@/lib/autonomy/change-freeze'),
  heldForIncident: jest.fn(async () => false),
}))

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { runAgenticFixLoop, type FixLoopEvent } from '@/lib/ai/agentic-fix-loop'
import { REPAIRS_OUTSIDE_THE_CHANGE_LEDGER } from '@/lib/core/fix-actions'

process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'
const savedAuthorFlag = process.env.ENABLE_AGENTIC_FIX_AUTHOR

const prisma = new PrismaClient()
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

let userId: string
let planId: string
let projectId: string
let schema: string
const seeded: Record<string, string> = {}

beforeAll(async () => {
  process.env.ENABLE_AGENTIC_FIX_AUTHOR = 'true'
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`
  await prisma.user.create({
    data: { id: userId, email: `fix-loop-ledger+${userId.slice(0, 8)}@backenly.test`, name: 'fix loop ledger', password: 'not-a-real-hash' },
  })
  const plan = await prisma.plan.create({
    data: {
      name: `FIX_LOOP_LEDGER_${userId.slice(0, 8)}`,
      priceCents: 0,
      autonomyScanIntervalMin: 1,
      autonomyMaxLevel: 'AGGRESSIVE',
      autonomyMaxActionsPerWindow: null,
    } as any,
  })
  planId = plan.id
  await prisma.subscription.create({ data: { userId, planId, status: 'ACTIVE' } as any })
  await prisma.project.create({ data: { id: projectId, name: 'fix-loop-ledger', userId, autonomyLevel: 'AGGRESSIVE' } as any })

  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await q(`CREATE TABLE "${schema}"."line_items" (id uuid PRIMARY KEY, order_id uuid)`)
  await q(`CREATE TABLE "${schema}"."notes" (id uuid PRIMARY KEY, body text)`)
  for (const name of ['line_items', 'notes']) {
    await prisma.table.create({ data: { projectId, name, schema, description: 'fixture' } })
  }

  // Open findings for the first phase to drain, each repaired by one of the four.
  // A pending drift event beside them: adopting is what would mark it.
  await prisma.schemaDriftEvent.create({
    data: { projectId, roleName: 'external_rw', commandTag: 'ALTER TABLE', objectIdentity: `${schema}.notes`, schemaName: schema, status: 'pending' } as any,
  })
  const open: Array<[string, Record<string, unknown>]> = [
    ['shadow_mutation', { tableName: 'notes', shadowColumns: ['secret_flag'] }],
    ['external_schema_change', { location: 'direct-connection', eventCount: 1 }],
    ['workflow_broken', { workflow: 'user_auth_flow', missingComponents: ['rls_on_users'] }],
    ['schema_not_registered', { schema, tableCount: 2 }],
  ]
  for (const [type, details] of open) {
    const f = await prisma.healthFinding.create({
      data: { projectId, type, severity: 'warning', status: 'open', autoFixed: false, details: details as any },
    })
    seeded[type] = f.id
  }
}, 180_000)

afterAll(async () => {
  if (savedAuthorFlag === undefined) delete process.env.ENABLE_AGENTIC_FIX_AUTHOR
  else process.env.ENABLE_AGENTIC_FIX_AUTHOR = savedAuthorFlag
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.schemaDriftEvent.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.subscription.deleteMany({ where: { userId } }).catch(() => {})
  await prisma.plan.deleteMany({ where: { id: planId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 180_000)

describe('one round of the agentic fix loop', () => {
  const events: FixLoopEvent[] = []
  let result: Awaited<ReturnType<typeof runAgenticFixLoop>>

  beforeAll(async () => {
    result = await runAgenticFixLoop(projectId, userId, { maxRounds: 1, emit: (e) => events.push(e) })
  }, 300_000)

  it('never sends one of the four to the executor', () => {
    expect(mockExecuted.filter((a) => REPAIRS_OUTSIDE_THE_CHANGE_LEDGER.has(a))).toEqual([])
  })

  it('reports every one of them as waiting for approval, whoever proposed it', () => {
    const waiting = events
      .filter((e): e is Extract<FixLoopEvent, { type: 'fix_loop_fix_needs_approval' }> => e.type === 'fix_loop_fix_needs_approval')
      .map((e) => e.fix.action)
      .sort()
    // Two from the curated mapping, one from the model, one from the harvest,
    // and the harvest's other three.
    expect(waiting).toEqual([
      'ADOPT_EXTERNAL_SCHEMA',
      'FIX_API',
      'FIX_API',
      'FIX_API',
      'FIX_API',
      'FIX_WORKFLOW',
      'REGISTER_SCHEMA',
    ])
  })

  it('parks the open findings it drained, and runs none of their repairs', async () => {
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'fix_loop_health_findings_done', autoFixed: 0, pending: 4, failed: 0 }),
    )
    const rows = await prisma.healthFinding.findMany({
      where: { id: { in: Object.values(seeded) } },
      select: { type: true, status: true },
    })
    expect(rows.map((r) => [r.type, r.status]).sort()).toEqual([
      ['external_schema_change', 'pending_approval'],
      ['schema_not_registered', 'pending_approval'],
      ['shadow_mutation', 'pending_approval'],
      ['workflow_broken', 'pending_approval'],
    ])
    // Adoption did not run: the drift event it would have marked is still pending.
    expect(await prisma.schemaDriftEvent.count({ where: { projectId, status: 'pending' } })).toBe(1)
  })

  it('still applies a candidate inside the ledger', async () => {
    expect(mockExecuted).toEqual(['CREATE_INDEX'])
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'fix_loop_fix_done', fix: expect.objectContaining({ action: 'CREATE_INDEX' }), success: true }),
    )
    expect(result.appliedFixes).toBe(1)
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`
      SELECT count(*)::int AS n
      FROM pg_index i
      JOIN pg_class c     ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = '${schema}' AND c.relname = 'line_items' AND a.attname = 'order_id'
    `)
    expect(rows[0].n).toBeGreaterThan(0)
  })
})
