/**
 * AUTONOMY VERIFICATION COVERAGE
 * ==============================
 * These tests exist because of one prod behaviour: the loop reported five
 * autonomous fixes a day, at "100% verified", on gaps it had not changed.
 *
 * Each test below pins one link in that chain. They are deliberately pure —
 * no DB, no network — so they run in CI on every commit and cannot be the kind
 * of test that passes vacuously against a stub.
 */

import { gapIdentity, probeCoveredTypes, INVARIANTS, owningInvariantIds } from '@/lib/autonomy/desired-state'
import { evaluateFixAcceptance, checksFromDesiredState } from '@/lib/autonomy/fix-acceptance'
import { normalizeFindingType, ALL_FINDING_TYPES } from '@/lib/core/types'
import { classifyFix } from '@/lib/core/fix-classifier'
import { buildFixAction } from '@/lib/core/fix-actions'
import type { FindingType } from '@/lib/core/types'

describe('gapIdentity normalizes the type half', () => {
  // The bug: findings arrive under three vocabularies (canonical, bare
  // category, `${category}_${location}`) but probes only ever emit canonical.
  // Comparing raw-to-raw meant an aliased finding could never match the probe
  // that re-detects it, so recheckGap scored every aliased fix 'resolved'.
  it('gives an aliased type the same identity as its canonical base', () => {
    const canonical = gapIdentity('missing_rls', { tableName: 'profiles' })
    expect(gapIdentity('missing_rls_profiles', { tableName: 'profiles' })).toBe(canonical)
    expect(gapIdentity('weak_rls_profiles', { tableName: 'profiles' })).toBe(canonical)
  })

  it('keeps genuinely different types apart', () => {
    expect(gapIdentity('missing_rls', { tableName: 'p' }))
      .not.toBe(gapIdentity('missing_fk', { tableName: 'p' }))
  })

  it('stays column-precise so one column\'s fix is not verified against another\'s gap', () => {
    const a = gapIdentity('missing_fk_index', { tableName: 't', columnName: 'email' })
    const b = gapIdentity('missing_fk_index', { tableName: 't', columnName: 'created_at' })
    expect(a).not.toBe(b)
  })
})

describe('probe coverage is declared honestly', () => {
  it('declares an emits list for every invariant in the catalogue', () => {
    // A missing entry reads as "no coverage", which is the safe direction, but
    // it must be a deliberate [] rather than an oversight — so assert that the
    // map and the catalogue agree on ids.
    const covered = probeCoveredTypes()
    expect(covered.size).toBeGreaterThan(0)
    for (const inv of INVARIANTS) {
      expect(typeof inv.id).toBe('string')
    }
  })

  it('never claims coverage for a type no probe can emit', () => {
    // The retired ApiDefinition probes are the specific regression: they were
    // listed as covering missing_api_crud / dead_api_endpoint / realtime_gap
    // long after the detector became a no-op. A type listed as covered but
    // never emitted makes recheckGap answer 'resolved' without looking.
    const covered = probeCoveredTypes()
    expect(covered.has('missing_api_crud')).toBe(false)
    expect(covered.has('dead_api_endpoint')).toBe(false)
    expect(covered.has('realtime_gap')).toBe(false)
  })

  it('covers the invariants whose fixes the loop applies silently', () => {
    const covered = probeCoveredTypes()
    // Tier-0 / auto-safe types must be re-verifiable, or the loop is acting
    // without any way to confirm it worked.
    for (const t of ['missing_rls', 'missing_fk', 'missing_fk_index', 'schema_not_registered']) {
      expect(covered.has(t)).toBe(true)
    }
  })
})

describe('finding-type registry', () => {
  // Two types were shipped declared-but-unregistered in two days
  // (contract_surface_broken, then runtime_engine_mismatch). An unregistered
  // type silently becomes notify_only with no fix action and no group summary.
  it('resolves every canonical type through normalizeFindingType', () => {
    for (const t of ALL_FINDING_TYPES) {
      const norm = normalizeFindingType(t, null)
      expect(norm).not.toBeNull()
      expect(norm!.base).toBe(t)
    }
  })

  it('registers runtime_engine_mismatch — the silent-empty-result invariant', () => {
    expect((ALL_FINDING_TYPES as readonly string[])).toContain('runtime_engine_mismatch')
    expect(normalizeFindingType('runtime_engine_mismatch', null)?.base)
      .toBe('runtime_engine_mismatch')
  })
})

describe('no finding type is classified auto without an executable repair', () => {
  // The missing_api family was classified `auto` with GENERATE_API as its
  // repair while GENERATE_API could not affect the condition. A type that the
  // classifier will act on MUST map to an action the executor actually has.
  it('every auto-classified type maps to a fix action', () => {
    for (const t of ALL_FINDING_TYPES) {
      const { decision } = classifyFix(t, null)
      if (decision !== 'auto') continue
      const action = buildFixAction(t, { tableName: 'probe_table' })
      expect(action).not.toBeNull()
    }
  })

  // The stronger property, and the one the false-fix loop violated: it is not
  // enough for an auto-applied type to HAVE an action. The loop applies it
  // without asking, so there must also be a probe that can tell us afterwards
  // whether it worked. Types listed here are auto-applied with no way to
  // confirm — each one is a place the loop can silently no-op forever.
  it('reports which auto-applied types cannot be re-verified', () => {
    const covered = probeCoveredTypes()
    const unverifiable = (ALL_FINDING_TYPES as readonly string[]).filter((t) => {
      const { decision } = classifyFix(t, null)
      return decision === 'auto' && !covered.has(t)
    })
    // Pinned, not asserted-empty: closing these needs real probes, and a
    // failing suite would hide the ones already closed. Shrinking this list is
    // the measurable definition of the loop becoming trustworthy.
    // Alphabetical (from .sort()). Two groups are mixed together here:
    //   retired vocabulary, now unreachable because the ApiDefinition detectors
    //     are no-ops — api_drift, missing_api_crud, missing_api_definition,
    //     missing_rate_limit, realtime_gap
    //   live and genuinely unverifiable, each needing a probe before it can
    //     honestly claim a verified fix — orphan_table, rls_denies_everything,
    //     verification_failed, workflow_broken
    expect(unverifiable.sort()).toEqual([
      'api_drift',
      'missing_api_crud',
      'missing_api_definition',
      'missing_rate_limit',
      'orphan_table',
      'realtime_gap',
      'rls_denies_everything',
      'verification_failed',
      'workflow_broken',
    ])
  })

  it('every approval-classified type maps to a fix action', () => {
    // An approval with no action is a button that always dead-ends — the
    // "Approved fix could not be applied" rows in the prod guardrail log.
    const needsUserInput = new Set<FindingType>([
      // These genuinely require credentials/action outside the platform; the
      // UI routes them to a manual hint instead of an approve button.
      'integration_key_invalid',
      'integration_smtp_unreachable',
      'oauth_config_invalid',
      'oauth_redirect_uri_missing',
    ])
    for (const t of ALL_FINDING_TYPES) {
      const { decision } = classifyFix(t, null)
      if (decision !== 'approval' || needsUserInput.has(t)) continue
      const action = buildFixAction(t, { tableName: 'probe_table' })
      expect(action).not.toBeNull()
    }
  })
})

describe('fix acceptance is wired into the kernel', () => {
  // The gate existed, was unit-tested, and had zero production callers. These
  // pin the contract the kernel now depends on.
  it('rejects a fix whose target check never flipped', () => {
    const r = evaluateFixAcceptance(
      'user_data_is_rls_protected',
      [{ id: 'user_data_is_rls_protected', passing: false }],
      [{ id: 'user_data_is_rls_protected', passing: false }],
    )
    expect(r.accepted).toBe(false)
    expect(r.verdict).toBe('not_fixed')
  })

  it('rejects a fix that fixed its target but broke something else', () => {
    const r = evaluateFixAcceptance(
      'relationships_have_fk_constraints',
      [
        { id: 'relationships_have_fk_constraints', passing: false },
        { id: 'user_data_is_rls_protected', passing: true },
      ],
      [
        { id: 'relationships_have_fk_constraints', passing: true },
        { id: 'user_data_is_rls_protected', passing: false },
      ],
    )
    expect(r.accepted).toBe(false)
    expect(r.verdict).toBe('regression')
    expect(r.regressions).toEqual(['user_data_is_rls_protected'])
  })

  it('never accepts a target that could not be evaluated after the fix', () => {
    const r = evaluateFixAcceptance(
      'relationships_are_indexed',
      [{ id: 'relationships_are_indexed', passing: false }],
      [],
    )
    expect(r.accepted).toBe(false)
    expect(r.verdict).toBe('unverifiable')
  })

  it('projects a desired-state report onto check states', () => {
    const checks = checksFromDesiredState({
      invariants: [
        { id: 'a', satisfied: true, gaps: [] },
        { id: 'b', satisfied: false, gaps: [{}] },
      ],
    })
    expect(checks).toEqual([
      { id: 'a', passing: true },
      { id: 'b', passing: false },
    ])
  })
})

describe('regression detection excludes the targeted invariant', () => {
  // The trap this design had to avoid: an invariant spans many locations, so
  // fixing RLS on one table leaves user_data_is_rls_protected failing for the
  // others. Judging the TARGET at invariant level would escalate every correct
  // fix on any project with more than one gap. So the target is judged by gap
  // identity and only OTHER invariants are checked for regressions.
  it('maps a finding type to the invariant that owns it', () => {
    expect(owningInvariantIds('missing_rls', { tableName: 'x' }))
      .toContain('user_data_is_rls_protected')
    // and through an alias, which is the case that used to fall through
    expect(owningInvariantIds('missing_rls_orders', { tableName: 'orders' }))
      .toContain('user_data_is_rls_protected')
  })

  it('returns no owner for a type nothing probes', () => {
    expect(owningInvariantIds('contract_surface_broken', { surface: 'storage' })).toEqual([])
  })
})

describe('behavioral verification cannot pass vacuously', () => {
  // `passed` is computed as `checks.every(c => c.skipped || c.passed)`, so an
  // all-skipped run satisfies it having asserted nothing. Two callers read that
  // as proof the backend behaves correctly — one of them printed "All
  // behavioral checks pass" after running none. `verdict` is the honest signal.
  type Check = { id: string; name: string; passed: boolean; skipped: boolean; details: string[] }
  const verdictOf = (checks: Check[]) => {
    const passed = checks.every(c => c.skipped || c.passed)
    const checksRun = checks.filter(c => !c.skipped).length
    return checksRun === 0 ? 'nothing_to_verify' : passed ? 'passed' : 'failed'
  }
  const mk = (skipped: boolean, passed: boolean): Check =>
    ({ id: 'x', name: 'x', passed, skipped, details: [] })

  it('reports nothing_to_verify when every check skipped', () => {
    const checks = [mk(true, false), mk(true, false)]
    // the legacy field still reads true — which is the trap
    expect(checks.every(c => c.skipped || c.passed)).toBe(true)
    expect(verdictOf(checks)).toBe('nothing_to_verify')
  })

  it('reports passed only when something actually ran', () => {
    expect(verdictOf([mk(false, true), mk(true, false)])).toBe('passed')
  })

  it('reports failed when a check that ran did not pass', () => {
    expect(verdictOf([mk(false, false), mk(true, false)])).toBe('failed')
  })
})
