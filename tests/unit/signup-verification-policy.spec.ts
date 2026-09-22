/**
 * Every branch of "must this signup prove its email first", pinned.
 *
 * The rule lives in one pure function so that each edition's answer is asserted
 * here directly, rather than only by a route test that happens to reach it.
 */
import { signupVerificationPolicy } from '@/lib/auth/signup/policy'

describe('signupVerificationPolicy', () => {
  it('lets the first self-hosted operator in without a code, mail or no mail', () => {
    // Possession of the machine is the proof, and most fresh installs have no
    // SMTP. Demanding a code here would lock the operator out of their own box.
    expect(signupVerificationPolicy({ edition: 'single-tenant', isFirstAccount: true, mailConfigured: false })).toBe('skip')
    expect(signupVerificationPolicy({ edition: 'single-tenant', isFirstAccount: true, mailConfigured: true })).toBe('skip')
  })

  it('requires a code for every later self-hosted account', () => {
    expect(signupVerificationPolicy({ edition: 'single-tenant', isFirstAccount: false, mailConfigured: true })).toBe('require')
  })

  it('refuses a later self-hosted account when the server cannot send the code', () => {
    // Not waved through unverified: the operator opened registration to
    // strangers, and a stranger's address is exactly what must be proven.
    expect(signupVerificationPolicy({ edition: 'single-tenant', isFirstAccount: false, mailConfigured: false })).toBe('refuse')
  })

  it('always requires a code on Cloud, including what looks like a first account', () => {
    // Cloud has no single slot. An empty-looking table is not a reason to skip.
    expect(signupVerificationPolicy({ edition: 'cloud', isFirstAccount: true, mailConfigured: true })).toBe('require')
    expect(signupVerificationPolicy({ edition: 'cloud', isFirstAccount: false, mailConfigured: true })).toBe('require')
  })

  it('refuses on Cloud rather than creating an unverified account when mail is down', () => {
    expect(signupVerificationPolicy({ edition: 'cloud', isFirstAccount: false, mailConfigured: false })).toBe('refuse')
    expect(signupVerificationPolicy({ edition: 'cloud', isFirstAccount: true, mailConfigured: false })).toBe('refuse')
  })
})
