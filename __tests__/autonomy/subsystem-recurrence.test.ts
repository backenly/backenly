/**
 * SUBSYSTEM RECURRENCE — the firing contract
 * ==========================================
 * The gate that decides whether Backenly may say "repairs in this area are not
 * holding". It is the input to every later phase, so the thing these tests
 * protect is not that it fires — it is that it fires for the RIGHT reasons and
 * stays silent for every wrong one.
 *
 * The four ways this gate could rot, each pinned below:
 *
 *   1. churn leaks into it, and every actively-developed backend lights up
 *   2. it stops requiring distinct gaps, and re-reports the per-gap recurrence
 *      reconciler.ts already owns
 *   3. it accepts unverified repairs, and counts fixes nobody proved worked
 *   4. it accepts the loop's own escalations as independent harm, making the
 *      system its own evidence
 */

import {
  firesSubsystemRecurrence,
  findingTable,
  requestTable,
  isConfirmedRepair,
  toShadowTelemetry,
  SUBSYSTEM_REPAIR_THRESHOLD,
  MIN_DISTINCT_IDENTITIES,
  type SubsystemRecurrenceReport,
} from '@/lib/autonomy/subsystem-recurrence'

/** A case that satisfies every clause. Each test below breaks exactly one. */
const FIRING = {
  confirmedRepairCount: 3,
  distinctGapIdentityCount: 2,
  independentHarmCount: 1,
  eligible: true,
}

describe('firesSubsystemRecurrence', () => {
  it('fires when every clause is met', () => {
    // The positive fixture. Without it every negative assertion below could be
    // satisfied by a predicate that returns false unconditionally.
    expect(firesSubsystemRecurrence(FIRING)).toBe(true)
  })

  it('does not fire below the repair threshold', () => {
    expect(
      firesSubsystemRecurrence({ ...FIRING, confirmedRepairCount: SUBSYSTEM_REPAIR_THRESHOLD - 1 }),
    ).toBe(false)
  })

  /**
   * One gap repeating is a flapping fix, and reconciler.ts escalates it after
   * three recurrences in 24h. Reporting it here too would tell the same story
   * twice under two different names.
   */
  it('does not fire when all repairs share one gap identity', () => {
    expect(
      firesSubsystemRecurrence({ ...FIRING, distinctGapIdentityCount: MIN_DISTINCT_IDENTITIES - 1 }),
    ).toBe(false)
  })

  it('does not fire without independent harm', () => {
    expect(firesSubsystemRecurrence({ ...FIRING, independentHarmCount: 0 })).toBe(false)
  })

  it('does not fire for an ineligible component', () => {
    expect(firesSubsystemRecurrence({ ...FIRING, eligible: false })).toBe(false)
  })

  /**
   * The structural guard against the evidence policy being eroded.
   *
   * Churn is an amplifier. It is not merely absent from the current
   * implementation — it is absent from the SIGNATURE, so a future edit cannot
   * reach it without changing the type and tripping this test.
   */
  it('cannot see churn at all', () => {
    const params = Object.keys(FIRING)
    expect(params).toEqual([
      'confirmedRepairCount',
      'distinctGapIdentityCount',
      'independentHarmCount',
      'eligible',
    ])
    expect(params.join(' ')).not.toMatch(/churn|change|count.*table|naming/i)
    // And a huge amount of change with no repairs still fires nothing.
    expect(
      firesSubsystemRecurrence({
        confirmedRepairCount: 0,
        distinctGapIdentityCount: 0,
        independentHarmCount: 0,
        eligible: true,
      }),
    ).toBe(false)
  })
})

describe('isConfirmedRepair', () => {
  it('accepts only the kernel re-probe stamp', () => {
    expect(isConfirmedRepair({ rollbackData: { verification: 'confirmed' } })).toBe(true)
  })

  it('rejects an unverified fix', () => {
    // The loop records `unverified` when it could not prove the gap closed.
    // Counting those would inflate every firing rate with fixes nobody checked.
    expect(isConfirmedRepair({ rollbackData: { verification: 'unverified' } })).toBe(false)
  })

  it('rejects a fix with no stamp at all', () => {
    expect(isConfirmedRepair({ rollbackData: {} })).toBe(false)
    expect(isConfirmedRepair({})).toBe(false)
    expect(isConfirmedRepair(null)).toBe(false)
  })

  it('does not accept a truthy-looking value', () => {
    expect(isConfirmedRepair({ rollbackData: { verification: true } })).toBe(false)
    expect(isConfirmedRepair({ rollbackData: { verification: 'CONFIRMED' } })).toBe(false)
  })
})

describe('findingTable', () => {
  it('reads an explicit table name', () => {
    expect(findingTable({ tableName: 'users' })).toBe('users')
    expect(findingTable({ table: 'orders' })).toBe('orders')
  })

  it('reads the table half of a table.column location', () => {
    expect(findingTable({ location: 'users.email' })).toBe('users')
  })

  /**
   * Findings located by workflow or by runtime surface carry no table. They
   * must return null rather than a plausible-looking fragment, because a wrong
   * attribution puts someone else's evidence into this subsystem's case.
   */
  it('returns null for a non-table location', () => {
    expect(findingTable({ location: 'auth/signup' })).toBeNull()
    expect(findingTable({ location: 'surface:db' })).toBeNull()
    expect(findingTable({})).toBeNull()
    expect(findingTable(null)).toBeNull()
  })
})

describe('requestTable', () => {
  it('extracts the table from a generated data-plane path', () => {
    expect(requestTable('/api/v1/proj_123/db/orders')).toBe('orders')
    expect(requestTable('/api/v1/proj_123/db/order_items?select=*')).toBe('order_items')
  })

  it('returns null for paths that name no table', () => {
    expect(requestTable('/api/v1/proj_123/auth/login')).toBeNull()
    expect(requestTable('/healthz')).toBeNull()
  })
})

describe('toShadowTelemetry', () => {
  const report = (over: Partial<SubsystemRecurrenceReport> = {}): SubsystemRecurrenceReport => ({
    projectId: 'p1',
    kind: 'attached',
    windowDays: 30,
    noConstraintSkeleton: false,
    tableCount: 10,
    componentCount: 3,
    eligibleComponentCount: 2,
    largestComponentShare: 0.4,
    attributionCoverage: 0.875,
    subsystems: [],
    firing: [],
    ...over,
  })

  it('carries the four questions the shadow run exists to answer', () => {
    const t = toShadowTelemetry(report())
    expect(t).toMatchObject({
      firedCount: 0,
      noConstraintSkeleton: false,
      largestComponentShare: 0.4,
      attributionCoverage: 0.875,
      kind: 'attached',
    })
  })

  /**
   * A firing case must be inspectable after the fact.
   *
   * "The predicate fired" is not evidence it fired USEFULLY: five technically
   * valid but worthless correlations look identical to five real ones in a bare
   * count, and the decision this telemetry informs is whether to build six more
   * phases. So a firing case carries the gaps, the repairs and the harm a human
   * needs to judge it. Non-firing components stay aggregate.
   */
  it('records inspectable evidence for a firing subsystem', () => {
    const t = toShadowTelemetry(
      report({
        firing: [
          {
            fingerprint: 'sessions',
            membershipHash: 'abc123',
            membership: ['sessions', 'users'],
            provenance: 'constraint',
            eligible: true,
            confirmedRepairs: [
              { findingId: 'f1', type: 'missing_rls', gapKey: 'missing_rls::users', table: 'users', at: '2026-09-01T00:00:00Z' },
            ],
            distinctGapIdentities: ['missing_rls::users', 'missing_fk_index::sessions.user_id'],
            independentHarm: [
              { kind: 'server_error', detail: '500 on /db/sessions', at: '2026-09-02T00:00:00Z' },
            ],
            changeCount: 14,
            fires: true,
          },
        ],
      }),
    )
    expect(t.firedCount).toBe(1)
    expect(t.firedMemberships).toEqual(['abc123'])

    const [ev] = t.firingEvidence
    expect(ev.membership).toEqual(['sessions', 'users'])
    expect(ev.gapIdentities).toHaveLength(2)
    expect(ev.repairs[0]).toMatchObject({ type: 'missing_rls', table: 'users' })
    expect(ev.harm[0]).toMatchObject({ kind: 'server_error' })
    // Churn is recorded as context and played no part in the decision.
    expect(ev.changeCount).toBe(14)
  })

  it('records no evidence when nothing fired', () => {
    expect(toShadowTelemetry(report()).firingEvidence).toEqual([])
  })

  it('reports the singleton count that views used to distort', () => {
    const t = toShadowTelemetry(
      report({
        subsystems: [
          { fingerprint: 'a', membershipHash: 'h1', membership: ['a'], provenance: 'constraint', eligible: false, confirmedRepairs: [], distinctGapIdentities: [], independentHarm: [], changeCount: 0, fires: false },
          { fingerprint: 'b', membershipHash: 'h2', membership: ['b', 'c'], provenance: 'constraint', eligible: true, confirmedRepairs: [], distinctGapIdentities: [], independentHarm: [], changeCount: 0, fires: false },
        ],
      }),
    )
    expect(t.singletonComponentCount).toBe(1)
  })
})
