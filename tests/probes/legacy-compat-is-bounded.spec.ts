/**
 * THE COMPATIBILITY BRIDGE MUST NOT WIDEN SILENTLY
 * ================================================
 *
 * 17 finding types execute autonomously without a declared action class, because
 * freezing them would have regressed a working product and declaring 17
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
    for (const t of ['rls_wide_open', 'policy_fragmentation']) {
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
    expect(LEGACY_AUTONOMY_COMPAT_TYPES.size).toBe(17)
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
    expect(remaining.length).toBeLessThanOrEqual(17)
  })
})
