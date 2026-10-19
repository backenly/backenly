/**
 * The first AI repair class, proven end to end on a real Postgres:
 *
 *   lab fault (a column the recorded intent asked for is missing)
 *   -> the canonical detector files it
 *   -> the investigator (scripted model) proposes ADD_COLUMN
 *   -> a proposal bound to the evidence and catalog is recorded, and nothing runs
 *   -> a person approves that exact version
 *   -> governed execution: postcondition + probe re-check + regression check
 *   -> "fixed · verified", with Undo
 *   -> Undo restores the state before it
 *
 * And the guards: a stale or changed proposal gets 409 and no mutation, a
 * second approval never runs twice, an ineligible suggestion is never offered,
 * and resolve_finding cannot run a proposal.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { detectIntentDrift } from '@/lib/autonomy/intent-conformance'
import { diagnoseEscalatedFindings } from '@/lib/autonomy/escalation-diagnosis'
import { approveProposal, proposeRepair } from '@/lib/autonomy/ai-proposals'
import { PROMOTED_AI_REPAIR_CLASSES } from '@/lib/autonomy/ai-promotion'
import { resolveFindingFromChat, revertAutoFix } from '@/lib/core/auto-fix-engine'
import { buildTrustReport } from '@/lib/autonomy/trust-report'
import { closeChangeLockPool } from '@/lib/changes/lock'

let ownerId: string
let projectId: string
let schema: string

const ADD = { tableName: 'orders', columnName: 'placed_at', columnType: 'timestamp' }

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    schema, table, column,
  )
  return rows[0].n > 0
}

/** The lab fault: orders was asked for with placed_at, and it is not there. File it as the loop would. */
async function fileDriftFinding() {
  const raw = (await detectIntentDrift(projectId)).find((f) => f.details.columnName === 'placed_at')
  if (!raw) throw new Error('the detector did not report the missing column')
  return prisma.healthFinding.create({
    data: { projectId, type: raw.type, severity: raw.severity, status: 'open', details: raw.details as any },
  })
}

const answerProposing = (paramsJson = JSON.stringify(ADD)) =>
  scriptedMessage({
    text: JSON.stringify({
      verdict: 'explained',
      rootCause: 'orders.placed_at was requested as a timestamp and was never created.',
      evidenceRefs: ['finding'],
      ruledOut: ['the table itself is missing'],
      recommendation: 'Add orders.placed_at as a timestamp.',
      proposedAction: { action: 'ADD_COLUMN', paramsJson },
      riskNote: 'Existing rows get no value in it.',
      namedTables: ['orders'],
      namedColumns: ['orders.placed_at'],
    }),
  })

const originalEngineMode = process.env.ENGINE_MODE

beforeAll(async () => {
  // The executor as production runs it: real DDL, each change governed
  // (lib/changes/ledger.ts), which is what Undo restores. jest.setup.js points
  // the executor at an in-memory graph, where nothing is recorded.
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (await prisma.user.create({
    data: { email: `proposals-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'approver' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'ai-fix-proposals', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
}, 60_000)

beforeEach(async () => {
  setSpendLedgerForTests(memorySpendLedger())
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schema}"."orders" CASCADE`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."orders" (id serial PRIMARY KEY, total numeric)`)
  await prisma.aiFixProposal.deleteMany({ where: { projectId } })
  await prisma.healthFinding.deleteMany({ where: { projectId } })
  await prisma.schemaIntent.deleteMany({ where: { projectId } })
  for (const [columnName, requestedType] of [['id', 'integer'], ['total', 'numeric'], ['placed_at', 'timestamp']]) {
    await prisma.schemaIntent.create({ data: { projectId, tableName: 'orders', columnName, requestedType, source: 'create_table' } })
  }
}, 60_000)

afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, `workspace_${projectId}_r%`,
  ).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.schemaIntent.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
}, 60_000)

describe('the first AI repair class: add the column the intent recorded', () => {
  it('goes from fault to a verified fix with Undo, only on a person’s approval of that exact version', async () => {
    const finding = await fileDriftFinding()
    const provider = scriptedProvider([answerProposing()])
    setProviderForTests(provider)

    await diagnoseEscalatedFindings(projectId)

    // The model was offered exactly this typed repair, and nothing else.
    const schema = (provider.calls[0].params.output_config as any).format.schema
    expect(schema.properties.proposedAction.anyOf[1].properties.action.enum).toEqual(['ADD_COLUMN'])
    expect(JSON.stringify(provider.calls[0].params.messages[0])).toContain('- ADD_COLUMN: ')

    // Proposed, queued for a person, and nothing has run.
    const proposal = await prisma.aiFixProposal.findFirstOrThrow({ where: { projectId, findingId: finding.id } })
    expect(proposal).toMatchObject({ status: 'pending', action: 'ADD_COLUMN', params: ADD })
    const queued = await prisma.healthFinding.findUniqueOrThrow({ where: { id: finding.id } })
    expect(queued.status).toBe('pending_approval')
    expect((queued.details as any).diagnosis.proposal).toEqual({ id: proposal.id, version: proposal.proposalVersion })
    expect(await columnExists('orders', 'placed_at')).toBe(false)
    expect(PROMOTED_AI_REPAIR_CLASSES.size).toBe(0)

    // The Review Queue offers it, described plainly.
    const report = await buildTrustReport(projectId, 30)
    const row = report.pendingApprovals.find((p) => p.id === finding.id)
    expect(row?.proposal).toMatchObject({ id: proposal.id, version: proposal.proposalVersion })
    expect(row?.proposal?.summary).toMatch(/Add the column "placed_at" \(timestamp\) to "orders"/)

    // A different version than the one on screen does nothing.
    const wrong = await approveProposal({ projectId, proposalId: proposal.id, proposalVersion: 'not-it', userId: ownerId })
    expect(wrong).toMatchObject({ status: 409, body: { code: 'VERSION_MISMATCH' } })
    expect(await columnExists('orders', 'placed_at')).toBe(false)

    // The approval.
    const approved = await approveProposal({ projectId, proposalId: proposal.id, proposalVersion: proposal.proposalVersion, userId: ownerId })
    expect(approved.status).toBe(200)
    expect(approved.body).toMatchObject({
      ok: true,
      fixed: true,
      outcome: 'fixed',
      checks: { postcondition: 'confirmed', recheck: 'resolved', regressionCheck: 'ran', regressions: [] },
    })
    expect(await columnExists('orders', 'placed_at')).toBe(true)
    const fixed = await prisma.healthFinding.findUniqueOrThrow({ where: { id: finding.id } })
    expect(fixed.status).toBe('auto_fixed')
    expect((fixed.details as any).rollbackData).toMatchObject({
      source: 'ai_proposal', verification: 'confirmed', regressionCheck: 'ran', postcondition: 'confirmed', rollbackFormat: 3,
      changeIds: [expect.any(String)],
    })
    expect(await prisma.auditLog.count({ where: { projectId, action: 'HEALTH_FIX_APPROVED' } })).toBe(1)

    // Approving again never runs it twice.
    const again = await approveProposal({ projectId, proposalId: proposal.id, proposalVersion: proposal.proposalVersion, userId: ownerId })
    expect(again).toMatchObject({ status: 409, body: { code: 'ALREADY_DECIDED', fixed: true } })

    // Undo restores the state before it.
    const undone = await revertAutoFix(finding.id, projectId)
    expect(undone.success).toBe(true)
    expect(await columnExists('orders', 'placed_at')).toBe(false)
    expect(await columnExists('orders', 'total')).toBe(true)
  }, 120_000)

  it('refuses a proposal whose table changed after it was proposed, and changes nothing', async () => {
    const finding = await fileDriftFinding()
    const p = await proposeRepair({ projectId, findingId: finding.id, action: 'ADD_COLUMN', paramsJson: JSON.stringify(ADD), model: 'scripted', rationale: 'test' })
    if (!('proposalId' in p)) throw new Error(`not proposed: ${p.reason}`)

    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."orders" ADD COLUMN note text`)

    const r = await approveProposal({ projectId, proposalId: p.proposalId, proposalVersion: p.proposalVersion, userId: ownerId })
    expect(r).toMatchObject({ status: 409, body: { code: 'STALE' } })
    expect(r.body.message).toMatch(/Nothing was changed/)
    expect(await columnExists('orders', 'placed_at')).toBe(false)
    expect((await prisma.aiFixProposal.findUniqueOrThrow({ where: { id: p.proposalId } })).status).toBe('stale')
  }, 120_000)

  it('runs a contested approval once: the second request gets the first one’s outcome', async () => {
    const finding = await fileDriftFinding()
    const p = await proposeRepair({ projectId, findingId: finding.id, action: 'ADD_COLUMN', paramsJson: JSON.stringify(ADD), model: 'scripted', rationale: 'test' })
    if (!('proposalId' in p)) throw new Error(`not proposed: ${p.reason}`)

    const both = await Promise.all([
      approveProposal({ projectId, proposalId: p.proposalId, proposalVersion: p.proposalVersion, userId: ownerId }),
      approveProposal({ projectId, proposalId: p.proposalId, proposalVersion: p.proposalVersion, userId: ownerId }),
    ])
    expect(both.filter((a) => a.status === 200)).toHaveLength(1)
    expect(both.filter((a) => a.status === 409)).toHaveLength(1)
    expect(await prisma.auditLog.count({ where: { projectId, action: 'AI_PROPOSAL_EXECUTED', details: { contains: p.proposalId } } })).toBe(1)
  }, 120_000)

  it('never offers what it cannot bind, verify and undo', async () => {
    const finding = await fileDriftFinding()
    const propose = (action: string, params: Record<string, unknown>) =>
      proposeRepair({ projectId, findingId: finding.id, action, paramsJson: JSON.stringify(params), model: 'scripted', rationale: 'test' })

    expect(await propose('DROP_TABLE', { tableName: 'orders' })).toMatchObject({ ok: false, reason: expect.stringMatching(/not an action/) })
    expect(await propose('ADD_COLUMN', { ...ADD, columnName: 'something_else' })).toMatchObject({ ok: false, reason: expect.stringMatching(/different column/) })
    expect(await propose('ADD_COLUMN', { ...ADD, columnType: 'text' })).toMatchObject({ ok: false, reason: expect.stringMatching(/different type/) })
    expect(await propose('ADD_COLUMN', { ...ADD, extra: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/parameters are invalid/) })
    expect(await prisma.aiFixProposal.count({ where: { projectId } })).toBe(0)
  }, 120_000)

  it('cannot be run through resolve_finding', async () => {
    const finding = await fileDriftFinding()
    const p = await proposeRepair({ projectId, findingId: finding.id, action: 'ADD_COLUMN', paramsJson: JSON.stringify(ADD), model: 'scripted', rationale: 'test' })
    expect('proposalId' in p).toBe(true)

    const r = await resolveFindingFromChat(finding.id, projectId, { confirmed: true })
    expect(r.outcome).not.toBe('fixed')
    expect(await columnExists('orders', 'placed_at')).toBe(false)
  }, 120_000)
})
