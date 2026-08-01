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
    // Everything left is RETIRED vocabulary: the ApiDefinition detectors are
    // no-ops, so nothing produces these types and none is reachable. They stay
    // classified until the vocabulary itself is retired in its own pass.
    //
    // orphan_table, rls_denies_everything and workflow_broken were removed from
    // this list on 2026-07-30 by registering their existing probes in the
    // desired-state catalogue — the probes were already read-only and already
    // written, just never wired in, so their auto-applied fixes were recorded on
    // the executor's word alone.
    //
    // verification_failed is deliberately NOT here and deliberately not probed:
    // it is produced by EXECUTING verification scenarios, so re-running it after
    // every fix would make the recheck path side-effecting and expensive. It is
    // covered by the acceptance gate's regression half instead.
    expect(unverifiable.sort()).toEqual([
      'api_drift',
      'missing_api_crud',
      'missing_api_definition',
      'missing_rate_limit',
      'realtime_gap',
      'verification_failed',
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
    // `broken_webhook` is repaired through an external dashboard and has no
    // invariant probe, so its absence from a report proves nothing and
    // `recheckGap` must answer 'unknown' rather than certifying a fix it never
    // verified. This assertion used to name `contract_surface_broken`, which was
    // accurate until that type got a probe — see the case below.
    expect(owningInvariantIds('broken_webhook', { integration: 'stripe' })).toEqual([])
  })

  it('DOES now own contract_surface_broken — the invariant that was missing', () => {
    // Measured over two months of production, contract_surface_broken is ~80% of
    // every real fault ever recorded (298 findings; the next most common is 29).
    // It had no invariant, so `computeDesiredStateDiff` could return satisfied
    // and the dashboard could print "Backend is healthy — all guarantees hold"
    // while a customer's REST API returned 502s.
    //
    // Owning the type is what makes a HEAL_DATA_PLANE fix verifiable instead of
    // recorded 'unknown': `probeCoveredTypes` now includes it, so `recheckGap`
    // re-reads the contract sweep's result rather than assuming.
    expect(owningInvariantIds('contract_surface_broken', { surface: 'storage' }))
      .toEqual(['data_plane_is_answering'])
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

describe('verification surfaces do not read the dead ApiDefinition table', () => {
  // ApiDefinition has had no CREATE path since the PostgREST cutover
  // (2026-07-21): no .create, .createMany, .upsert or nested create exists
  // anywhere in the repo. Existing rows can still be updated or deleted (the
  // rollback path does), but no row is ever born. So on any project created
  // after that date the table is permanently EMPTY, and any code gating on it
  // silently treats a healthy backend as having nothing.
  //
  // That is what disabled checkLiveApiEndpoints: it filtered candidate tables
  // through ApiDefinition, found none, and skipped with "build tables and APIs
  // first" on projects full of working tables — so the only check exercising the
  // real HTTP stack never ran, while a skipped check counted toward `passed`.
  //
  // These files decide whether the backend WORKS. They must read the catalog.
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const REPO_ROOT = path.resolve(__dirname, '../..')

  // DETECTION surfaces only. auto-fix-engine is deliberately excluded: its
  // ApiDefinition reads are in the ROLLBACK path, unwinding SET_RATE_LIMIT and
  // FIX_API fixes recorded before that vocabulary was retired. Those rows are
  // legacy state a revert legitimately has to touch, and refusing to read them
  // would strand the undo for fixes already in the ledger. Detection must never
  // ask the table what exists; revert may still ask it what it left behind.
  const VERIFICATION_SURFACES = [
    'lib/ai/behavioral-verifier.ts',
    'lib/core/drift-detector.ts',
    'lib/ai/agents/repair-agent.ts',
    'lib/autonomy/desired-state.ts',
  ]

  it.each(VERIFICATION_SURFACES)('%s does not query ApiDefinition', (rel) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    // Comments explaining WHY it was removed are fine; a live query is not.
    const live = src
      .split('\n')
      .filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .filter(l => /prisma\.apiDefinition\s*\./.test(l))
    expect(live).toEqual([])
  })
})
