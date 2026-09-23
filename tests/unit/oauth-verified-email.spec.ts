/**
 * An OAuth sign-in may only treat an address as proven when the provider says
 * it verified it.
 *
 * This is the same proof email signup now demands a mailed code for, and it is
 * load-bearing in a way that is easy to miss: the callbacks LINK BY ADDRESS, so
 * an unverified address that reached this far would not just make a new
 * account, it would sign the caller into whichever account already held that
 * address.
 *
 * Both halves are asserted throughout: what is accepted, and what is refused.
 * A refusal-only suite passes when nothing works at all.
 */
import { githubVerifiedEmail, googleVerifiedEmail } from '@/lib/auth/oauth/verified-email'

describe('Google', () => {
  it('accepts a verified address from either userinfo shape', () => {
    // /oauth2/v2/userinfo says verified_email; OIDC says email_verified.
    expect(googleVerifiedEmail({ email: 'Ada@Example.com', verified_email: true })).toBe('ada@example.com')
    expect(googleVerifiedEmail({ email: 'ada@example.com', email_verified: true })).toBe('ada@example.com')
    // Some providers send the flag as a string.
    expect(googleVerifiedEmail({ email: 'ada@example.com', verified_email: 'true' })).toBe('ada@example.com')
  })

  it('refuses an unverified address, which the callback used to accept', () => {
    expect(googleVerifiedEmail({ email: 'ada@example.com', verified_email: false })).toBeNull()
    expect(googleVerifiedEmail({ email: 'ada@example.com', email_verified: false })).toBeNull()
  })

  it('refuses when the flag is simply absent', () => {
    // The exact shape the old code accepted: an email field and nothing else.
    expect(googleVerifiedEmail({ email: 'ada@example.com' })).toBeNull()
  })

  it('refuses junk rather than inventing an address', () => {
    expect(googleVerifiedEmail({ verified_email: true })).toBeNull()
    expect(googleVerifiedEmail({ email: 'not-an-address', verified_email: true })).toBeNull()
    expect(googleVerifiedEmail(null)).toBeNull()
    expect(googleVerifiedEmail(undefined)).toBeNull()
  })
})

describe('GitHub', () => {
  it('prefers the verified primary address', () => {
    expect(
      githubVerifiedEmail([
        { email: 'other@example.com', primary: false, verified: true },
        { email: 'Ada@Example.com', primary: true, verified: true },
      ]),
    ).toBe('ada@example.com')
  })

  it('falls back to another verified address when the primary is not verified', () => {
    expect(
      githubVerifiedEmail([
        { email: 'unverified@example.com', primary: true, verified: false },
        { email: 'proven@example.com', primary: false, verified: true },
      ]),
    ).toBe('proven@example.com')
  })

  it('refuses when nothing in the list is verified', () => {
    // What `emails[0]` used to return, unchecked.
    expect(
      githubVerifiedEmail([
        { email: 'first@example.com', primary: true, verified: false },
        { email: 'second@example.com', primary: false, verified: false },
      ]),
    ).toBeNull()
  })

  it('refuses an empty or missing list rather than falling back to the profile', () => {
    expect(githubVerifiedEmail([])).toBeNull()
    expect(githubVerifiedEmail(null)).toBeNull()
    expect(githubVerifiedEmail({ email: 'ada@example.com' })).toBeNull()
  })
})

describe('the callbacks use it', () => {
  // A mutation guard. Re-reading the provider's raw email field still
  // compiles and still works for the happy path, and would silently put the
  // takeover back.
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')

  it.each([
    ['app/api/auth/platform-google/callback/route.ts', 'googleVerifiedEmail'],
    ['app/api/auth/platform-github/callback/route.ts', 'githubVerifiedEmail'],
    ['app/api/auth/google/callback/route.ts', 'googleVerifiedEmail'],
    ['app/api/auth/github/callback/route.ts', 'githubVerifiedEmail'],
  ])('%s resolves its address through %s', (file, helper) => {
    const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    expect(src).toContain(`${helper}(`)
    expect(src).toMatch(/emailVerified: true/)
    // The address must come from the helper, not from the provider payload.
    expect(src).not.toMatch(/const email = String\((googleUser|githubUser)/)
    expect(src).not.toMatch(/email = githubUser\.email/)
  })
})

describe('an OAuth sign-in cannot claim a self-hosted deployment', () => {
  // OAuth carries no setup token, so every callback must ask before it creates
  // an account, and must ask BEFORE the create rather than somewhere after it.
  // The decision itself is asserted against an empty database in
  // __tests__/auth/oauth-claim-gate.test.ts; this pins that it is consulted.
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')

  it.each([
    'app/api/auth/platform-google/callback/route.ts',
    'app/api/auth/platform-github/callback/route.ts',
    'app/api/auth/google/callback/route.ts',
    'app/api/auth/github/callback/route.ts',
  ])('%s checks oauthMayCreateAccount before it creates a user', (file) => {
    const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    const gate = src.indexOf('oauthMayCreateAccount()')
    const create = src.indexOf('prisma.user.create(')
    expect(gate).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(create)
    // Exactly one create per callback, so "before the create" means all of them.
    expect(src.indexOf('prisma.user.create(', create + 1)).toBe(-1)
  })
})
