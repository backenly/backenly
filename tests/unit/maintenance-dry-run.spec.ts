/**
 * THE DRY RUN — the answer you need before enabling writes anywhere
 * =================================================================
 *
 * Reports, per rung, whether it WOULD execute right now, and where the ladder
 * would stop. The properties that matter:
 *
 *   it writes nothing            not even a ledger row, so it is safe to point
 *                                at production before mutations exist there
 *   it reports every rung        the executor halts at the first mutating step,
 *                                which is exactly the part an operator cannot
 *                                see; this evaluates all six
 *   it uses the executor's gates the same imported functions, not a second
 *                                implementation that can drift
 *   it never prints a count for  PostgREST clients and connection strings
 *   unobservable readers         answer to nobody, so the number is unknown
 *
 * Pure: the plan is built in-process and the reader inventory is mocked, so
 * every gate combination is cheap to enumerate.
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

const mockInventoryReaders = jest.fn()
jest.mock('@/lib/autonomy/maintenance/readers', () => ({
  inventoryReaders: (...a: any[]) => mockInventoryReaders(...(a as [])),
}))

import { dryRunPlan } from '@/lib/autonomy/maintenance/dry-run'
import { buildMaintenancePlan, type MaintenancePlan } from '@/lib/autonomy/maintenance/plan'
import type { StepBinding } from '@/lib/autonomy/maintenance/execute'

const COVERAGE = {
  policiesReadable: true,
  constraintCatalogReadable: true,
  statementTelemetryAvailable: true,
  largestSampleRows: 120,
  sampleSufficient: true,
  notes: [],
}

const diagnosis = (id: string): StructuralDiagnosis =>
  ({
    kind: 'structural_cause_identified',
    hypothesis: { id, statement: 's', prior: 0.25, predicts: {}, remedy: { summary: 'r', autoApplicable: false } },
    confidence: 0.92,
    coverage: COVERAGE,
    blockedBy: [],
    raisedOnly: [],
    reason: 'confirmed',
    trail: ['…'],
    report: { symptomId: 'subsystem_repeat_failure', verdict: { kind: 'no_symptom' }, observations: [], unavailable: [], trail: [] },
  }) as unknown as StructuralDiagnosis

const build = (id: string): MaintenancePlan =>
  buildMaintenancePlan({
    findingId: 'f1',
    diagnosis: diagnosis(id),
    subsystem: { fingerprint: 'sessions', membership: ['sessions', 'users'] },
    catalogFingerprint: 'cat-v1',
  })

const fullLadder = () => build('duplicated_lifecycle_state')

const bindingsFor = (plan: MaintenancePlan): Record<number, StepBinding> => {
  const out: Record<number, StepBinding> = {}
  const cols = { table: 'sessions', sourceColumn: 'status', targetColumn: 'state', transform: { kind: 'identity' as const } }
  for (const s of plan.steps) {
    if (s.kind === 'add_structure') out[s.ordinal] = { kind: 'add_structure', verb: 'ADD_COLUMN', table: 'sessions', column: 'state', columnType: 'text' }
    else if (s.kind === 'carry_constraints') out[s.ordinal] = { kind: 'carry_constraints', ...cols, allowedValues: ['ACTIVE'] }
    else if (s.kind === 'dual_write') out[s.ordinal] = { kind: 'dual_write', ...cols }
    else if (s.kind === 'backfill') out[s.ordinal] = { kind: 'backfill', ...cols }
    else if (s.kind === 'verify') out[s.ordinal] = { kind: 'verify', ...cols }
    else if (s.kind === 'switch_readers') out[s.ordinal] = { kind: 'switch_readers', table: 'sessions', sourceColumn: 'status', targetColumn: 'state' }
  }
  return out
}

const run = (over: Partial<Parameters<typeof dryRunPlan>[0]> = {}) => {
  const plan = over.plan ?? fullLadder()
  return dryRunPlan({
    plan,
    projectId: 'p1',
    table: 'sessions',
    sourceColumn: 'status',
    currentCatalogFingerprint: 'cat-v1',
    autonomyLevel: 'AGGRESSIVE',
    approvedPlanVersion: plan.planVersion,
    mutationsEnvironmentEnabled: true,
    bindings: bindingsFor(plan),
    ...over,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockInventoryReaders.mockResolvedValue({
    controllable: [{ id: 'fn1' }, { id: 'fn2' }],
    unobservable: [{}, {}, {}],
    coverage: 'partial',
  })
})

describe('the happy path an operator is looking for', () => {
  it('reports every rung executable and stops at the human step', async () => {
    const r = await run()

    expect(r.verdict).toBe('WOULD_STOP_AWAITING_HUMAN_CONTRACT')
    expect(r.steps.map(s => [s.kind, s.classification, s.wouldExecute])).toEqual([
      ['add_structure', 'implemented', true],
      ['carry_constraints', 'implemented', true],
      ['dual_write', 'implemented', true],
      ['backfill', 'implemented', true],
      ['verify', 'implemented', true],
      ['switch_readers', 'implemented', true],
      ['contract', 'human_only', false],
    ])
    expect(r.catalogFingerprintMatches).toBe(true)
    expect(r.approvalValid).toBe(true)
    expect(r.bindingsComplete).toBe(true)
    expect(r.refusals).toEqual([])
  })

  it('reports readers it can move as a count, and the rest as unknown', async () => {
    const r = await run()
    expect(r.controllableReaders).toBe(2)
    // Never a number. A `0` here would be the most misleading value on the page.
    expect(r.uncontrollableReaders).toBe('unknown-standing-fact')
  })

  it('states plainly that it wrote nothing', async () => {
    const r = await run()
    expect(r.ledgerWritten).toBe(false)
  })

  it('reports every rung, which the executor never could', async () => {
    // The executor halts at the FIRST mutating step, so running it with
    // mutations off answers only about rung one. Reporting on the rest is the
    // whole reason this is a separate evaluation.
    const r = await run({ mutationsEnvironmentEnabled: false })
    expect(r.steps).toHaveLength(7)
    // Every rung but verify (reads only) and contract (human-only, blocked
    // earlier for that reason).
    expect(r.steps.filter(s => s.blockedBy?.includes('mutations are not enabled'))).toHaveLength(5)
  })
})

describe('each gate shows up as a reason, on the rung it affects', () => {
  it('refuses the whole ladder when the catalog moved', async () => {
    const r = await run({ currentCatalogFingerprint: 'cat-v2' })
    expect(r.verdict).toBe('WOULD_REFUSE')
    expect(r.catalogFingerprintMatches).toBe(false)
    expect(r.refusals.join(' ')).toMatch(/catalog moved/)
  })

  it('blocks the tier-2 rungs when the approval is for another version', async () => {
    const r = await run({ approvedPlanVersion: 'some-older-version' })
    expect(r.approvalValid).toBe(false)
    const blocked = r.steps.filter(s => s.blockedBy?.includes('tier 2 requires an approval'))
    // carry_constraints is Tier 2 for dual_write's reason: a CHECK is additive
    // to the schema and restrictive to behaviour, and only the second decides.
    expect(blocked.map(s => s.kind)).toEqual([
      'carry_constraints', 'dual_write', 'backfill', 'switch_readers',
    ])
    expect(r.verdict).toBe('WOULD_HALT_MID_LADDER')
  })

  it('blocks the tier-1 rung when the dial is OFF', async () => {
    const r = await run({ autonomyLevel: 'OFF' })
    const addStructure = r.steps.find(s => s.kind === 'add_structure')!
    expect(addStructure.wouldExecute).toBe(false)
    expect(addStructure.blockedBy).toMatch(/does not permit tier 1/)
  })

  it('leaves the read-only rung executable when mutations are off', async () => {
    // verify reads and compares. A safety check nobody is allowed to run is not
    // a safety check.
    const r = await run({ mutationsEnvironmentEnabled: false })
    expect(r.steps.find(s => s.kind === 'verify')!.wouldExecute).toBe(true)
  })

  it('reports a missing binding on the rung that needs it', async () => {
    const plan = fullLadder()
    const bindings = bindingsFor(plan)
    delete bindings[2]
    const r = await run({ plan, bindings })
    expect(r.bindingsComplete).toBe(false)
    expect(r.steps[2].blockedBy).toMatch(/no binding/)
  })

  it('never marks the human-only rung executable, whatever else is true', async () => {
    for (const over of [{}, { autonomyLevel: 'OFF' as const }, { approvedPlanVersion: null }]) {
      const r = await run(over)
      const contract = r.steps.find(s => s.kind === 'contract')!
      expect(contract.wouldExecute).toBe(false)
      expect(contract.classification).toBe('human_only')
      expect(contract.tier).toBe(3)
    }
  })
})

describe('the verdict', () => {
  it('is WOULD_REFUSE only when nothing would run at all', async () => {
    expect((await run({ currentCatalogFingerprint: 'nope' })).verdict).toBe('WOULD_REFUSE')
  })

  it('is WOULD_HALT_MID_LADDER when an executable rung is blocked', async () => {
    expect((await run({ autonomyLevel: 'OFF' })).verdict).toBe('WOULD_HALT_MID_LADDER')
  })

  it('survives a reader inventory that could not be read', async () => {
    // A failed inventory must not crash the report. It reports zero
    // CONTROLLABLE readers, which is the honest reading: none could be seen.
    mockInventoryReaders.mockRejectedValue(new Error('no such project'))
    const r = await run()
    expect(r.controllableReaders).toBe(0)
    expect(r.uncontrollableReaders).toBe('unknown-standing-fact')
  })
})
