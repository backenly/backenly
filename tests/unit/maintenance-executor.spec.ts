/**
 * PHASE 6b — the executor is a set of refusals with a mutation attached
 * =====================================================================
 *
 * Phase 5 proved a plan can be right and still not runnable. This proves the
 * executor acts on that: what it refuses, when it stops, and what it will not
 * do even when told to.
 *
 * The properties, in the order they can bite:
 *
 *   a ladder is all-or-nothing        the runnable prefix must not run
 *   a stale plan never executes       its preconditions describe a dead schema
 *   Tier 2 needs consent              and consent for THIS plan version
 *   Tier 3 is never executed here     approval or not, level or not
 *   mutations are off by default      reaching production ≠ executing there
 *   classification is re-asked        immediately before every mutation
 *   a completed step is not repeated  crash mid-ladder, resume, do not re-apply
 *   a failed step halts               no continuation, no substitution
 *
 * Prisma, the queue and the primitives are mocked: every assertion here is about
 * the decision, not the write. The writes are exercised against a real engine in
 * tests/integration/maintenance-phase6b.spec.ts.
 */
/**
 * This file tests the EXECUTOR's gates - tier, consent, staleness, the
 * deployment flag - and those gates need a ladder that can actually run.
 *
 * `drop_constraint` is unsupported in this deployment, which blocks every
 * ladder the planner currently emits at plan time. That is correct in
 * production and it would leave every test below with nothing to execute, so
 * recovery is treated as available here. The real registry's behaviour is
 * owned by tests/core/rollback-capability-is-real.test.ts, which asserts the
 * opposite and would fail if this mock leaked into it.
 */
jest.mock('@/lib/autonomy/maintenance/rollback-capability', () => ({
  ...jest.requireActual('@/lib/autonomy/maintenance/rollback-capability'),
  rollbackRefusal: () => null,
  canRollback: () => true,
}))


import type { StructuralDiagnosis } from '@/lib/autonomy/hypothesis/structural'

// ── Mocks ────────────────────────────────────────────────────────────────────

const executionRows = new Map<string, any>()
const stepRows = new Map<string, any>()
let executionSeq = 0

const mockCreateExecution = jest.fn(async ({ data }: any) => {
  const id = `exec-${++executionSeq}`
  const row = { id, ...data }
  executionRows.set(id, row)
  return row
})
const mockUpdateExecution = jest.fn(async ({ where, data }: any) => {
  const row = { ...executionRows.get(where.id), ...data }
  executionRows.set(where.id, row)
  return row
})
const mockFindFirstExecution = jest.fn(async () => null)
const mockJobFindUnique = jest.fn(async () => null as any)
const mockFindUniqueStep = jest.fn(async ({ where }: any) => stepRows.get(where.idempotencyKey) ?? null)
const mockUpsertStep = jest.fn(async ({ where, create, update }: any) => {
  const existing = stepRows.get(where.idempotencyKey)
  const row = existing
    ? { ...existing, ...update }
    : { id: `step-${where.idempotencyKey}`, ...create }
  stepRows.set(where.idempotencyKey, row)
  return row
})
const mockUpdateStep = jest.fn(async ({ where, data }: any) => {
  for (const [key, row] of stepRows) {
    if (row.id === where.id) {
      stepRows.set(key, { ...row, ...data })
      return stepRows.get(key)
    }
  }
  return null
})

jest.mock('@/lib/db', () => ({
  prisma: {
    maintenanceExecution: {
      create: (...a: any[]) => mockCreateExecution(...(a as [any])),
      update: (...a: any[]) => mockUpdateExecution(...(a as [any])),
      findFirst: (...a: any[]) => mockFindFirstExecution(...(a as [])),
    },
    backgroundJob: { findUnique: (...a: any[]) => mockJobFindUnique(...(a as [any])) },
    maintenanceStepExecution: {
      findUnique: (...a: any[]) => mockFindUniqueStep(...(a as [any])),
      upsert: (...a: any[]) => mockUpsertStep(...(a as [any])),
      update: (...a: any[]) => mockUpdateStep(...(a as [any])),
    },
  },
}))

const mockEnqueue = jest.fn(async () => ({ id: 'job-1' }))
jest.mock('@/lib/queue', () => ({ enqueue: (...a: any[]) => mockEnqueue(...(a as [])) }))

const mockAddStructure = jest.fn()
jest.mock('@/lib/autonomy/maintenance/primitives/add-structure', () => ({
  executeMaintenanceAddStructure: (...a: any[]) => mockAddStructure(...(a as [])),
}))

const mockExecuteAction = jest.fn(async () => ({ success: true, message: 'column added' }))
jest.mock('@/lib/ai/minimal-executor', () => ({
  executeAction: (...a: any[]) => mockExecuteAction(...(a as [])),
}))

const mockCarryConstraints = jest.fn()
jest.mock('@/lib/autonomy/maintenance/primitives/carry-constraints', () => ({
  carryConstraints: (...a: any[]) => mockCarryConstraints(...(a as [])),
}))

const mockRunVerify = jest.fn()
jest.mock('@/lib/autonomy/maintenance/primitives/verify', () => ({
  runVerify: (...a: any[]) => mockRunVerify(...(a as [])),
}))

const mockInstallDualWrite = jest.fn()
jest.mock('@/lib/autonomy/maintenance/primitives/dual-write', () => ({
  installDualWrite: (...a: any[]) => mockInstallDualWrite(...(a as [])),
}))

const mockSwitchReaders = jest.fn()
jest.mock('@/lib/autonomy/maintenance/primitives/switch-readers', () => ({
  switchReaders: (...a: any[]) => mockSwitchReaders(...(a as [])),
}))

import { executeMaintenancePlan, type StepBinding } from '@/lib/autonomy/maintenance/execute'
import { buildMaintenancePlan, type MaintenancePlan } from '@/lib/autonomy/maintenance/plan'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const COVERAGE = {
  policiesReadable: true,
  constraintCatalogReadable: true,
  statementTelemetryAvailable: true,
  largestSampleRows: 120,
  sampleSufficient: true,
  notes: [],
}

function diagnosis(hypothesisId: string): StructuralDiagnosis {
  return {
    kind: 'structural_cause_identified',
    hypothesis: {
      id: hypothesisId,
      statement: 'a structural cause',
      prior: 0.25,
      predicts: {},
      remedy: { summary: 'fix', autoApplicable: false },
    },
    confidence: 0.92,
    coverage: COVERAGE,
    blockedBy: [],
    raisedOnly: [],
    reason: 'confirmed',
    trail: ['…'],
    report: {
      symptomId: 'subsystem_repeat_failure',
      verdict: { kind: 'no_symptom' },
      observations: [{ testId: 'column_covariation', outcome: 'co_varying' }],
      unavailable: [],
      trail: [],
    },
  } as unknown as StructuralDiagnosis
}

const build = (hypothesisId: string, fingerprint = 'cat-v1'): MaintenancePlan =>
  buildMaintenancePlan({
    findingId: 'f1',
    diagnosis: diagnosis(hypothesisId),
    subsystem: { fingerprint: 'sessions', membership: ['sessions', 'users'] },
    catalogFingerprint: fingerprint,
  })

/** [add_structure, verify] — every rung implemented, tiers 1 and 0. */
const runnable = () => build('missing_constraint_permits_invalid_state')
/** The full six-rung expand/contract ladder. Tier 2 rungs, so approval-bound. */
const fullLadder = () => build('duplicated_lifecycle_state')

/**
 * The same ladder with one primitive withdrawn, so it is genuinely blocked.
 *
 * Phases 6b and 7 implemented every step kind, so no real ladder is blocked any
 * more. The state still has to be tested: the next step kind to be invented
 * arrives unimplemented, and a ladder containing it must not run.
 */
const runBlocked = async (over: Record<string, unknown> = {}) => {
  let outcome: any
  await jest.isolateModulesAsync(async () => {
    jest.doMock('@/lib/autonomy/maintenance/step', () => {
      const real = jest.requireActual('@/lib/autonomy/maintenance/step')
      const table = { ...real.EXECUTOR_CAPABILITY, dual_write: 'not_implemented' }
      return {
        ...real,
        EXECUTOR_CAPABILITY: table,
        classifyMaintenanceStep: (s: any) => {
          const c = real.classifyMaintenanceStep(s)
          return { ...c, capability: table[s.kind], executable: table[s.kind] === 'implemented' }
        },
      }
    })
    const { buildMaintenancePlan: build2 } = require('@/lib/autonomy/maintenance/plan')
    const { executeMaintenancePlan: exec } = require('@/lib/autonomy/maintenance/execute')
    const plan = build2({
      findingId: 'f1',
      diagnosis: diagnosis('duplicated_lifecycle_state'),
      subsystem: { fingerprint: 'sessions', membership: ['sessions', 'users'] },
      catalogFingerprint: 'cat-v1',
    })
    outcome = {
      plan,
      result: await exec({
        plan,
        projectId: 'p1',
        currentCatalogFingerprint: 'cat-v1',
        autonomyLevel: 'AGGRESSIVE',
        bindings: bindingsFor(plan),
        mutationsEnabled: true,
        approvedPlanVersion: plan.planVersion,
        approvalId: 'a1',
        ...over,
      }),
    }
  })
  jest.dontMock('@/lib/autonomy/maintenance/step')
  return outcome
}

function bindingsFor(plan: MaintenancePlan): Record<number, StepBinding> {
  const out: Record<number, StepBinding> = {}
  for (const s of plan.steps) {
    const cols = { table: 'sessions', sourceColumn: 'status', targetColumn: 'state', transform: { kind: 'identity' as const } }
    if (s.kind === 'add_structure') {
      out[s.ordinal] = { kind: 'add_structure', verb: 'ADD_COLUMN', table: 'sessions', column: 'state', columnType: 'text' }
    } else if (s.kind === 'carry_constraints') {
      out[s.ordinal] = { kind: 'carry_constraints', ...cols, allowedValues: ['active'] }
    } else if (s.kind === 'verify') out[s.ordinal] = { kind: 'verify', ...cols }
    else if (s.kind === 'dual_write') out[s.ordinal] = { kind: 'dual_write', ...cols }
    else if (s.kind === 'backfill') out[s.ordinal] = { kind: 'backfill', ...cols }
    else if (s.kind === 'switch_readers') {
      out[s.ordinal] = { kind: 'switch_readers', table: 'sessions', sourceColumn: 'status', targetColumn: 'state' }
    }
    // `contract` deliberately gets none: it is human-only, and the executor must
    // not require a binding for a step it will never run.
  }
  return out
}

const run = (over: Partial<Parameters<typeof executeMaintenancePlan>[0]> = {}) => {
  const plan = over.plan ?? runnable()
  return executeMaintenancePlan({
    plan,
    projectId: 'p1',
    currentCatalogFingerprint: 'cat-v1',
    autonomyLevel: 'AGGRESSIVE',
    bindings: bindingsFor(plan),
    mutationsEnabled: true,
    ...over,
  })
}

beforeEach(() => {
  // The deployment gate is off by default, which is asserted in its own block
  // below. Every other test here is about a different decision, so it runs in
  // an environment that has enabled mutations.
  process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS = 'true'
  jest.clearAllMocks()
  executionRows.clear()
  stepRows.clear()
  executionSeq = 0
  mockRunVerify.mockResolvedValue({
    outcome: 'passed',
    mayProceed: true,
    summary: '10 row(s) compared, none disagreed (every row)',
    reconciliation: {},
  })
  mockInstallDualWrite.mockResolvedValue({ installed: true, objectName: 'bkn_dw_sessions_state', refusal: null })
  mockCarryConstraints.mockResolvedValue({
    applied: true,
    constraintName: 'bkn_cc_sessions_state',
    sourceDomain: ['active'],
    derivedDomain: ['active'],
  })
  mockSwitchReaders.mockResolvedValue({
    switched: [{ kind: 'ai_function', id: 'fn1', name: 'notify', replacements: 2, previousCode: 'old' }],
    skipped: [],
    inventory: { controllable: [{ id: 'fn1' }], unobservable: [{}, {}, {}], coverage: 'partial' },
    refusal: null,
  })
  mockExecuteAction.mockResolvedValue({ success: true, message: 'column added' })
  mockAddStructure.mockResolvedValue({
    added: true,
    refusal: null,
    observed: { column: 'state', dataType: 'text', isNullable: true },
    identity: { oidBefore: '1', oidAfter: '1', rowsBefore: 80, rowsAfter: 80 },
  })
  mockJobFindUnique.mockResolvedValue(null)
})

// ── The ladder is all-or-nothing ─────────────────────────────────────────────

describe('a blocked ladder does not run, including its runnable prefix', () => {
  it('refuses, and mutates nothing', async () => {
    const { plan, result } = await runBlocked()
    expect(plan.validity).toBe('blocked_by_capability')

    expect(result.status).toBe('refused')
    expect(result.haltReason).toMatch(/all-or-nothing/)
    expect(result.steps).toEqual([])
    // The first rung IS implemented and would have succeeded. Running it would
    // leave a new column nothing fills and a dual-write never installed.
    expect(mockAddStructure).not.toHaveBeenCalled()
  })

  it('still records the refusal, so a refusal is not a silent no-op', async () => {
    await runBlocked({ approvedPlanVersion: 'whatever' })
    expect(mockCreateExecution).toHaveBeenCalledTimes(1)
    expect(mockCreateExecution.mock.calls[0][0].data.status).toBe('refused')
    expect(mockCreateExecution.mock.calls[0][0].data.haltReason).toMatch(/blocked by capability/)
  })

  it('does NOT treat the human-only contract rung as a block', async () => {
    // The six-rung ladder ends in a step a person performs. That must not make
    // everything before it unrunnable, or Phase 6b could never run end to end.
    const plan = fullLadder()
    expect(plan.validity).toBe('executable')
    expect(plan.humanOnlySteps.join(' ')).toMatch(/contract/)
  })
})

// ── Staleness ────────────────────────────────────────────────────────────────

describe('a stale plan never executes', () => {
  it('refuses when the catalog moved', async () => {
    const r = await run({ currentCatalogFingerprint: 'cat-v2' })
    expect(r.status).toBe('refused')
    expect(r.haltReason).toMatch(/catalog moved/)
    expect(mockAddStructure).not.toHaveBeenCalled()
  })
})

// ── Tier gates ───────────────────────────────────────────────────────────────

describe('tier gates', () => {
  it('runs tier 0 and tier 1 on the dial alone', async () => {
    const r = await run()
    expect(r.status).toBe('completed')
    expect(r.steps.map(s => s.status)).toEqual(['completed', 'completed'])
  })

  it('refuses every tier-1 step when the dial is OFF', async () => {
    const r = await run({ autonomyLevel: 'OFF' })
    expect(r.status).toBe('refused')
    expect(r.haltReason).toMatch(/does not permit tier 1/)
  })

  it('refuses tier 2 with no approval, at the most permissive level', async () => {
    // AGGRESSIVE is the default dial. It does not widen the band: Tier 2 is
    // hard-denied at every level, which is the floor this asserts.
    const r = await run({ plan: fullLadder(), autonomyLevel: 'AGGRESSIVE' })
    expect(r.status).toBe('refused')
    expect(r.haltReason).toMatch(/tier 2 requires an approval/)
  })

  it('refuses an approval issued for a different plan version', async () => {
    const plan = fullLadder()
    const r = await run({ plan, approvedPlanVersion: 'some-older-version' })
    expect(r.status).toBe('refused')
    expect(r.haltReason).toMatch(/different plan version/)
    expect(mockAddStructure).not.toHaveBeenCalled()
  })
})

// ── Mutations are off by default ─────────────────────────────────────────────

describe('mutations are disabled unless the environment enables them', () => {
  const ORIGINAL = process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS
    else process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS = ORIGINAL
  })

  it('halts at the first mutating step when the deployment flag is off', async () => {
    delete process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS
    const r = await run({ mutationsEnabled: true })
    expect(r.status).toBe('halted')
    expect(r.haltReason).toMatch(/mutations are disabled/)
    expect(mockAddStructure).not.toHaveBeenCalled()
  })

  it('does not let a caller widen what the environment permits', async () => {
    // The property that keeps "the code is deployed" and "it may write here"
    // separate: passing true is not consent, the environment is.
    delete process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS
    expect((await run({ mutationsEnabled: true })).status).toBe('halted')
  })

  it('lets a caller narrow what the environment permits', async () => {
    process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS = 'true'
    expect((await run({ mutationsEnabled: false })).status).toBe('halted')
    expect(mockAddStructure).not.toHaveBeenCalled()
  })

  it('classified and recorded the step anyway, so the dry run is informative', async () => {
    // The value of running with mutations off is learning whether the ladder
    // WOULD have been allowed. A refusal that skipped the gates would not
    // answer that.
    delete process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS
    const r = await run({ mutationsEnabled: true })
    expect(mockCreateExecution).toHaveBeenCalledTimes(1)
    expect(mockCreateExecution.mock.calls[0][0].data.status).toBe('running')
    expect(r.executionId).toBeTruthy()
  })
})

// ── Re-classification ────────────────────────────────────────────────────────

describe('classification is re-asked immediately before every mutation', () => {
  it('halts on an answer that changed after the plan was validated', async () => {
    // The plan is built while every rung is implemented, so `validity` is
    // `executable` and the up-front gates all pass. The capability then moves
    // under it — a deploy landing mid-ladder is the real version of this.
    //
    // An executor that classified once and trusted the result would run the
    // whole ladder. This one asks again at each rung, so it stops at the one
    // that changed.
    const plan = runnable()
    expect(plan.validity).toBe('executable')

    let outcome: any
    await jest.isolateModulesAsync(async () => {
      jest.doMock('@/lib/autonomy/maintenance/step', () => {
        const real = jest.requireActual('@/lib/autonomy/maintenance/step')
        return {
          ...real,
          classifyMaintenanceStep: (s: any) =>
            s.kind === 'verify'
              ? { tier: 0, executable: false, capability: 'not_implemented', reason: 'withdrawn mid-ladder' }
              : real.classifyMaintenanceStep(s),
        }
      })
      const { executeMaintenancePlan: exec } = require('@/lib/autonomy/maintenance/execute')
      outcome = await exec({
        plan,
        projectId: 'p1',
        currentCatalogFingerprint: 'cat-v1',
        autonomyLevel: 'AGGRESSIVE',
        bindings: bindingsFor(plan),
        mutationsEnabled: true,
      })
    })
    jest.dontMock('@/lib/autonomy/maintenance/step')

    expect(outcome.status).toBe('halted')
    expect(outcome.haltReason).toMatch(/not_implemented/)
    // Non-vacuity: the first rung DID run, so the halt came from re-asking at
    // the second one rather than from refusing the ladder up front.
    expect(mockAddStructure).toHaveBeenCalledTimes(1)
    expect(mockRunVerify).not.toHaveBeenCalled()
  })
})

// ── Resume ───────────────────────────────────────────────────────────────────

describe('a completed step is not applied twice', () => {
  it('skips it on a re-run and continues the ladder', async () => {
    const plan = runnable()
    stepRows.set(plan.steps[0].idempotencyKey, {
      id: 'step-existing',
      status: 'completed',
      idempotencyKey: plan.steps[0].idempotencyKey,
    })

    const r = await run({ plan })

    expect(r.status).toBe('completed')
    expect(r.steps[0]).toMatchObject({ status: 'skipped', detail: 'already applied' })
    expect(mockAddStructure).not.toHaveBeenCalled()
    // The rest of the ladder still ran: resuming is not the same as skipping.
    expect(mockRunVerify).toHaveBeenCalledTimes(1)
  })
})

// ── Halting ──────────────────────────────────────────────────────────────────

describe('a failed step halts the ladder', () => {
  it('does not continue past a failed mutation', async () => {
    mockAddStructure.mockResolvedValue({ added: false, refusal: 'column already exists', observed: null, identity: null })
    const r = await run()

    expect(r.status).toBe('halted')
    expect(r.haltReason).toMatch(/column already exists/)
    // No substitution, and no attempt at the next rung.
    expect(mockRunVerify).not.toHaveBeenCalled()
  })

  it('treats an inconclusive verification as a halt, not a pass', async () => {
    // The failure mode this exists for: an empty table, a dropped column and a
    // query that failed all report zero mismatches, and zero mismatches reads
    // like success to anything that only counts.
    mockRunVerify.mockResolvedValue({
      outcome: 'halt',
      mayProceed: false,
      summary: 'nothing was demonstrated: table has no rows',
      reconciliation: {},
    })

    const r = await run()
    expect(r.status).toBe('halted')
    expect(r.haltReason).toMatch(/nothing was demonstrated/)
  })

  it('records the halt reason on the execution row', async () => {
    mockAddStructure.mockResolvedValue({ added: false, refusal: 'nope', observed: null, identity: null })
    await run()
    const halted = [...executionRows.values()].find(e => e.status === 'halted')
    expect(halted?.haltReason).toMatch(/nope/)
  })
})

// ── Retry lifecycle is not duplicated ────────────────────────────────────────

describe('a backfill is dispatched, not looped', () => {
  it('hands the work to BackgroundJob and records the job id', async () => {
    // Tier 2, so it needs an approval; the ladder it lives on is blocked by the
    // Phase 7 rungs, so this drives the step directly through a plan whose
    // backfill rung is reachable only once switch_readers/contract exist. Until
    // then the assertion that matters is that the executor never loops batches
    // itself: BackgroundJob owns attempts, backoff and dead-lettering.
    const plan = fullLadder()
    const r = await run({ plan, approvedPlanVersion: plan.planVersion, approvalId: 'a1' })
    const backfill = r.steps.find(s => s.kind === 'backfill')
    expect(backfill).toMatchObject({ status: 'dispatched', backgroundJobId: 'job-1' })
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue.mock.calls[0][0]).toBe('maintenance_backfill')
  })
})


// ── Dispatched is not complete ───────────────────────────────────────────────

describe('a dispatched backfill stops the ladder', () => {
  const withBackfill = () => {
    const plan = fullLadder()
    return { plan, over: { plan, approvedPlanVersion: plan.planVersion, approvalId: 'a1' } }
  }

  const completed = (plan: MaintenancePlan, ...ordinals: number[]) => {
    for (const i of ordinals) {
      stepRows.set(plan.steps[i].idempotencyKey, {
        id: `s${i}`,
        status: 'completed',
        idempotencyKey: plan.steps[i].idempotencyKey,
      })
    }
  }

  /**
   * The ordinal of a step, by kind.
   *
   * Positional ordinals broke silently when `carry_constraints` was inserted
   * into the ladder: `dispatched(plan, 2)` went on marking "step 2" while step
   * 2 had become a different rung, and the tests failed somewhere else.
   */
  const at = (plan: MaintenancePlan, kind: string) => plan.steps.findIndex(s => s.kind === kind)

  const dispatched = (plan: MaintenancePlan, ordinal: number) => {
    stepRows.set(plan.steps[ordinal].idempotencyKey, {
      id: `s${ordinal}`,
      status: 'dispatched',
      backgroundJobId: 'job-1',
      idempotencyKey: plan.steps[ordinal].idempotencyKey,
    })
  }

  it('does not run verify in the same pass that dispatched the job', async () => {
    // The first production run walked from dispatch straight into verify, which
    // then reported on rows nothing had touched.
    const { over } = withBackfill()
    const r = await run(over)

    expect(r.status).toBe('awaiting_background_work')
    expect(r.haltReason).toMatch(/dispatched job job-1; run again once it completes/)
    expect(r.steps.map(s => s.kind)).toEqual([
      'add_structure', 'carry_constraints', 'dual_write', 'backfill',
    ])
    expect(mockRunVerify).not.toHaveBeenCalled()
  })

  it('waits while the job is still queued, without dispatching a second one', async () => {
    const { plan, over } = withBackfill()
    completed(plan, ...plan.steps.slice(0, at(plan, 'backfill')).map(x => x.ordinal))
    dispatched(plan, at(plan, 'backfill'))
    mockJobFindUnique.mockResolvedValue({ status: 'queued', result: null, error: null, attempts: 0 })

    const r = await run(over)
    expect(r.status).toBe('awaiting_background_work')
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockRunVerify).not.toHaveBeenCalled()
  })

  it('treats a SKIPPED job as a failure, not a completion', async () => {
    // Production's worker ran an image without the handler and marked the job
    // completed with { skipped: true }. "The job completed" was true while no
    // work had been done at all.
    const { plan, over } = withBackfill()
    completed(plan, ...plan.steps.slice(0, at(plan, 'backfill')).map(x => x.ordinal))
    dispatched(plan, at(plan, 'backfill'))
    mockJobFindUnique.mockResolvedValue({
      status: 'completed',
      result: { skipped: true, reason: 'No handler for job type maintenance_backfill' },
      error: null,
      attempts: 0,
    })

    const r = await run(over)
    expect(r.status).toBe('halted')
    expect(r.haltReason).toMatch(/SKIPPED/)
    expect(mockRunVerify).not.toHaveBeenCalled()
  })

  it('waits while a batch chain is still re-queueing itself', async () => {
    const { plan, over } = withBackfill()
    completed(plan, ...plan.steps.slice(0, at(plan, 'backfill')).map(x => x.ordinal))
    dispatched(plan, at(plan, 'backfill'))
    // done:false means another batch is queued behind this one.
    mockJobFindUnique.mockResolvedValue({ status: 'completed', result: { done: false, batches: 3 }, error: null, attempts: 0 })

    expect((await run(over)).status).toBe('awaiting_background_work')
    expect(mockRunVerify).not.toHaveBeenCalled()
  })

  it('resumes into verify once the job really finished', async () => {
    const { plan, over } = withBackfill()
    completed(plan, ...plan.steps.slice(0, at(plan, 'backfill')).map(x => x.ordinal))
    dispatched(plan, at(plan, 'backfill'))
    mockJobFindUnique.mockResolvedValue({
      status: 'completed',
      result: { done: true, updated: 80, batches: 1 },
      error: null,
      attempts: 0,
    })

    const r = await run(over)
    expect(mockRunVerify).toHaveBeenCalledTimes(1)
    expect(r.steps.find(s => s.kind === 'backfill')).toMatchObject({ status: 'completed' })
    expect(r.status).toBe('completed')
  })

  it('halts when the job dead-lettered', async () => {
    const { plan, over } = withBackfill()
    completed(plan, ...plan.steps.slice(0, at(plan, 'backfill')).map(x => x.ordinal))
    dispatched(plan, at(plan, 'backfill'))
    mockJobFindUnique.mockResolvedValue({ status: 'dead_letter', result: null, error: 'lock timeout', attempts: 5 })

    const r = await run(over)
    expect(r.status).toBe('halted')
    expect(r.haltReason).toMatch(/dead_letter/)
  })
})
