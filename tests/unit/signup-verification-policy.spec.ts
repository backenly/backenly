/**
 * Every branch of "must this signup prove its email first", pinned.
 *
 * The rule lives in one pure function so that each edition's answer is asserted
 * here directly, rather than only by a route test that happens to reach it.
 * The self-hosted first account is the one worth reading twice: it is the only
 * account anywhere that is admitted without proving its address, so what it
 * rests on matters.
 */
import { signupVerificationPolicy } from '@/lib/auth/signup/policy'

const SELF_HOST = { edition: 'single-tenant' as const, isFirstAccount: true }

describe('the self-hosted first account', () => {
  it('skips the code when the setup token gated the claim', () => {
    // Possession of the machine is the proof, and a fresh install usually has
    // no SMTP. Demanding a code here would lock the operator out of their box.
    expect(signupVerificationPolicy({ ...SELF_HOST, claimGatedBySetupToken: true, mailConfigured: false })).toBe('skip')
    expect(signupVerificationPolicy({ ...SELF_HOST, claimGatedBySetupToken: true, mailConfigured: true })).toBe('skip')
  })

  it('does NOT skip merely because the users table is empty', () => {
    // The defect this guards: a deployment is often reachable before its
    // operator gets to it - an open port on a VPS, a preview environment - so
    // "nobody has signed up yet" must not hand the single administrator slot
    // to whoever loads the page first. With no token, the address is proven by
    // mail instead.
    expect(signupVerificationPolicy({ ...SELF_HOST, claimGatedBySetupToken: false, mailConfigured: true })).toBe('require')
  })

  it('refuses when neither a token nor mail can prove anything', () => {
    expect(signupVerificationPolicy({ ...SELF_HOST, claimGatedBySetupToken: false, mailConfigured: false }))
      .toBe('refuse_unprotected_claim')
  })
})

describe('every other account', () => {
  it('requires a code for later self-hosted accounts', () => {
    expect(signupVerificationPolicy({
      edition: 'single-tenant', isFirstAccount: false, claimGatedBySetupToken: true, mailConfigured: true,
    })).toBe('require')
  })

  it('refuses a later self-hosted account when the server cannot send the code', () => {
    // Not waved through unverified: the operator opened registration to
    // strangers, and a stranger's address is exactly what must be proven.
    expect(signupVerificationPolicy({
      edition: 'single-tenant', isFirstAccount: false, claimGatedBySetupToken: true, mailConfigured: false,
    })).toBe('refuse_no_mail')
  })

  it('always requires a code on Cloud, token or no token, first-looking or not', () => {
    // Cloud has no single slot and no setup token. An empty-looking table is
    // not a reason to skip anything.
    for (const isFirstAccount of [true, false]) {
      for (const claimGatedBySetupToken of [true, false]) {
        expect(signupVerificationPolicy({ edition: 'cloud', isFirstAccount, claimGatedBySetupToken, mailConfigured: true }))
          .toBe('require')
      }
    }
  })

  it('refuses on Cloud rather than creating an unverified account when mail is down', () => {
    expect(signupVerificationPolicy({
      edition: 'cloud', isFirstAccount: false, claimGatedBySetupToken: false, mailConfigured: false,
    })).toBe('refuse_no_mail')
    expect(signupVerificationPolicy({
      edition: 'cloud', isFirstAccount: true, claimGatedBySetupToken: true, mailConfigured: false,
    })).toBe('refuse_no_mail')
  })
})
