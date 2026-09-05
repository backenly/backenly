/**
 * The PlatformSignals seam: what the product reports, and what it must not do
 * with the answer.
 *
 * Three signup flows used to call applyReferralOnSignup from lib/billing/referral
 * directly, so public product code carried Backenly's growth machinery. They now
 * report the signup and stop caring what happens next.
 *
 * Two properties matter and neither is "referral works":
 *
 *   1. single-tenant reacts to nothing, and does not consult the Cloud provider
 *      to find that out. A self-hosted install has no referral programme, no
 *      growth metrics and nobody to attribute anything to.
 *   2. the seam absorbs its own failures. Every caller is past the point where
 *      the account exists, so a business reaction that throws must not turn a
 *      successful registration into a 500.
 */
const mockOnSignupCompleted = jest.fn()
jest.mock('@cloud/platform-signals', () => ({
  onSignupCompleted: (...a: unknown[]) => mockOnSignupCompleted(...a),
}))

import { onSignupCompleted } from '@/lib/platform-signals'
import type { SignupCompleted } from '@/lib/platform-signals'

const SIGNUP: SignupCompleted = {
  userId: 'user-1',
  email: 'someone@example.com',
  provider: 'email',
  referralCode: 'ABC123',
}

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

afterEach(() => {
  process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  jest.clearAllMocks()
})

describe('single-tenant', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'single-tenant'
  })

  it('reacts to nothing and never consults the Cloud provider', async () => {
    await onSignupCompleted(SIGNUP)
    expect(mockOnSignupCompleted).not.toHaveBeenCalled()
  })

  it('does not react even when a referral code is present', async () => {
    // A self-hoster pasting a Backenly referral link into their own install
    // must not cause their install to try to attribute anything.
    await onSignupCompleted({ ...SIGNUP, referralCode: 'REALCODE' })
    expect(mockOnSignupCompleted).not.toHaveBeenCalled()
  })
})

describe('cloud', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
  })

  it('hands the signal to the Cloud provider unchanged', async () => {
    mockOnSignupCompleted.mockResolvedValue(undefined)

    await onSignupCompleted(SIGNUP)

    // The raw code is passed through. What counts as a valid referral code is
    // a business rule, so the product must not normalise or pre-filter it.
    expect(mockOnSignupCompleted).toHaveBeenCalledWith(SIGNUP)
  })

  it('swallows a provider failure rather than failing the signup', async () => {
    mockOnSignupCompleted.mockRejectedValue(new Error('referral service down'))

    // The account already exists by the time this is called. If this rejects,
    // the caller's signup handler returns 500 for an account it just created.
    await expect(onSignupCompleted(SIGNUP)).resolves.toBeUndefined()
  })
})

describe('the signup flows report rather than implement', () => {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const ROOT = process.cwd()

  const FLOWS = [
    'app/api/auth/register/route.ts',
    'app/api/auth/platform-github/callback/route.ts',
    'app/api/auth/platform-google/callback/route.ts',
  ]

  it.each(FLOWS)('%s calls the seam and not the referral implementation', (file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8')

    // This is the mutation guard. Restoring the direct import still compiles
    // and still works in Cloud, and would silently put growth machinery back
    // into a public signup handler.
    expect(src).not.toMatch(/lib\/billing\/referral/)
    expect(src).toMatch(/onSignupCompleted\(/)
  })
})
