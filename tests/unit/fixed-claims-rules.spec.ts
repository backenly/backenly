/**
 * The rules that decide whether anything may be called fixed or healthy.
 *
 *   closureOf / fixVerificationOf  (lib/autonomy/resolution.ts)
 *   sensorStateFrom                (lib/autonomy/sensor-state.ts)
 *   quietState / freshlyVerifiedRepairs (components/workspace/health-state.ts)
 *
 * Pure functions, no database: the integration suite proves the routes use
 * them (tests/integration/fixed-claims-from-verified-state.spec.ts).
 */
import { closureOf, fixVerificationOf } from '@/lib/autonomy/resolution'
import { sensorStateFrom } from '@/lib/autonomy/sensor-state'
import { freshlyVerifiedRepairs, quietState, LOOP_STALE_MS } from '@/components/workspace/health-state'

describe('closureOf', () => {
  it('calls a repair verified only when a re-check confirmed it', () => {
    expect(closureOf({ status: 'auto_fixed', details: { rollbackData: { verification: 'confirmed' } } }))
      .toBe('autonomy_verified')
    expect(closureOf({ status: 'auto_fixed', details: { verification: 'confirmed' } }))
      .toBe('autonomy_verified')
  })

  it('separates a human-approved verified repair', () => {
    expect(closureOf({
      status: 'auto_fixed',
      details: { rollbackData: { verification: 'confirmed', approvedBy: 'user-1' } },
    })).toBe('approved_verified')
  })

  it('never calls an unconfirmed or unrecorded repair verified', () => {
    for (const details of [
      { rollbackData: { verification: 'unverified' } },
      { rollbackData: { verification: 'verification_error' } },
      { rollbackData: {} },
      {},
      null,
    ]) {
      expect(closureOf({ status: 'auto_fixed', details })).toBe('applied_unverified')
    }
  })

  it('tells a withdrawal and a dismissal apart from a repair', () => {
    expect(closureOf({ status: 'dismissed', details: { withdrawnBy: 'workflow_reaper' } })).toBe('condition_cleared')
    expect(closureOf({ status: 'dismissed', details: { withdrawnBy: 'detector_retired' } })).toBe('detector_retired')
    expect(closureOf({ status: 'dismissed', details: {} })).toBe('dismissed')
  })

  it('reports nothing for findings still in the queue', () => {
    expect(closureOf({ status: 'open', details: {} })).toBeNull()
    expect(closureOf({ status: 'pending_approval', details: {} })).toBeNull()
  })
})

describe('fixVerificationOf', () => {
  it('reads either recorded location and rejects anything else', () => {
    expect(fixVerificationOf({ rollbackData: { verification: 'confirmed' } })).toBe('confirmed')
    expect(fixVerificationOf({ verification: 'unverified' })).toBe('unverified')
    expect(fixVerificationOf({ verification: 'yes' })).toBeNull()
    expect(fixVerificationOf(undefined)).toBeNull()
  })
})

describe('sensorStateFrom', () => {
  // Shaped like computeDesiredStateDiff's output: every invariant is listed in
  // `invariants`, including the ones that errored or were not run.
  const report = (over: Record<string, unknown> = {}) => ({
    projectId: 'p',
    evaluatedAt: '2026-10-11T00:00:00.000Z',
    satisfied: false,
    invariants: [
      { id: 'a', title: 'Row security on user data', satisfied: true, gaps: [] },
      { id: 'b', title: 'Foreign keys indexed', satisfied: false, gaps: [] },
      { id: 'c', title: 'APIs answer', satisfied: true, gaps: [] },
      { id: 'd', title: 'Slow queries', satisfied: false, gaps: [] },
    ],
    violations: [],
    tierCounts: {},
    errors: ['[b] permission denied for table x'],
    disabled: [{ id: 'd', title: 'Slow queries', capability: 'pg_stat_statements', remediation: 'enable pg_stat_statements' }],
    ...over,
  }) as any

  it('counts only the checks that ran, and names the blind and disabled ones', () => {
    const state = sensorStateFrom(report())
    expect(state.total).toBe(4)
    expect(state.ran).toBe(2)
    expect(state.errored).toEqual([{ id: 'b', title: 'Foreign keys indexed', error: 'permission denied for table x' }])
    expect(state.disabled).toEqual([{ id: 'd', title: 'Slow queries', reason: 'enable pg_stat_statements' }])
  })

  it('reports a check switched off by configuration as not run', () => {
    const state = sensorStateFrom(report({
      disabled: [{ id: 'd', title: 'Slow queries', capability: undefined, remediation: '' }],
    }))
    expect(state.ran).toBe(2)
    expect(state.disabled).toEqual([{ id: 'd', title: 'Slow queries', reason: 'not enabled on this install' }])
  })
})

describe('quietState', () => {
  const now = Date.parse('2026-10-11T12:00:00.000Z')
  const fresh = new Date(now - 60_000).toISOString()
  const ago = () => 'a while ago'
  const sensors = (errored = 0, disabled = 0) => ({
    at: fresh,
    total: 10 + disabled,
    ran: 10 - errored,
    errored: Array.from({ length: errored }, (_, i) => ({ id: `e${i}`, title: `Check ${i}`, error: 'x' })),
    disabled: Array.from({ length: disabled }, (_, i) => ({ id: `d${i}`, title: `Off ${i}`, reason: 'y' })),
  })

  it('never claims health when the health check did not load', () => {
    const s = quietState({ health: null, healthError: true, autonomyOff: false, now, formatAgo: ago })
    expect(s.headline).toBe('Can’t confirm health right now')
    expect(`${s.headline} ${s.body}`).not.toMatch(/healthy|all clear|no issues/i)
    expect(s.caveat).toBe(true)
  })

  it('never vouches for an earlier payload once the latest load failed', () => {
    const s = quietState({ health: { lastReconciledAt: fresh, sensors: sensors() }, healthError: true, autonomyOff: false, now, formatAgo: ago })
    expect(s.headline).toBe('Can’t confirm health right now')
  })

  it('treats an unknown read time as not fresh', () => {
    for (const unknown of [0, NaN]) {
      const s = quietState({ health: { lastReconciledAt: fresh, sensors: sensors() }, healthError: false, autonomyOff: false, now: unknown, formatAgo: ago })
      expect(s.headline).toBe('No recent check to report')
    }
  })

  it('never claims health from a stale or missing loop pass', () => {
    const stale = new Date(now - LOOP_STALE_MS - 1000).toISOString()
    for (const lastReconciledAt of [stale, null]) {
      const s = quietState({ health: { lastReconciledAt, sensors: sensors() }, healthError: false, autonomyOff: false, now, formatAgo: ago })
      expect(s.headline).toBe('No recent check to report')
      expect(`${s.headline} ${s.body}`).not.toMatch(/healthy|all clear|no issues detected/i)
      expect(s.caveat).toBe(true)
    }
  })

  it('names checks that could not run instead of calling the backend clean', () => {
    const s = quietState({ health: { lastReconciledAt: fresh, sensors: sensors(2) }, healthError: false, autonomyOff: false, now, formatAgo: ago })
    expect(s.headline).toBe('2 checks could not run')
    expect(s.body).toMatch(/Check 0, Check 1/)
    expect(s.caveat).toBe(true)
  })

  it('reports exactly what ran when every check could see', () => {
    const s = quietState({ health: { lastReconciledAt: fresh, sensors: sensors(0, 1) }, healthError: false, autonomyOff: false, now, formatAgo: ago })
    expect(s.headline).toBe('No issues detected. Self-healing on watch')
    expect(s.body).toMatch(/the 10 checks/)
    expect(s.body).toMatch(/1 more is off on this install/)
    expect(`${s.headline} ${s.body}`).not.toMatch(/healthy|all clear/i)
    expect(s.caveat).toBe(false)
  })

  it('has no caveat while the first load is still in flight', () => {
    expect(quietState({ health: null, healthError: false, autonomyOff: false, now, formatAgo: ago }).caveat).toBe(false)
  })

  it('does not promise repairs when self-healing is off', () => {
    const s = quietState({ health: { lastReconciledAt: fresh, sensors: sensors() }, healthError: false, autonomyOff: true, now, formatAgo: ago })
    expect(s.headline).toBe('No issues detected')
    expect(s.body).toMatch(/does not repair them/)
  })
})

describe('freshlyVerifiedRepairs', () => {
  it('animates only confirmed repairs not shown before', () => {
    const resolved = [
      { id: 'a', closedBy: 'autonomy_verified' },
      { id: 'b', closedBy: 'applied_unverified' },
      { id: 'c', closedBy: 'condition_cleared' },
      { id: 'd', closedBy: 'dismissed' },
      { id: 'e', closedBy: 'autonomy_verified' },
    ]
    expect(freshlyVerifiedRepairs(resolved, new Set(['e']))).toEqual(['a'])
  })
})
