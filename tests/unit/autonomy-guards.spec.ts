/**
 * Phase 2 guards: sensor honesty and fix acceptance.
 *
 * Both encode lessons from real incidents in this codebase:
 *
 *   detectMissingRls returned [] in every environment because it swallowed its
 *   own error. Nothing threw, so nothing looked wrong, and the dashboard stayed
 *   green for months. "No findings" and "cannot produce findings" were the same
 *   value.
 *
 *   An agent that could not write to a timestamp column cast the column to
 *   integer instead. The migration reported success, the tool call was green,
 *   and the schema was wrong for months — because the only thing checked was
 *   whether the command ran.
 */

import {
  classifyProbeOutcomes,
  summariseSensorHealth,
  type ProbeRun,
} from '@/lib/autonomy/sensor-health'
import {
  evaluateFixAcceptance,
  checksFromDesiredState,
  type CheckState,
} from '@/lib/autonomy/fix-acceptance'

// ── sensor health ────────────────────────────────────────────────────────────

const run = (over: Partial<ProbeRun> = {}): ProbeRun => ({
  id: 'rls_is_enabled',
  title: 'Every table has RLS',
  findingCount: 0,
  ...over,
})

describe('sensor health', () => {
  it('a silent probe that has NEVER fired is unverified, not clean — the detectMissingRls case', () => {
    const report = classifyProbeOutcomes([run({ findingCount: 0 })], new Map())
    expect(report.probes[0].status).toBe('unverified')
    expect(report.fullyInstrumented).toBe(false)
  })

  it('a silent probe that HAS fired before is verified clean', () => {
    const report = classifyProbeOutcomes(
      [run({ findingCount: 0 })],
      new Map([['rls_is_enabled', '2026-07-01T00:00:00Z']]),
    )
    expect(report.probes[0].status).toBe('clean')
    expect(report.fullyInstrumented).toBe(true)
  })

  it('a probe producing findings is proven working', () => {
    const report = classifyProbeOutcomes([run({ findingCount: 3 })], new Map())
    expect(report.probes[0].status).toBe('fired')
    expect(report.probes[0].findingCount).toBe(3)
  })

  it('a throwing probe is errored — never healthy', () => {
    const report = classifyProbeOutcomes([run({ error: 'bind parameter mismatch' })], new Map())
    expect(report.probes[0].status).toBe('errored')
    expect(report.errored).toBe(1)
    expect(report.fullyInstrumented).toBe(false)
  })

  it('an errored probe stays errored even if it once fired', () => {
    const report = classifyProbeOutcomes(
      [run({ error: 'boom' })],
      new Map([['rls_is_enabled', '2026-07-01T00:00:00Z']]),
    )
    expect(report.probes[0].status).toBe('errored')
  })

  it('never reports a clean bill of health while any probe is unverified', () => {
    const report = classifyProbeOutcomes(
      [
        run({ id: 'a', findingCount: 0 }),
        run({ id: 'b', findingCount: 0 }),
      ],
      new Map([['a', '2026-07-01T00:00:00Z']]),
    )
    expect(report.unverified).toBe(1)
    expect(report.fullyInstrumented).toBe(false)
  })

  it('the summary says silence is not evidence', () => {
    const summary = summariseSensorHealth(
      classifyProbeOutcomes([run({ findingCount: 0 })], new Map()),
    )
    expect(summary).toMatch(/UNVERIFIED/)
    expect(summary).toMatch(/not evidence/i)
  })
})

// ── fix acceptance ───────────────────────────────────────────────────────────

const check = (id: string, passing: boolean): CheckState => ({ id, passing })

describe('fix acceptance', () => {
  it('accepts only when the targeted check flips to passing', () => {
    const r = evaluateFixAcceptance('rls', [check('rls', false)], [check('rls', true)])
    expect(r.verdict).toBe('accepted')
    expect(r.accepted).toBe(true)
  })

  it('REJECTS when the targeted check still fails — "the command succeeded" is not enough', () => {
    const r = evaluateFixAcceptance('rls', [check('rls', false)], [check('rls', false)])
    expect(r.verdict).toBe('not_fixed')
    expect(r.accepted).toBe(false)
    expect(r.reason).toMatch(/still failing/i)
  })

  it('REJECTS when the fix broke something else — the cast_column case', () => {
    const r = evaluateFixAcceptance(
      'writable',
      [check('writable', false), check('schema_matches_intent', true)],
      [check('writable', true), check('schema_matches_intent', false)],
    )
    expect(r.verdict).toBe('regression')
    expect(r.accepted).toBe(false)
    expect(r.regressions).toEqual(['schema_matches_intent'])
    expect(r.reason).toMatch(/roll back/i)
  })

  it('REJECTS when the target was already passing — nothing was proven', () => {
    const r = evaluateFixAcceptance('rls', [check('rls', true)], [check('rls', true)])
    expect(r.verdict).toBe('no_baseline')
    expect(r.accepted).toBe(false)
  })

  it('REJECTS when no baseline was captured at all', () => {
    const r = evaluateFixAcceptance('rls', [], [check('rls', true)])
    expect(r.verdict).toBe('no_baseline')
    expect(r.accepted).toBe(false)
  })

  it('REJECTS when the check cannot be evaluated afterwards — unevaluated is not passing', () => {
    const r = evaluateFixAcceptance('rls', [check('rls', false)], [])
    expect(r.verdict).toBe('unverifiable')
    expect(r.accepted).toBe(false)
  })

  it('does not count a check that was already failing as a regression', () => {
    const r = evaluateFixAcceptance(
      'a',
      [check('a', false), check('b', false)],
      [check('a', true), check('b', false)],
    )
    expect(r.verdict).toBe('accepted')
    expect(r.regressions).toEqual([])
  })

  it('never accepts on the fix reporting its own success — that input does not exist', () => {
    // The signature deliberately has no "the command succeeded" parameter.
    expect(evaluateFixAcceptance.length).toBe(3)
  })
})

describe('checksFromDesiredState', () => {
  it('treats an invariant with gaps as failing even if flagged satisfied', () => {
    const checks = checksFromDesiredState({
      invariants: [
        { id: 'a', satisfied: true, gaps: [] },
        { id: 'b', satisfied: true, gaps: [{}] },
        { id: 'c', satisfied: false, gaps: [] },
      ],
    })
    expect(checks).toEqual([
      { id: 'a', passing: true },
      { id: 'b', passing: false },
      { id: 'c', passing: false },
    ])
  })
})
