/**
 * THE COMPATIBILITY BRIDGE MUST NOT WIDEN SILENTLY
 * ================================================
 *
 * 16 finding types execute autonomously without a declared action class, because
 * freezing them would have regressed a working product and declaring 16
 * unverified safety contracts would have been worse. That is a deliberate,
 * bounded exception with a sunset.
 *
 * The way a bounded exception stops being bounded is that somebody adds a
 * finding type to `AUTO_SAFE`, it falls through to compatibility, and nobody
 * notices because everything still works. This suite is what makes that
 * impossible: a new auto-safe type must come with either a real ActionClass or
 * a deliberate edit to the allowlist, and either way somebody has to look at it.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  ACTION_CLASSES,
  AUTONOMOUSLY_REPAIRABLE_FINDING_TYPES,
  LEGACY_AUTONOMY_COMPAT_TYPES,
  actionClassForFindingType,
  authorityPathFor,
  registeredAndCompatOverlap,
} from '@/lib/authority/action-classes'

/**
 * The auto-safe set, read from the classifier's source.
 *
 * Parsed rather than imported because `AUTO_SAFE` is not exported, and because
 * reading the source is the point: this must notice a new literal appearing in
 * that set even if nothing else in the codebase references it yet.
 *
 * The end of the block matters. An earlier version of this parse ran past `])`
 * and swallowed the NEXT set — the approval-required safety floor — which made
 * the compatibility list appear to need 30 entries instead of 17 and put 14
 * human-gated types on a bridge that exists for automatic ones. They could not
 * actually reach it, because `classifyFix` returns them at the approval branch
 * first, but a list that wrong is a trap for whoever edits the classifier next.
 */
function autoSafeTypesFromSource(): string[] {
  const src = readFileSync(join(process.cwd(), 'lib/core/fix-classifier.ts'), 'utf8')
  const start = src.indexOf('const AUTO_SAFE = new Set<FindingType>([')
  if (start === -1) throw new Error('AUTO_SAFE not found — the classifier moved, fix this guard')
  const end = src.indexOf('])', start)
  const block = src.slice(start, end)
  return [...block.matchAll(/^\s*'([a-z_]+)',/gm)].map(m => m[1])
}

describe('every auto-safe finding type has a declared home', () => {
  it('is either a registered action class or an enumerated legacy type', () => {
    const unaccounted = autoSafeTypesFromSource().filter(
      t => !actionClassForFindingType(t) && !LEGACY_AUTONOMY_COMPAT_TYPES.has(t),
    )

    // If this fails you have added an auto-fixable finding type. Choose one:
    //
    //   1. declare a real ActionClass for it — a probe, a verifier that is not
    //      the executor, and a recovery contract; or
    //   2. add it to LEGACY_AUTONOMY_COMPAT_TYPES, which means shipping an
    //      autonomous mutation whose dependencies are undeclared.
    //
    // Option 2 is a decision, not a formality. It belongs in a diff somebody
    // reviews, which is why this guard exists rather than a fallthrough.
    expect(unaccounted).toEqual([])
  })

  it('the compatibility list contains nothing that is not auto-safe', () => {
    // The reverse leak: a stale entry here would keep a type on the bridge long
    // after it stopped being auto-fixable, and the sunset would never notice.
    const autoSafe = new Set(autoSafeTypesFromSource())
    const stale = [...LEGACY_AUTONOMY_COMPAT_TYPES].filter(t => !autoSafe.has(t))
    expect(stale).toEqual([])
  })
})

describe('the bridge and the gate do not overlap', () => {
  it('no registered action class can fall back to compatibility', () => {
    // A declared class that could degrade into the legacy path would make its
    // declaration decorative: the gate would be advisory for exactly the
    // actions whose safety was most carefully established.
    expect(registeredAndCompatOverlap()).toEqual([])
  })

  it('tighten_policy in particular never reaches compatibility', () => {
    // The action the whole ownership-intent slice exists for. If it could
    // degrade, Backenly would be back to rewriting authorization rules on its
    // own authority — the one unsafe mutation the Phase 0 baseline measured.
    expect(ACTION_CLASSES.tighten_policy.changesAuthorization).toBe(true)
    // rls_expression_invalid is the type detectOverPermissiveRls emits. The
    // first version checked 'rls_wide_open', which no probe produces, so this
    // assertion passed while the real type sat on the compatibility bridge.
    for (const t of ['rls_expression_invalid']) {
      expect(authorityPathFor(t)).toBe('authority')
      expect(LEGACY_AUTONOMY_COMPAT_TYPES.has(t)).toBe(false)
    }
  })

  it('every registered finding type routes to the authority path', () => {
    for (const t of AUTONOMOUSLY_REPAIRABLE_FINDING_TYPES) {
      expect(authorityPathFor(t)).toBe('authority')
    }
  })
})

describe('anything else freezes', () => {
  it('an unknown finding type is neither authorised nor bridged', () => {
    expect(authorityPathFor('something_nobody_declared')).toBe('freeze')
    expect(authorityPathFor('')).toBe('freeze')
  })

  it('the bridge is a fixed list, not a wildcard', () => {
    // A wildcard would mean the exception covers whatever arrives next, which
    // is how a temporary bridge becomes the architecture.
    expect(LEGACY_AUTONOMY_COMPAT_TYPES.size).toBe(16)
    expect(authorityPathFor('api_drift')).toBe('legacy_compatibility')
    expect(authorityPathFor('api_drift_v2')).toBe('freeze')
  })
})

describe('the debt is measurable', () => {
  it('reports how much of the auto-safe surface is still unmigrated', () => {
    const autoSafe = autoSafeTypesFromSource()
    const migrated = autoSafe.filter(t => actionClassForFindingType(t))
    const remaining = autoSafe.filter(t => LEGACY_AUTONOMY_COMPAT_TYPES.has(t))

    // Not a threshold, a statement of record: this is what the sunset has left
    // to do, and it should only ever go down.
    expect(migrated.length + remaining.length).toBe(autoSafe.length)
    expect(remaining.length).toBeLessThanOrEqual(16)
  })
})

describe('every registered class is reachable from the type its own sensor emits', () => {
  /**
   * The finding type each registered class's sensor ACTUALLY emits, as proven
   * by probe fixture tests and measured in the Phase 0 baseline.
   *
   * This link is what broke. An ActionClass names a sensor (an invariant id);
   * the live gate routes on the FINDING TYPE that sensor's probe emits. The two
   * were never checked against each other, so `tighten_policy` declared the
   * wide-open invariant as its sensor while being mapped from a type that
   * invariant never produces — and the real type went to the legacy bridge.
   *
   * Every entry here must be backed by a probe test that asserts the type, so
   * this table cannot drift into invention the way the original map did.
   */
  const EMITTED_BY_SENSOR: Record<string, string> = {
    user_data_is_rls_protected: 'missing_rls',
    relationships_are_indexed: 'missing_fk_index',
    relationships_have_fk_constraints: 'missing_fk',
    // Proven: tests/probes/security-probe-fixtures.spec.ts asserts this type.
    rls_policies_are_not_wide_open: 'rls_expression_invalid',
  }

  it('maps each class from the type its declared sensor emits', () => {
    for (const cls of Object.values(ACTION_CLASSES)) {
      const sensor = cls.requiredSensors[0].probeId
      const emitted = EMITTED_BY_SENSOR[sensor]
      // A class whose sensor is missing from the table has an unverified link.
      expect(emitted).toBeDefined()
      expect(actionClassForFindingType(emitted)?.id).toBe(cls.id)
      // And that type must reach the Authority Decision, never the bridge.
      expect(authorityPathFor(emitted)).toBe('authority')
    }
  })

  it('no class sensor type is left on the compatibility bridge', () => {
    for (const t of Object.values(EMITTED_BY_SENSOR)) {
      expect(LEGACY_AUTONOMY_COMPAT_TYPES.has(t)).toBe(false)
    }
  })
})
