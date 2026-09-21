/**
 * "VERIFIED" IS AN ALLOW LIST, AND ONLY EVER AN ALLOW LIST
 * ========================================================
 *
 * The fail-open bug had two halves. One was the producer recording success
 * when the verifier threw. The other is structural and outlives any single
 * fix: as long as anywhere in the codebase asks the question negatively —
 * `verification !== 'failed'`, `!outcome?.error`, `outcome == null ? ok : ...`
 * — then every value the author did not think of passes.
 *
 * That is not hypothetical here. `rollbackData.verification` is read off JSON
 * with no runtime type, from rows written by older versions of this code, and
 * a fourth state was added the day this file was written. A deny list would
 * have silently counted the new state as a verified repair.
 *
 * So there is one predicate, it is positive, and these tests pin exactly that:
 * one string means verified and everything else in the universe does not.
 */

import {
  isVerifiedFix,
  isVerificationError,
  describeVerification,
  type FixVerification,
} from '@/lib/core/fix-verification'

/**
 * Everything a JSON column can hand back, including the shapes that caused the
 * original bug: a missing field, an errored probe, and a value from a version
 * of the code that does not exist yet.
 */
const NOT_VERIFIED: unknown[] = [
  undefined,
  null,
  '',
  'unverified',
  'verification_error',
  'failed',
  'unresolved',
  'unknown',
  'CONFIRMED', // case matters; a near-miss is a miss
  ' confirmed',
  'confirmed ',
  true,
  1,
  0,
  {},
  [],
  { verification: 'confirmed' }, // the wrapper, not the value
  'a_state_invented_next_quarter',
]

describe('isVerifiedFix is positive', () => {
  it('accepts exactly one value', () => {
    expect(isVerifiedFix('confirmed')).toBe(true)
  })

  it.each(NOT_VERIFIED.map(v => [JSON.stringify(v) ?? String(v), v] as const))(
    'rejects %s',
    (_label, value) => {
      expect(isVerifiedFix(value)).toBe(false)
    },
  )

  it('rejects a state added in the future without anyone editing this file', () => {
    // The property that makes it an allow list rather than a deny list. If the
    // vocabulary grows, the new member is not verified until somebody decides
    // it is, which is the safe default.
    const future = 'verified_by_some_new_mechanism' as unknown as FixVerification
    expect(isVerifiedFix(future)).toBe(false)
  })
})

describe('isVerificationError distinguishes cannot-verify from not-verified', () => {
  it('is true only for the error state', () => {
    expect(isVerificationError('verification_error')).toBe(true)
  })

  it('is false for the honest no-probe-exists case', () => {
    // These are different realities and the product says different things
    // about them. `unverified` means "nothing in the platform can check this
    // type"; `verification_error` means "the check broke".
    expect(isVerificationError('unverified')).toBe(false)
    expect(isVerificationError('confirmed')).toBe(false)
    expect(isVerificationError(undefined)).toBe(false)
  })

  it('never overlaps with isVerifiedFix', () => {
    for (const v of ['confirmed', 'unverified', 'verification_error', undefined, null]) {
      expect(isVerifiedFix(v) && isVerificationError(v)).toBe(false)
    }
  })
})

describe('every state says something different to a human', () => {
  it('does not describe an unverifiable fix the same way as an unchecked one', () => {
    const confirmed = describeVerification('confirmed')
    const unverified = describeVerification('unverified')
    const errored = describeVerification('verification_error')

    expect(new Set([confirmed, unverified, errored]).size).toBe(3)
    // The one that matters: a broken check must not read as a routine
    // "we don't check this type", because a user acts differently on each.
    expect(errored).toMatch(/could not run/)
    expect(confirmed).toMatch(/confirmed/)
  })

  it('falls back to the cautious wording for anything unrecognised', () => {
    expect(describeVerification('something_new')).toBe(describeVerification('unverified'))
    expect(describeVerification(undefined)).toBe(describeVerification('unverified'))
  })
})

// ── Every producer, not just the one that was reported ──────────────────────

describe('no caller of the acceptance probe can swallow its failure again', () => {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const ROOT = path.resolve(__dirname, '..', '..')
  const engine = fs.readFileSync(path.join(ROOT, 'lib/core/auto-fix-engine.ts'), 'utf8')

  it('has exactly the two call sites this fix covers', () => {
    // A third producer added later would not inherit the three-state handling,
    // and the bug would come back in a file nobody re-read. If this count
    // changes, the new call site needs the same treatment.
    const calls = [...engine.matchAll(/await evaluateFixOutcome\(/g)]
    expect(calls.length).toBe(2)
  })

  it('never discards the error with a bare catch', () => {
    // The original shape, exactly: `.catch(() => null)` attached to the probe
    // call, which turned a thrown verifier into a skipped guard.
    //
    // Scoped to the call itself rather than to the rest of the file. There are
    // legitimate `.catch(() => null)` sites in this module — capturing a
    // post-fix snapshot, for one, where "no snapshot" really is a usable
    // answer — and a rule broad enough to catch those would be noise.
    for (const m of engine.matchAll(/await evaluateFixOutcome\([\s\S]{0,200}/g)) {
      expect(m[0]).not.toMatch(/\.catch\(\(\)\s*=>\s*null\)/)
    }
  })

  it('captures the verifier error at both call sites', () => {
    const captures = [...engine.matchAll(/verifierError = err instanceof Error/g)]
    expect(captures.length).toBe(2)
  })

  it('branches on the captured error before reading the outcome', () => {
    // Ordering is the property. Checking `outcome` first and the error second
    // would re-open the hole for the null case.
    const branches = [...engine.matchAll(/if \(verifierError !== null\)/g)]
    expect(branches.length).toBe(2)
  })
})
