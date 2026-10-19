/**
 * A REPAIR'S RECORDS KEEP A REGIONAL PROJECT'S VALUES IN ITS REGION
 * =================================================================
 * A repair is recorded on its finding (rollbackData, or appliedUnverified when
 * its check could not run) and on its audit row, both platform rows in the
 * home region. For a project kept in another region each record keeps the
 * action's name, its arguments' shape, the statements' text and whether the
 * repair succeeded: never the arguments, the values the statements bound, or
 * the executor's message and data. That holds for the loop's repairs, for a
 * repair whose check could not run, for an approved repair and for a
 * person-approved AI proposal.
 *
 * A home project's records are unchanged, except for an approved held action,
 * whose records keep what a regional project's keep, in every region: its
 * arguments' shape, its statements' text and whether it succeeded. Its
 * statements bind its arguments (BLOCK_USER binds the end user's email), and
 * its result can carry a value its approver is shown once (ROTATE_KEY answers
 * with the new key), which the approver still reads in the response.
 *
 * Undo reads none of this, and restores the state before a repair from a
 * regional record as from any other.
 *
 * Database-free, as tests/unit/residency-findings.spec.ts: the platform client
 * is a recorder and each project's region is whatever the test says it is. The
 * SQL recorder is the real one. The executor is a stand-in that runs
 * BLOCK_USER's statements for every repair, one without values and one binding
 * the end user's email, and answers naming that user; ROTATE_KEY answers with
 * a new key, as the real one does.
 */

const mockRegions = new Map<string, string | null>()
const mockFindings = new Map<string, any>()
const mockAudits: any[] = []
const mockEvents: any[] = []
const mockCorrections: any[] = []
const mockExecuted: any[] = []
const mockRepair = {
  email: 'alice@example.com',
  ddl: 'ALTER TABLE "users" ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE',
  bound: 'UPDATE "users" SET is_blocked = TRUE WHERE "email" = $1 RETURNING id',
  // Shaped like nothing real, so the public repository's secret scanners pass it.
  newKey: 'fixture-rotated-key-not-a-real-key-0123456789abcdef',
}
const mockLoop = {
  outcome: async (): Promise<unknown> => ({ accepted: true, recheck: 'resolved', regressions: [], regressionCheck: 'ran', reason: '' }),
}

jest.mock('@/lib/db/prisma', () => {
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([key, want]: [string, any]) => {
      if (key === 'AND') return want.every((clause: any) => matches(row, clause))
      if (key === 'details') return row.details?.[want.path[0]] === want.equals
      return row[key] === want
    })
  // Copies, as a database returns them: a caller's object is never the stored row.
  const findings = () => [...mockFindings.values()].map((row) => structuredClone(row))
  return {
    prisma: {
      project: {
        findUnique: jest.fn(async ({ where }: any) =>
          mockRegions.has(where.id) ? { region: mockRegions.get(where.id), userId: 'u-owner', name: 'Shop' } : null),
      },
      backendEvent: {
        create: jest.fn(async ({ data }: any) => { mockEvents.push(data); return { id: `e-${data.projectId}`, ...data } }),
        update: jest.fn(async ({ data }: any) => data),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      healthFinding: {
        findFirst: jest.fn(async ({ where }: any) => findings().find((row) => matches(row, where)) ?? null),
        findUnique: jest.fn(async ({ where }: any) => findings().find((row) => row.id === where.id) ?? null),
        create: jest.fn(async ({ data }: any) => {
          const row = structuredClone({ detectedAt: new Date(), ...data })
          mockFindings.set(row.id, row)
          return structuredClone(row)
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = mockFindings.get(where.id)
          if (!row) throw new Error('Record to update not found.')
          return structuredClone(Object.assign(row, structuredClone(data)))
        }),
      },
      auditLog: { create: jest.fn(async ({ data }: any) => { mockAudits.push(data); return data }) },
      // The governed change a repair makes, as its fix group lists it.
      backendChange: { findMany: jest.fn(async () => [{ id: 'chg-fix' }]) },
      correctionEvent: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => { mockCorrections.push(data); return data }),
      },
      backendPattern: { upsert: jest.fn(async () => ({})) },
      // The pre-fix snapshot Undo restores.
      workspaceSchemaSnapshot: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, versionNum: 7 })) },
    },
  }
})
jest.mock('@/lib/db', () => jest.requireMock('@/lib/db/prisma'))

// The stand-in executor. Its statements go through the real SQL recorder, as
// the driver middleware reports them.
jest.mock('@/lib/ai/minimal-executor', () => ({
  executeAction: jest.fn(async (action: any) => {
    mockExecuted.push(action)
    // ROTATE_KEY answers with the new key, to be shown once, as the real
    // executor does; it changes the key's row through the typed client, so no
    // statement is captured.
    if (action.action === 'ROTATE_KEY') {
      return {
        success: true,
        message: `API key rotated. New key (copy now, shown once): ${mockRepair.newKey}`,
        data: { rotated: true, keyId: action.params?.keyId, newKey: mockRepair.newKey },
      }
    }
    const { noteStatement } = jest.requireActual('@/lib/execution/sql-recorder')
    const email = action.params?.email ?? mockRepair.email
    noteStatement(mockRepair.ddl)
    noteStatement(mockRepair.bound, [email])
    return { success: true, message: `${action.action} ran for ${email}`, data: { identifier: email } }
  }),
}))
jest.mock('@/lib/ai/build-runtime/build-lock', () => ({
  withBuildLock: jest.fn(async (_projectId: string, _kind: string, fn: () => Promise<unknown>) => ({ result: await fn() })),
}))
jest.mock('@/lib/services/workspace-schema-snapshot', () => ({
  captureSchemaSnapshot: jest.fn(async (_projectId: string, kind: string) => ({ id: `snap-${kind}` })),
}))
// Undo restores the governed changes a fix made, by the ids its record keeps
// (lib/changes/recovery.ts): nothing a regional project's record withholds.
jest.mock('@/lib/changes/recovery', () => ({
  previewRecovery: jest.fn(async () => ({ safety: 'lossless', reason: null })),
  recoverChange: jest.fn(async () => ({ ok: true, status: 'restored' })),
}))
// The loop's checks, which this suite drives rather than runs. A proposal
// starts only on a gap its probe detects now.
jest.mock('@/lib/autonomy/desired-state', () => ({
  captureCheckBaseline: jest.fn(async () => ({})),
  evaluateFixOutcome: jest.fn(() => mockLoop.outcome()),
  recheckGap: jest.fn(async () => 'unresolved'),
}))
jest.mock('@/lib/autonomy/action-postconditions', () => ({ verifyPostcondition: jest.fn(async () => 'confirmed') }))
jest.mock('@/lib/autonomy/circuit-breaker', () => ({
  checkBreaker: jest.fn(async () => ({ allowed: true })),
  auditBreakerTrip: jest.fn(),
}))
jest.mock('@/lib/autonomy/maintenance/primitives/recovery-restore-policies', () => ({
  capturePolicies: jest.fn(),
  recoveryRestorePolicies: jest.fn(),
  samePolicies: jest.fn(),
}))
// The loop's authority: a legacy-compatibility type, which the owner's dial permits.
jest.mock('@/lib/authority/gate', () => ({
  enforceLegacyCompatibility: jest.fn(async () => ({ allowed: true, reason: null })),
}))
jest.mock('@/lib/memory/graph-schema', () => ({ upsertKnownIssue: jest.fn(async () => {}) }))

// The approve route's session and role checks: the project's owner, approving
// on the project the request names.
jest.mock('@/lib/auth/route-protection', () => ({
  withProjectAccess: (handler: any) => (req: any) =>
    handler(req, { user: { userId: 'u-owner', email: 'owner@backenly.test' }, project: {}, projectId: req.projectId }),
}))
jest.mock('@/lib/edition/guard', () => ({ canWriteProject: jest.fn(async () => true) }))

import { randomBytes } from 'crypto'
import {
  NOT_QUOTED,
  recordedFixAction,
  recordedFixResult,
  recordedResultMessage,
  recordedStatements,
} from '@/lib/data-plane/residency'
import { buildFixAction } from '@/lib/core/fix-actions'
import { executeApprovedProposal, revertAutoFix, runAutoFix } from '@/lib/core/auto-fix-engine'
import { queuePendingActionFinding } from '@/lib/operational-memory/ledger'
import { recoverChange } from '@/lib/changes/recovery'
import { POST as approve } from '@/app/api/projects/[id]/health/approve/route'

const { email: ALICE, ddl: DDL, bound: BOUND, newKey: NEW_KEY } = mockRepair
/** Every repair's statements as the SQL recorder captures them. */
const CAPTURED = [{ sql: DDL }, { sql: BOUND, params: [ALICE] }]
/** The same statements as a record keeps them without their bound values. */
const TEXT_ONLY = [{ sql: DDL }, { sql: BOUND }]
const RESULT = (action: string) => ({ message: `${action} ran for ${ALICE}`, data: { identifier: ALICE } })
const ROW_ECHO = `invalid input syntax for type uuid: "${ALICE}"`

/** A broken sign-up workflow as lib/core/workflow-verifier.ts reports it. FIX_WORKFLOW carries these details in its call. */
const WORKFLOW = {
  workflow: 'signup',
  displayName: 'Sign-up',
  missingComponents: ['users_email_unique'],
  presentComponents: ['users_table'],
  reason: 'Workflow "Sign-up" is incomplete: missing users_email_unique',
}
/** The workflow repair's call in full, as a JSON row keeps it. */
const WORKFLOW_CALL = JSON.parse(JSON.stringify(buildFixAction('workflow_broken', WORKFLOW)))
/** The same call as its action and its arguments' shape. */
const WORKFLOW_SHAPE = {
  action: 'FIX_WORKFLOW',
  params: { workflow: '[string]', missingComponents: { count: 1 }, details: '[object]' },
}

// Sealing a held action's arguments refuses a short signing secret, as CI's
// is; a random sealing-grade one for this file only, never a literal.
const savedSecret = process.env.JWT_SECRET
beforeAll(() => { process.env.JWT_SECRET = randomBytes(48).toString('base64') })
afterAll(() => { process.env.JWT_SECRET = savedSecret })

const loop = { actor: { kind: 'autonomous' as const, loop: 'reconciler' as const }, skipCooldown: true }

function brokenWorkflow(projectId: string, region: string | null, status: 'open' | 'pending_approval' = 'open') {
  mockRegions.set(projectId, region)
  const id = `wf-${projectId}`
  mockFindings.set(id, {
    id, projectId, type: 'workflow_broken', severity: 'warning', status, detectedAt: new Date(), details: { ...WORKFLOW },
  })
  return id
}

const auditsOf = (projectId: string) => mockAudits.filter((a) => a.projectId === projectId)
const auditOf = (projectId: string, action: string) => {
  const row = auditsOf(projectId).find((a) => a.action === action)
  return row ? JSON.parse(row.details) : undefined
}
/** Every row the platform client stored for a project: findings, audit rows, timeline events and fix history. */
const storedFor = (projectId: string) =>
  JSON.stringify([
    ...[...mockFindings.values()].filter((row) => row.projectId === projectId),
    ...auditsOf(projectId),
    ...mockEvents.filter((event) => event.projectId === projectId),
    ...mockCorrections.filter((correction) => correction.projectId === projectId),
  ])

async function approveFinding(projectId: string, findingId: string) {
  const res: any = await approve({ projectId, json: async () => ({ findingId }) } as any)
  return { status: res.status as number, body: await res.json() }
}

describe('what a repair\'s record keeps', () => {
  const call = { action: 'BLOCK_USER', params: { userId: 'u_123', email: ALICE, confirmed: true } }
  const shape = { action: 'BLOCK_USER', params: { userId: '[string]', email: '[string]', confirmed: true } }
  const result = { success: true, ...RESULT('BLOCK_USER') }

  it.each([
    ['a home project\'s repair', { quote: true, held: false }, call, CAPTURED, RESULT('BLOCK_USER'), result.message],
    ['a home project\'s held action', { quote: true, held: true }, shape, TEXT_ONLY, { success: true }, 'Ran BLOCK_USER'],
    ['a regional project\'s repair', { quote: false, held: false }, shape, TEXT_ONLY, { success: true }, NOT_QUOTED],
    ['a regional project\'s held action', { quote: false, held: true }, shape, TEXT_ONLY, { success: true }, NOT_QUOTED],
  ])('for %s', (_what, keep, fixAction, statements, fixResult, message) => {
    expect(recordedFixAction(call, keep)).toEqual(fixAction)
    expect(recordedStatements(CAPTURED, keep)).toEqual(statements)
    expect(recordedFixResult(result, keep)).toEqual(fixResult)
    expect(recordedResultMessage(result.message, 'BLOCK_USER', keep)).toBe(message)
  })
})

describe('the loop\'s repair', () => {
  it('keeps the call, its result and the bound values for a home project, on the finding and the audit row', async () => {
    const id = brokenWorkflow('p-home-loop', null)
    expect((await runAutoFix(id, 'p-home-loop', loop)).outcome).toBe('auto_fixed')

    const record = mockFindings.get(id).details.rollbackData
    expect(record.fixAction).toEqual(WORKFLOW_CALL)
    expect(record.fixResult).toEqual(RESULT('FIX_WORKFLOW'))
    expect(record.statements).toEqual(CAPTURED)

    const audit = auditOf('p-home-loop', 'HEALTH_AUTO_FIXED')
    expect(audit.fixAction).toEqual(WORKFLOW_CALL)
    expect(audit.statements).toEqual(CAPTURED)
    expect(audit.message).toBe(RESULT('FIX_WORKFLOW').message)
  })

  it('keeps only names and shapes for a regional project, on the finding and the audit row', async () => {
    const id = brokenWorkflow('p-use1-loop', 'us-east-1')
    expect((await runAutoFix(id, 'p-use1-loop', loop)).outcome).toBe('auto_fixed')

    const row = mockFindings.get(id)
    expect(row.details.rollbackData.fixAction).toEqual(WORKFLOW_SHAPE)
    expect(row.details.rollbackData.fixResult).toEqual({ success: true })
    expect(row.details.rollbackData.statements).toEqual(TEXT_ONLY)
    expect(row.details.rollbackData).toMatchObject({ rollbackFormat: 3, changeIds: ['chg-fix'], schemaTouching: true, snapshotId: 'snap-pre_migration' })
    expect(JSON.stringify(row)).not.toContain(ALICE)

    const audit = auditOf('p-use1-loop', 'HEALTH_AUTO_FIXED')
    expect(audit.fixAction).toEqual(WORKFLOW_SHAPE)
    expect(audit.statements).toEqual(TEXT_ONLY)
    expect(audit.message).toBe(NOT_QUOTED)
    expect(JSON.stringify(auditsOf('p-use1-loop'))).not.toContain(ALICE)
  })

  it('is undone from a regional project\'s record', async () => {
    const id = brokenWorkflow('p-use1-undo', 'us-east-1')
    expect((await runAutoFix(id, 'p-use1-undo', loop)).outcome).toBe('auto_fixed')
    expect(await revertAutoFix(id, 'p-use1-undo')).toMatchObject({ success: true, appliedSteps: 1 })
    expect(recoverChange).toHaveBeenLastCalledWith('p-use1-undo', 'chg-fix', expect.objectContaining({ mode: 'manual' }))
  })
})

describe('a repair whose check could not run', () => {
  const saved = mockLoop.outcome
  beforeEach(() => { mockLoop.outcome = async () => { throw new Error(ROW_ECHO) } })
  afterEach(() => { mockLoop.outcome = saved })

  it('keeps the call and the bound values for a home project', async () => {
    const id = brokenWorkflow('p-home-unv', null)
    expect((await runAutoFix(id, 'p-home-unv', loop)).outcome).toBe('applied_unverified')

    const applied = mockFindings.get(id).details.appliedUnverified
    expect(applied.fixAction).toEqual(WORKFLOW_CALL)
    expect(applied.statements).toEqual(CAPTURED)

    const audit = auditOf('p-home-unv', 'HEALTH_FIX_UNVERIFIED')
    expect(audit.fixAction).toEqual(WORKFLOW_CALL)
    expect(audit.statements).toEqual(CAPTURED)
  })

  it('keeps only names and shapes for a regional project', async () => {
    const id = brokenWorkflow('p-use1-unv', 'us-east-1')
    expect((await runAutoFix(id, 'p-use1-unv', loop)).outcome).toBe('applied_unverified')

    const row = mockFindings.get(id)
    expect(row.details.appliedUnverified.fixAction).toEqual(WORKFLOW_SHAPE)
    expect(row.details.appliedUnverified.statements).toEqual(TEXT_ONLY)
    expect(row.details.appliedUnverified.verifierError).toBe(NOT_QUOTED)
    expect(JSON.stringify(row)).not.toContain(ALICE)

    const audit = auditOf('p-use1-unv', 'HEALTH_FIX_UNVERIFIED')
    expect(audit.fixAction).toEqual(WORKFLOW_SHAPE)
    expect(audit.statements).toEqual(TEXT_ONLY)
    expect(JSON.stringify(auditsOf('p-use1-unv'))).not.toContain(ALICE)
  })
})

describe('an approved repair', () => {
  it('keeps the call, its result and the bound values for a home project', async () => {
    const id = brokenWorkflow('p-home-approved', null, 'pending_approval')
    expect((await approveFinding('p-home-approved', id)).status).toBe(200)

    const record = mockFindings.get(id).details.rollbackData
    expect(record.fixAction).toEqual(WORKFLOW_CALL)
    expect(record.fixResult).toEqual(RESULT('FIX_WORKFLOW'))
    expect(record.statements).toEqual(CAPTURED)
    const audit = auditOf('p-home-approved', 'HEALTH_FIX_EXECUTED')
    expect(audit.statements).toEqual(CAPTURED)
    expect(audit.message).toBe(RESULT('FIX_WORKFLOW').message)
  })

  it('keeps only names and shapes for a regional project, on the finding and the audit row', async () => {
    const id = brokenWorkflow('p-use1-approved', 'us-east-1', 'pending_approval')
    const { status, body } = await approveFinding('p-use1-approved', id)
    expect(status).toBe(200)
    // The approver reads the outcome in full; nothing stored quotes it.
    expect(body.message).toBe(RESULT('FIX_WORKFLOW').message)

    const row = mockFindings.get(id)
    expect(row.details.rollbackData.fixAction).toEqual(WORKFLOW_SHAPE)
    expect(row.details.rollbackData.fixResult).toEqual({ success: true })
    expect(row.details.rollbackData.statements).toEqual(TEXT_ONLY)
    expect(JSON.stringify(row)).not.toContain(ALICE)

    expect(auditOf('p-use1-approved', 'HEALTH_FIX_EXECUTED').statements).toEqual(TEXT_ONLY)
    expect(JSON.stringify(auditsOf('p-use1-approved'))).not.toContain(ALICE)
  })

  it('of a held action keeps its arguments\' shape, its statements\' text and whether it succeeded for a home project', async () => {
    mockRegions.set('p-home-held', null)
    const finding = await queuePendingActionFinding({
      projectId: 'p-home-held',
      action: 'BLOCK_USER',
      params: { userId: 'u_123', email: ALICE },
      target: ALICE,
      riskLevel: 'medium',
      source: 'brain-risk',
      reason: 'Blocking an end user needs the owner',
    })
    expect((await approveFinding('p-home-held', finding.id)).status).toBe(200)
    // Replayed exactly as it was held.
    expect(mockExecuted[mockExecuted.length - 1]).toEqual({
      action: 'BLOCK_USER', params: { userId: 'u_123', email: ALICE, confirmed: true },
    })

    const record = mockFindings.get(finding.id).details.rollbackData
    expect(record.fixAction).toEqual({ action: 'BLOCK_USER', params: { userId: '[string]', email: '[string]', confirmed: true } })
    expect(record.statements).toEqual(TEXT_ONLY)
    expect(record.fixResult).toEqual({ success: true })
    const audit = auditOf('p-home-held', 'HEALTH_FIX_EXECUTED')
    expect(audit.statements).toEqual(TEXT_ONLY)
    expect(audit.message).toBe('Ran BLOCK_USER')
  })

  it('of a held action that answers with a new key shows it to the approver and stores it nowhere, for a home project', async () => {
    mockRegions.set('p-home-rotate', null)
    const finding = await queuePendingActionFinding({
      projectId: 'p-home-rotate',
      action: 'ROTATE_KEY',
      params: { keyId: 'key_0123456789' },
      target: 'Production key',
      riskLevel: 'medium',
      source: 'brain-risk',
      reason: 'Rotating a key needs the owner',
    })
    const { status, body } = await approveFinding('p-home-rotate', finding.id)
    expect(status).toBe(200)
    // Shown once, to the approver, in the response.
    expect(body.message).toContain(NEW_KEY)

    const record = mockFindings.get(finding.id).details.rollbackData
    expect(record.fixAction).toEqual({ action: 'ROTATE_KEY', params: { keyId: 'key_0123456789', confirmed: true } })
    expect(record.fixResult).toEqual({ success: true })
    expect(auditOf('p-home-rotate', 'HEALTH_FIX_EXECUTED').message).toBe('Ran ROTATE_KEY')
    expect(storedFor('p-home-rotate')).not.toContain(NEW_KEY)
  })
})

describe('a person-approved AI proposal', () => {
  const ADD = { tableName: 'orders', columnName: 'placed_at', columnType: 'timestamptz' }
  const runProposal = (projectId: string, region: string | null) => {
    mockRegions.set(projectId, region)
    const findingId = `drift-${projectId}`
    mockFindings.set(findingId, {
      id: findingId, projectId, type: 'intent_drift', severity: 'warning', status: 'pending_approval', detectedAt: new Date(),
      details: { driftKind: 'missing_column', tableName: 'orders', columnName: 'placed_at', requested: 'timestamp' },
    })
    return executeApprovedProposal({
      projectId,
      findingId,
      action: 'ADD_COLUMN',
      params: ADD,
      schemaTouching: true,
      expectedCatalogFingerprint: 'catalog-1',
      currentCatalogFingerprint: async () => 'catalog-1',
    })
  }

  it('keeps the call, its result and the bound values for a home project', async () => {
    const run = await runProposal('p-home-proposal', null)
    expect(run).toMatchObject({ mutated: true, fixed: true, outcome: 'fixed' })
    expect(run.rollbackData).toMatchObject({ source: 'ai_proposal', verification: 'confirmed', snapshotId: 'snap-pre_migration' })
    expect(run.rollbackData.fixAction).toEqual({ action: 'ADD_COLUMN', params: ADD })
    expect(run.rollbackData.fixResult).toEqual(RESULT('ADD_COLUMN'))
    expect(run.rollbackData.statements).toEqual(CAPTURED)
  })

  it('keeps only names and shapes for a regional project', async () => {
    const run = await runProposal('p-use1-proposal', 'us-east-1')
    expect(run).toMatchObject({ mutated: true, fixed: true, outcome: 'fixed' })
    expect(run.rollbackData).toMatchObject({ source: 'ai_proposal', verification: 'confirmed', snapshotId: 'snap-pre_migration' })
    expect(run.rollbackData.fixAction).toEqual({
      action: 'ADD_COLUMN', params: { tableName: 'orders', columnName: 'placed_at', columnType: '[string]' },
    })
    expect(run.rollbackData.fixResult).toEqual({ success: true })
    expect(run.rollbackData.statements).toEqual(TEXT_ONLY)
    expect(JSON.stringify(run.rollbackData)).not.toContain(ALICE)
  })
})
