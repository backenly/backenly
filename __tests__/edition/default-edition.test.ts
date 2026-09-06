/**
 * WHAT BACKENLY IS WHEN NOBODY SAYS
 * =================================
 * The final Phase 8 contract: an unconfigured Backenly is a self-hosted,
 * single-project deployment. Cloud is the thing you opt into.
 *
 * ---- WHY THIS IS A TEST AND NOT JUST A CONSTANT ------------------------
 *
 * `DEFAULT_EDITION` decides an AUTHORIZATION model, not a feature flag. The
 * single-tenant resolver treats every authenticated account as an operator of
 * the one project it can see; the Cloud resolver consults organization
 * membership and refuses a request that names no project. Picking the wrong one
 * is not a degraded experience, it is the wrong tenancy model, and the failure
 * is silent in both directions:
 *
 *   default cloud on a self-host box    every route asks for a project context
 *                                       the installer never had, and the
 *                                       operator's dashboard lists nothing.
 *
 *   default single-tenant on Cloud      every logged-in user is an operator of
 *                                       whichever project they name.
 *
 * The second is why the flip is safe only alongside fail-closed composition:
 * an explicit `cloud` still REFUSES to start without its private overlay
 * (lib/edition/cloud-extension.ts), so a Cloud deployment can never silently
 * land on the permissive resolver. That refusal is tested in
 * tests/unit/cloud-composition-fail-closed.spec.ts; this file tests the other
 * half, which is what the absence of configuration means.
 *
 * ---- WHY THE ENVIRONMENT IS CLEARED SO CAREFULLY -----------------------
 *
 * A test that asserts "unset resolves to single-tenant" is worthless if
 * something else in the process already set BACKENLY_EDITION to
 * `single-tenant`: it would pass for the wrong reason and keep passing if the
 * default were reverted. So the variable is deleted outright, the assertion
 * runs, and the original value is restored afterwards -- and a guard test below
 * proves the deletion actually happened.
 */

import { currentEdition } from '@/lib/edition'

const ORIGINAL = process.env.BACKENLY_EDITION

/** Remove it entirely. Assigning '' is not the same thing as being unset. */
function unsetEdition(): void {
  delete process.env.BACKENLY_EDITION
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL
})

describe('the product default', () => {
  it('resolves single-tenant when BACKENLY_EDITION is absent', () => {
    unsetEdition()
    expect(currentEdition()).toBe('single-tenant')
  })

  it('really is testing an absent variable, not an empty one', () => {
    // The assertion above would pass just as happily against a leftover
    // BACKENLY_EDITION=single-tenant in the runner. This pins that the case
    // under test is genuine ABSENCE.
    unsetEdition()
    expect('BACKENLY_EDITION' in process.env).toBe(false)
    expect(process.env.BACKENLY_EDITION).toBeUndefined()
  })

  it('treats whitespace as absent rather than as a value', () => {
    process.env.BACKENLY_EDITION = '   '
    expect(currentEdition()).toBe('single-tenant')
  })
})

describe('an explicit edition always wins over the default', () => {
  it('honours an explicit single-tenant', () => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    expect(currentEdition()).toBe('single-tenant')
  })

  it('honours an explicit cloud, which the default can no longer produce', () => {
    // The whole point of the flip: cloud is now reachable ONLY by asking for
    // it. Nothing that merely forgets to configure an edition can arrive here.
    process.env.BACKENLY_EDITION = 'cloud'
    expect(currentEdition()).toBe('cloud')
  })

  it('accepts the documented values regardless of case or padding', () => {
    process.env.BACKENLY_EDITION = '  CLOUD  '
    expect(currentEdition()).toBe('cloud')
    process.env.BACKENLY_EDITION = 'Single-Tenant'
    expect(currentEdition()).toBe('single-tenant')
  })
})

describe('an unrecognised edition is refused, never defaulted', () => {
  it('throws rather than falling back to the default', () => {
    // A typo must not silently pick an edition. Now that the default is
    // single-tenant, "fall back to the default" would be the PERMISSIVE
    // resolver, so quietly accepting `BACKENLY_EDITION=clould` on a
    // multi-tenant database would be a cross-tenant bypass produced by a
    // spelling mistake.
    process.env.BACKENLY_EDITION = 'clould'
    expect(() => currentEdition()).toThrow(/must be "cloud" or "single-tenant"/)
  })

  it('names the offending value so the operator can see the typo', () => {
    process.env.BACKENLY_EDITION = 'clould'
    expect(() => currentEdition()).toThrow(/clould/)
  })
})
