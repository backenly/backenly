/**
 * PLATFORM CAPABILITY GATE — a probe with no data source must not read green
 * ---------------------------------------------------------------------------
 * `detectSlowQueryMissingIndexes` returned `[]` when pg_stat_statements was not
 * installed. That is indistinguishable from "I looked and the backend is fine",
 * so on every database without the extension the invariant reported satisfied,
 * the summary said "Backend is healthy — all guarantees hold", and the only
 * measurement-driven detector in the product had never once run.
 *
 * The fix is a third state — not satisfied, not an error — and it has to stay
 * out of `report.errors` specifically: `reapInvariantFindings` returns 0 while
 * that array is non-empty, so putting a permanently-absent extension there
 * would freeze stale-finding withdrawal platform-wide. That regression has
 * happened once already (2026-08-07) and cost thirteen days of silent staleness.
 *
 * This file pins both halves: unchecked is not satisfied, and unchecked does
 * not stop the reaper.
 */

import { describe, test, expect } from '@jest/globals'
import {
  summarizeDesiredState,
  type DesiredStateReport,
} from '@/lib/autonomy/desired-state'
import { classifyProbeOutcomes } from '@/lib/autonomy/sensor-health'

const REMEDIATION =
  'Measured query latency is unavailable because the pg_stat_statements extension is not installed.'

function reportWith(over: Partial<DesiredStateReport>): DesiredStateReport {
  return {
    projectId: 'p1',
    evaluatedAt: new Date().toISOString(),
    satisfied: false,
    invariants: [],
    violations: [],
    tierCounts: { 0: 0, 1: 0, 2: 0, 3: 0 },
    errors: [],
    disabled: [],
    ...over,
  }
}

describe('desired-state — a disabled probe is never a clean bill of health', () => {
  test('summary refuses to call an unchecked backend healthy', () => {
    const s = summarizeDesiredState(
      reportWith({
        satisfied: false,
        disabled: [
          {
            id: 'measured_slow_queries_are_indexed',
            title: 'Columns the database measurably spends time filtering on are indexed',
            capability: 'pg_stat_statements',
            remediation: REMEDIATION,
          },
        ],
      }),
    )
    expect(s).not.toMatch(/all guarantees hold/i)
    expect(s).toMatch(/could not be checked/i)
    // Zero violations plus one unchecked invariant must not print "0 issues
    // found", which reads as an all-clear.
    expect(s).not.toMatch(/^0 /)
  })

  test('disabled probes are counted alongside errors in a mixed report', () => {
    const s = summarizeDesiredState(
      reportWith({
        violations: [
          { invariantId: 'a', type: 'missing_fk_index', severity: 'warning', tier: 0, details: {} },
        ],
        tierCounts: { 0: 1, 1: 0, 2: 0, 3: 0 },
        errors: ['[some_probe] boom'],
        disabled: [
          {
            id: 'measured_slow_queries_are_indexed',
            title: 't',
            capability: 'pg_stat_statements',
            remediation: REMEDIATION,
          },
        ],
      }),
    )
    expect(s).toContain('1 issue found')
    expect(s).toContain('2 could not be checked')
  })

  test('a fully clean report still reads as healthy', () => {
    expect(summarizeDesiredState(reportWith({ satisfied: true }))).toMatch(/healthy/i)
  })
})

describe('sensor-health — disabled is its own status', () => {
  test('a skipped probe is disabled, not unverified', () => {
    const r = classifyProbeOutcomes(
      [
        {
          id: 'measured_slow_queries_are_indexed',
          title: 't',
          findingCount: 0,
          disabledReason: REMEDIATION,
        },
      ],
      new Map(),
    )
    expect(r.probes[0].status).toBe('disabled')
    expect(r.disabled).toBe(1)
    // `unverified` means "ran quietly and might be broken". A probe that never
    // ran is not that, and conflating them buries an operator-fixable fact in
    // the pile of maybes.
    expect(r.unverified).toBe(0)
    expect(r.fullyInstrumented).toBe(false)
  })

  test('the summary names the probe and its remedy, not just a count', () => {
    const { summariseSensorHealth } = require('@/lib/autonomy/sensor-health')
    const r = classifyProbeOutcomes(
      [
        { id: 'measured_slow_queries_are_indexed', title: 't', findingCount: 0, disabledReason: REMEDIATION },
        { id: 'user_data_is_rls_protected', title: 't2', findingCount: 2 },
      ],
      new Map(),
    )
    const s = summariseSensorHealth(r)
    expect(s).toContain('measured_slow_queries_are_indexed')
    expect(s).toMatch(/pg_stat_statements/)
  })

  test('disabled outranks the never-fired heuristic even with no history', () => {
    const r = classifyProbeOutcomes(
      [{ id: 'x', title: 't', findingCount: 0, disabledReason: 'nope' }],
      new Map([['x', new Date().toISOString()]]),
    )
    // Even a probe that HAS fired before is `disabled` while its capability is
    // gone — its past success says nothing about the current pass.
    expect(r.probes[0].status).toBe('disabled')
  })
})
