/**
 * THE END-USER AUTH SURFACE HAD NO THROTTLING AT ALL
 * ==================================================
 * `/api/v1/{projectId}/auth/signin` and its siblings are how a CUSTOMER'S OWN
 * users sign in, so they are unauthenticated by design. They also had no rate
 * limiting of any kind, at any layer: not in the route, not in
 * `v1ApiMiddleware` (which they do not use), and not in `middleware.ts`, which
 * treats `/api/v1/` as API-key-authenticated and skips it.
 *
 * Meanwhile the platform's own `/api/auth/login` has IP brute-force protection
 * and account lockout. The end-user equivalent had neither, which left
 * credential stuffing against every end user of every project unthrottled.
 *
 * The limits are keyed per IP AND per project. That detail matters: a single
 * global IP budget would let an attack on one project lock out sign-in for
 * every other tenant behind the same egress address, and would let one IP
 * spend one budget across all of them.
 *
 * Sign-in then over-corrected: it counted every attempt, successes included,
 * so real users ran out of sign-ins. It now counts failures
 * (lib/security/end-user-signin-limit.ts), and the cases below hold both
 * halves: guessing is still refused, signing in never is.
 */

import { consume, AUTH_LIMITS } from '@/lib/security/auth-rate-limit'
import {
  admitSigninAttempt,
  admitSigninRequest,
  endUserSigninKeys,
} from '@/lib/security/end-user-signin-limit'
import { admitExistenceCheck, admitSignupRequest } from '@/lib/security/end-user-signup-limit'

const IP = '203.0.113.7'
const OTHER_IP = '203.0.113.8'
const PROJECT = 'proj-alpha'
const OTHER_PROJECT = 'proj-beta'

/** The key shape the sign-up and recovery routes build. */
const key = (policy: string, projectId: string, ip: string) => `v1:${policy}:${projectId}:${ip}`

/** A fresh key per test run, so one test cannot exhaust another's budget. */
const unique = (s: string) => `${s}:${Math.random().toString(36).slice(2)}`

/** A project of its own per test, so sign-in budgets never carry between cases. */
const freshProject = () => unique('proj-signin')

const SIGNIN = AUTH_LIMITS.endUserSignin

/** An attempt whose password turned out wrong: spent, never refunded. */
async function failed(projectId: string, ip: string, email: string) {
  return (await admitSigninAttempt(projectId, ip, email)).denied === null
}

/** An attempt whose password turned out right. Returns whether it was admitted. */
async function succeeded(projectId: string, ip: string, email: string) {
  const attempt = await admitSigninAttempt(projectId, ip, email)
  if (attempt.denied) return false
  await attempt.credentialsVerified()
  return true
}

describe('the limits exist and are finite', () => {
  it.each(['endUserSignin', 'endUserSignup', 'endUserRecover'] as const)(
    '%s has a positive limit over a positive window',
    policy => {
      const p = AUTH_LIMITS[policy].ip
      expect(p.limit).toBeGreaterThan(0)
      expect(p.windowMs).toBeGreaterThan(0)
    },
  )

  it('sign-in budgets failures, and guessing one account is the tightest of them', () => {
    for (const p of [SIGNIN.ipFailures, SIGNIN.accountFailures]) {
      expect(p.limit).toBeGreaterThan(0)
      expect(p.windowMs).toBeGreaterThan(0)
    }
    expect(SIGNIN.accountFailures.limit).toBeLessThanOrEqual(SIGNIN.ipFailures.limit)
    // The all-attempts ceiling is not a guessing control, so it must sit well
    // above the failure budgets or it would quietly become one again.
    expect(SIGNIN.ip.limit).toBeGreaterThan(SIGNIN.ipFailures.limit * 5)
  })
})

describe('throttling actually engages', () => {
  it('allows attempts up to the limit and then denies', async () => {
    const policy = AUTH_LIMITS.endUserSignup.ip
    const k = unique(key('endUserSignup', PROJECT, IP))

    for (let i = 0; i < policy.limit; i++) {
      const r = await consume(k, policy.limit, policy.windowMs)
      expect(r.allowed).toBe(true)
    }

    // The attempt after the budget is refused, with something to tell the
    // caller when to come back.
    const denied = await consume(k, policy.limit, policy.windowMs)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfter).toBeGreaterThan(0)
  })

  it('an exhausted budget stays exhausted within the window', async () => {
    const policy = AUTH_LIMITS.endUserSignup.ip
    const k = unique(key('endUserSignup', PROJECT, IP))
    for (let i = 0; i < policy.limit + 1; i++) await consume(k, policy.limit, policy.windowMs)
    expect((await consume(k, policy.limit, policy.windowMs)).allowed).toBe(false)
  })
})

describe('sign-in counts failures, not sign-ins', () => {
  it('never refuses an account that keeps signing in with the right password', async () => {
    // The reported bug: a shopper (or the developer testing their own login)
    // signing in and out was refused on the eleventh go with nothing wrong.
    const project = freshProject()
    for (let i = 0; i < SIGNIN.accountFailures.limit * 3; i++) {
      expect(await succeeded(project, IP, 'shopper@example.test')).toBe(true)
    }
  })

  it('never refuses many shoppers signing in from one shared address', async () => {
    // One office, campus or carrier NAT, or a frontend signing in from its own
    // server: every user arrives from the same address.
    const project = freshProject()
    for (let i = 0; i < SIGNIN.ipFailures.limit * 3; i++) {
      expect(await succeeded(project, IP, `shopper-${i}@example.test`)).toBe(true)
    }
  })

  it('refuses an account after its failure budget, from every address', async () => {
    // Distributed guessing: a different source for every guess.
    const project = freshProject()
    for (let i = 0; i < SIGNIN.accountFailures.limit; i++) {
      expect(await failed(project, `198.51.100.${i}`, 'victim@example.test')).toBe(true)
    }

    // Refused before the password is looked at, so even the right one cannot
    // get through a budget the guesses exhausted. That is the lockout.
    const next = await admitSigninAttempt(project, '198.51.100.200', 'victim@example.test')
    expect(next.denied?.allowed).toBe(false)
    expect(next.denied?.outcome).toBe('limit_exceeded')
    expect(next.denied?.retryAfter).toBeGreaterThan(0)

    // CONTROL: the limiter is not refusing everything. Another account in the
    // project still signs in from that same address.
    expect(await succeeded(project, '198.51.100.200', 'bystander@example.test')).toBe(true)
  })

  it('refuses an address after its failure budget, across different accounts', async () => {
    // Stuffing from one source: one guess per account, many accounts.
    const project = freshProject()
    for (let i = 0; i < SIGNIN.ipFailures.limit; i++) {
      expect(await failed(project, IP, `list-${i}@example.test`)).toBe(true)
    }
    expect(await failed(project, IP, 'list-next@example.test')).toBe(false)

    // CONTROL: a different address in the same project is unaffected.
    expect(await succeeded(project, OTHER_IP, 'list-next@example.test')).toBe(true)
  })

  it('gives back only the successful attempt, not the failures before it', async () => {
    // A reset here would let anyone holding one valid password wipe a
    // guessing run's count by signing in between guesses.
    const project = freshProject()
    const email = 'typo-prone@example.test'
    for (let i = 0; i < SIGNIN.accountFailures.limit - 1; i++) {
      expect(await failed(project, IP, email)).toBe(true)
    }
    expect(await succeeded(project, IP, email)).toBe(true)

    // Nine failures still stand: one more is admitted, the one after is not.
    expect(await failed(project, IP, email)).toBe(true)
    expect(await failed(project, IP, email)).toBe(false)
  })

  it('refunds once, however many times it is told', async () => {
    const project = freshProject()
    const email = 'double-call@example.test'
    for (let i = 0; i < SIGNIN.accountFailures.limit - 1; i++) await failed(project, IP, email)

    const attempt = await admitSigninAttempt(project, IP, email)
    expect(attempt.denied).toBeNull()
    await attempt.credentialsVerified()
    await attempt.credentialsVerified()
    await attempt.credentialsVerified()

    // A second refund would have given back one of the nine failures.
    expect(await failed(project, IP, email)).toBe(true)
    expect(await failed(project, IP, email)).toBe(false)
  })

  it('a refused attempt has nothing to give back', async () => {
    const project = freshProject()
    const email = 'locked@example.test'
    for (let i = 0; i < SIGNIN.accountFailures.limit; i++) await failed(project, IP, email)

    const refused = await admitSigninAttempt(project, IP, email)
    expect(refused.denied).not.toBeNull()
    await refused.credentialsVerified()
    expect(await failed(project, IP, email)).toBe(false)
  })

  it('normalises the account, so case and padding cannot double the budget', () => {
    expect(endUserSigninKeys.accountFailures(PROJECT, '  Victim@Example.TEST ')).toBe(
      endUserSigninKeys.accountFailures(PROJECT, 'victim@example.test'),
    )
  })

  it('keeps an account budget per project', async () => {
    // The same person may hold an account in two projects; one being attacked
    // must not lock them out of the other.
    const a = freshProject()
    const b = freshProject()
    const email = 'shared@example.test'
    for (let i = 0; i < SIGNIN.accountFailures.limit; i++) await failed(a, IP, email)
    expect(await failed(a, IP, email)).toBe(false)
    expect(await succeeded(b, IP, email)).toBe(true)
  })

  it('caps every attempt from one address, successful or not, far above the failure budgets', async () => {
    const project = freshProject()
    for (let i = 0; i < SIGNIN.ip.limit; i++) {
      expect((await admitSigninRequest(project, IP)).allowed).toBe(true)
    }
    const over = await admitSigninRequest(project, IP)
    expect(over.allowed).toBe(false)
    expect(over.outcome).toBe('limit_exceeded')

    // CONTROL: per address and per project.
    expect((await admitSigninRequest(project, OTHER_IP)).allowed).toBe(true)
    expect((await admitSigninRequest(freshProject(), IP)).allowed).toBe(true)
  })
})

describe('sign-up: a loose cap on accounts, a tight one on "already registered"', () => {
  const SIGNUP = AUTH_LIMITS.endUserSignup

  it('lets far more customers sign up from one address than it used to (10 an hour)', async () => {
    const project = freshProject()
    for (let i = 0; i < SIGNUP.ip.limit; i++) {
      expect((await admitSignupRequest(project, IP)).allowed).toBe(true)
    }
    expect(SIGNUP.ip.limit).toBeGreaterThan(10)
    // The cap still exists: what one address can create is bounded.
    expect((await admitSignupRequest(project, IP)).allowed).toBe(false)
    expect((await admitSignupRequest(project, OTHER_IP)).allowed).toBe(true)
  })

  it('keeps the existence oracle as tight as the old limit', () => {
    expect(SIGNUP.ipConflicts.limit).toBeLessThanOrEqual(10)
    expect(SIGNUP.ipConflicts.limit).toBeLessThan(SIGNUP.ip.limit)
  })

  it('counts only answers that an address is taken', async () => {
    const project = freshProject()
    // Free addresses give their unit back, however many there are.
    for (let i = 0; i < SIGNUP.ipConflicts.limit * 3; i++) {
      const check = await admitExistenceCheck(project, IP)
      expect(check.denied).toBeNull()
      await check.addressFree()
    }
    // Taken addresses keep it, until the budget refuses the lookup itself.
    for (let i = 0; i < SIGNUP.ipConflicts.limit; i++) {
      expect((await admitExistenceCheck(project, IP)).denied).toBeNull()
    }
    const refused = await admitExistenceCheck(project, IP)
    expect(refused.denied?.outcome).toBe('limit_exceeded')
    // Refused before the lookup, so the answer is the same for a free address.
    await refused.addressFree()
    expect((await admitExistenceCheck(project, IP)).denied).not.toBeNull()

    // CONTROL: per address.
    expect((await admitExistenceCheck(project, OTHER_IP)).denied).toBeNull()
  })

  it('refunds once, however many times it is told', async () => {
    const project = freshProject()
    for (let i = 0; i < SIGNUP.ipConflicts.limit - 1; i++) await admitExistenceCheck(project, IP)
    const check = await admitExistenceCheck(project, IP)
    await check.addressFree()
    await check.addressFree()
    expect((await admitExistenceCheck(project, IP)).denied).toBeNull()
    expect((await admitExistenceCheck(project, IP)).denied).not.toBeNull()
  })
})

describe('forgot-password cannot be used as an email bomb', () => {
  // The per-IP limit caps the attacker's rate but not how often ONE victim can
  // be mailed from rotating sources, so the target address gets its own budget.
  const targetKey = (projectId: string, email: string) =>
    `v1:endUserRecover:target:${projectId}:${email.trim().toLowerCase()}`

  it('stops repeated mail to the same address', async () => {
    const policy = AUTH_LIMITS.endUserRecover.ip
    const k = unique(targetKey(PROJECT, 'bombed@example.test'))
    for (let i = 0; i < policy.limit + 1; i++) await consume(k, policy.limit, policy.windowMs)
    expect((await consume(k, policy.limit, policy.windowMs)).allowed).toBe(false)
  })

  it('keeps the requester budget and the target budget separate', async () => {
    // Otherwise one exhausted victim would block every other recovery request
    // from that address, or vice versa.
    const policy = AUTH_LIMITS.endUserRecover.ip
    const target = unique(targetKey(PROJECT, 'victim@example.test'))
    for (let i = 0; i < policy.limit + 1; i++) await consume(target, policy.limit, policy.windowMs)
    expect((await consume(target, policy.limit, policy.windowMs)).allowed).toBe(false)

    const requester = key('endUserRecover', PROJECT, IP)
    expect((await consume(requester, policy.limit, policy.windowMs)).allowed).toBe(true)
  })
})

describe('the key is scoped per project AND per ip', () => {
  it('exhausting one project does not lock out another', async () => {
    // The tenant-isolation property. Without the projectId in the key, an
    // attack on one customer would deny sign-in to every other customer
    // sharing an egress address.
    const attacked = freshProject()
    for (let i = 0; i < SIGNIN.ipFailures.limit; i++) await failed(attacked, IP, `x-${i}@example.test`)
    expect(await failed(attacked, IP, 'x-next@example.test')).toBe(false)

    expect(await failed(freshProject(), IP, 'x-next@example.test')).toBe(true)
  })

  it('one IP cannot spend another IP’s budget for the same project', async () => {
    const project = freshProject()
    for (let i = 0; i < SIGNIN.ipFailures.limit; i++) await failed(project, IP, `y-${i}@example.test`)
    expect(await failed(project, IP, 'y-next@example.test')).toBe(false)

    expect(await failed(project, OTHER_IP, 'y-next@example.test')).toBe(true)
  })

  it('signin and signup budgets are independent', async () => {
    // Sharing one budget would let a signup flood disable sign-in.
    const project = freshProject()
    for (let i = 0; i < SIGNIN.ipFailures.limit; i++) await failed(project, IP, `z-${i}@example.test`)
    expect(await failed(project, IP, 'z-next@example.test')).toBe(false)

    const q = AUTH_LIMITS.endUserSignup.ip
    const signupKey = key('endUserSignup', project, IP)
    expect((await consume(signupKey, q.limit, q.windowMs)).allowed).toBe(true)
  })
})
