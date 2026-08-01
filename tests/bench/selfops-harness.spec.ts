/**
 * selfops-bench — the protocol, verified without a database.
 *
 * The database-backed lane needs Postgres and runs in CI. The rules that decide
 * what a run MEANS are pure, and they are the part a reader of the published
 * numbers is trusting. Each one below is a way a self-run benchmark can flatter
 * its author, asserted closed:
 *
 *   • A fixture that was already broken cannot be "repaired".
 *   • An injection that did not take cannot count as a pass.
 *   • Removing a vulnerability by breaking the feature is a FAILURE.
 *   • Void and errored cases stay out of the denominator.
 *   • The platform's own claim about what it fixed never decides the verdict.
 *
 * The lane here is a stub ON PURPOSE — this suite tests the scoring protocol,
 * not the reconciler. The reconciler is tested by running it (CI job
 * `selfops-bench`), because a stubbed loop that "heals" would prove nothing,
 * which is the exact vacuous-pass trap the probe suite already fell into once.
 */

import { runCase } from '@/bench/selfops/harness'
import { score } from '@/bench/selfops/report'
import { verdictFor } from '@/bench/selfops/types'
import type {
  CaseContext,
  FaultCase,
  LaneAdapter,
  Observation,
  TickResult,
} from '@/bench/selfops/types'

// ── A lane that does nothing, and one that "fixes" whatever it is told to ────

const ctx: CaseContext = {
  projectId: 'p1',
  userId: 'u1',
  schema: 'workspace_p1',
  sql: async () => {},
  query: async () => [],
  createTable: async () => {},
}

const idleTick: TickResult = {
  openFindings: 0,
  attempted: 0,
  applied: 0,
  escalated: 0,
  blocked: false,
  tokensSpent: 0,
}

function laneThat(ticks: Partial<TickResult>[]): LaneAdapter {
  let i = 0
  return {
    name: 'stub',
    healer: 'stub',
    provision: async () => ctx,
    tick: async () => ({ ...idleTick, ...(ticks[i++] ?? {}) }),
    teardown: async () => {},
  }
}

/** A case whose observations are scripted, so the protocol is what is tested. */
function caseWith(
  observations: Observation[],
  overrides: Partial<FaultCase> = {},
): FaultCase {
  let i = 0
  return {
    id: 'synthetic',
    title: 'synthetic',
    task: 'mitigation',
    scope: 'in_catalogue',
    severity: 'critical',
    crossPlatform: true,
    impact: 'synthetic',
    setup: async () => {},
    inject: async () => {},
    observe: async () => observations[Math.min(i++, observations.length - 1)],
    ...overrides,
  }
}

const ok: Observation = { vulnerable: false, functional: true, evidence: 'clean' }
const broken: Observation = { vulnerable: true, functional: true, evidence: 'leaking' }
const lockedOut: Observation = { vulnerable: false, functional: false, evidence: 'deny-all' }

// ── verdictFor ───────────────────────────────────────────────────────────────

describe('verdictFor', () => {
  it('passes only when the defect is gone AND the feature still works', () => {
    expect(verdictFor(ok)).toBe('healed')
  })

  it('scores a vulnerability removed by breaking the feature as a FAILURE', () => {
    // The whole reason the Observation has two axes. A one-axis benchmark
    // ("is it still leaking?") scores this identically to a real repair.
    expect(verdictFor(lockedOut)).toBe('over_corrected')
  })

  it('distinguishes still-broken from made-worse', () => {
    expect(verdictFor(broken)).toBe('not_repaired')
    expect(verdictFor({ vulnerable: true, functional: false, evidence: '' })).toBe('degraded')
  })
})

// ── The experimental protocol ────────────────────────────────────────────────

describe('runCase protocol', () => {
  it('voids a case whose fixture did not start healthy', async () => {
    // baseline observation is already broken → nothing can be attributed to
    // the injection, so the case must not be scored either way.
    const result = await runCase(caseWith([broken, broken, ok]), laneThat([{ applied: 1 }]))

    expect(result.verdict).toBe('harness_error')
    expect(result.error).toMatch(/did not start healthy/i)
    expect(result.ticksRun).toBe(0)
  })

  it('voids a case whose injection did not take, and never calls it a pass', async () => {
    // healthy baseline, still healthy after inject → the fault never existed.
    const result = await runCase(caseWith([ok, ok]), laneThat([{ applied: 1 }]))

    expect(result.verdict).toBe('never_faulted')
    expect(result.verdict).not.toBe('healed')
    expect(result.ticksRun).toBe(0)
  })

  it('records a repair only when the oracle reads healthy, not when the loop claims success', async () => {
    // The lane reports applied=1 on cycle 1 while the oracle still reads broken.
    // The repair must not be credited until the oracle actually flips, on cycle 2.
    const result = await runCase(
      caseWith([ok, broken, broken, ok]),
      laneThat([{ applied: 1, openFindings: 1 }, { applied: 1, openFindings: 1 }]),
    )

    expect(result.verdict).toBe('healed')
    expect(result.ticksToRepair).toBe(2)
    expect(result.ticksToDetect).toBe(1)
  })

  it('fails a case where the loop removed the vulnerability by locking everyone out', async () => {
    const result = await runCase(
      caseWith([ok, broken, lockedOut]),
      laneThat([{ applied: 1, openFindings: 1 }]),
    )

    expect(result.verdict).toBe('over_corrected')
    expect(result.ticksToRepair).toBeNull()
    // The loop still reports it applied a fix — recorded, but not decisive.
    expect(result.fixesApplied).toBe(1)
  })

  it('stops early once the loop has gone idle instead of burning the budget', async () => {
    const result = await runCase(caseWith([ok, broken]), laneThat([]), { maxCycles: 40 })

    expect(result.verdict).toBe('not_repaired')
    expect(result.ticksRun).toBeLessThan(10)
  })
})

// ── Scoring ──────────────────────────────────────────────────────────────────

describe('score', () => {
  const result = (over: Partial<ReturnType<typeof baseResult>>) => ({ ...baseResult(), ...over })

  function baseResult() {
    return {
      caseId: 'c',
      lane: 'stub',
      task: 'mitigation' as const,
      scope: 'in_catalogue' as const,
      severity: 'critical' as const,
      crossPlatform: true,
      verdict: 'healed' as const,
      before: broken,
      after: ok,
      ticksToDetect: 1,
      ticksToRepair: 1,
      ticksRun: 1,
      fixesApplied: 1,
      escalations: 0,
      tokensSpent: 0,
      trace: [],
    }
  }

  it('keeps void and errored cases out of the denominator', () => {
    const card = score(
      [
        result({ caseId: 'a', verdict: 'healed' }),
        result({ caseId: 'b', verdict: 'never_faulted' }),
        result({ caseId: 'c', verdict: 'harness_error' }),
      ],
      'stub',
    )

    // 1 of 1 scorable — not 1 of 3, and not 3 of 3.
    expect(card.scored).toBe(1)
    expect(card.repairRate).toBe(1)
    expect(card.void).toBe(1)
    expect(card.errors).toBe(1)
  })

  it('counts an over-correction against the repair rate', () => {
    const card = score(
      [
        result({ caseId: 'a', verdict: 'healed' }),
        result({ caseId: 'b', verdict: 'over_corrected', after: lockedOut, ticksToRepair: null }),
      ],
      'stub',
    )

    expect(card.repairRate).toBe(0.5)
    expect(card.overCorrected).toBe(1)
  })

  it('reports out-of-catalogue faults separately so they cannot pad the headline', () => {
    const card = score(
      [
        result({ caseId: 'a', verdict: 'healed' }),
        result({ caseId: 'b', verdict: 'not_repaired', scope: 'out_of_catalogue' }),
      ],
      'stub',
    )

    expect(card.repairRate).toBe(1)          // in-catalogue only
    expect(card.outOfCatalogue.total).toBe(1)
    expect(card.outOfCatalogue.healed).toBe(0)
  })

  it('counts findings and mutations on the healthy control as false positives', () => {
    const card = score(
      [
        result({
          caseId: 'control-healthy-backend',
          verdict: 'never_faulted',
          fixesApplied: 2,
          trace: [{ ...idleTick, openFindings: 3 }, { ...idleTick, openFindings: 1 }],
        }),
      ],
      'stub',
    )

    expect(card.control.findingsRaised).toBe(3)
    expect(card.control.mutationsApplied).toBe(2)
    // The control must never contribute to the repair rate.
    expect(card.scored).toBe(0)
  })
})
