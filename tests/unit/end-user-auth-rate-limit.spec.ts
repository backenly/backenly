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
 */

import { consume, AUTH_LIMITS } from '@/lib/security/auth-rate-limit'

const IP = '203.0.113.7'
const OTHER_IP = '203.0.113.8'
const PROJECT = 'proj-alpha'
const OTHER_PROJECT = 'proj-beta'

/** The key shape the routes build. */
const key = (policy: string, projectId: string, ip: string) => `v1:${policy}:${projectId}:${ip}`

/** A fresh key per test run, so one test cannot exhaust another's budget. */
const unique = (s: string) => `${s}:${Math.random().toString(36).slice(2)}`

describe('the limits exist and are finite', () => {
  it.each(['endUserSignin', 'endUserSignup', 'endUserRecover'] as const)(
    '%s has a positive limit over a positive window',
    policy => {
      const p = AUTH_LIMITS[policy].ip
      expect(p.limit).toBeGreaterThan(0)
      expect(p.windowMs).toBeGreaterThan(0)
    },
  )

  it('sign-in is the tightest of the three, because it is the guessing surface', async () => {
    // Recovery is tighter still per window; the point is that sign-in is not
    // the loosest, which would be the wrong way round.
    expect(AUTH_LIMITS.endUserSignin.ip.limit).toBeLessThanOrEqual(
      AUTH_LIMITS.endUserSignup.ip.limit,
    )
  })
})

describe('throttling actually engages', () => {
  it('allows attempts up to the limit and then denies', async () => {
    const policy = AUTH_LIMITS.endUserSignin.ip
    const k = unique(key('endUserSignin', PROJECT, IP))

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
    const policy = AUTH_LIMITS.endUserSignin.ip
    const k = unique(key('endUserSignin', PROJECT, IP))
    for (let i = 0; i < policy.limit + 1; i++) await consume(k, policy.limit, policy.windowMs)
    expect((await consume(k, policy.limit, policy.windowMs)).allowed).toBe(false)
  })
})

describe('the identity dimension, against distributed stuffing', () => {
  // A per-IP limit alone is weak against a botnet: one attempt per address
  // never trips it. signin therefore also budgets per project + normalised
  // email, so one account cannot be hammered from many sources.
  const identityKey = (projectId: string, email: string) =>
    `v1:endUserSignin:${projectId}:${email.trim().toLowerCase()}`

  it('exhausts a budget for one identity regardless of source address', async () => {
    const policy = AUTH_LIMITS.endUserSignin.ip
    const k = unique(identityKey(PROJECT, 'victim@example.test'))
    for (let i = 0; i < policy.limit + 1; i++) await consume(k, policy.limit, policy.windowMs)
    expect((await consume(k, policy.limit, policy.windowMs)).allowed).toBe(false)
  })

  it('normalises case, so one address cannot get two budgets', async () => {
    const policy = AUTH_LIMITS.endUserSignin.ip
    const suffix = Math.random().toString(36).slice(2)
    const lower = identityKey(PROJECT, `victim-${suffix}@example.test`)
    const upper = identityKey(PROJECT, `VICTIM-${suffix}@EXAMPLE.TEST`)
    expect(lower).toBe(upper)
  })

  it('does not let one identity exhaust another', async () => {
    const policy = AUTH_LIMITS.endUserSignin.ip
    const a = unique(identityKey(PROJECT, 'a@example.test'))
    for (let i = 0; i < policy.limit + 1; i++) await consume(a, policy.limit, policy.windowMs)
    expect((await consume(a, policy.limit, policy.windowMs)).allowed).toBe(false)

    const b = identityKey(PROJECT, `b-${Math.random()}@example.test`)
    expect((await consume(b, policy.limit, policy.windowMs)).allowed).toBe(true)
  })

  it('keeps identity budgets separate across projects', async () => {
    const policy = AUTH_LIMITS.endUserSignin.ip
    const email = `shared-${Math.random().toString(36).slice(2)}@example.test`
    const inA = identityKey(PROJECT, email)
    for (let i = 0; i < policy.limit + 1; i++) await consume(inA, policy.limit, policy.windowMs)
    expect((await consume(inA, policy.limit, policy.windowMs)).allowed).toBe(false)

    // The same person may hold an account in two projects; one being attacked
    // must not lock them out of the other.
    const inB = identityKey(OTHER_PROJECT, email)
    expect((await consume(inB, policy.limit, policy.windowMs)).allowed).toBe(true)
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
    const policy = AUTH_LIMITS.endUserSignin.ip
    const attacked = unique(key('endUserSignin', PROJECT, IP))
    for (let i = 0; i < policy.limit + 1; i++) await consume(attacked, policy.limit, policy.windowMs)
    expect((await consume(attacked, policy.limit, policy.windowMs)).allowed).toBe(false)

    const bystander = key('endUserSignin', OTHER_PROJECT, IP)
    expect((await consume(bystander, policy.limit, policy.windowMs)).allowed).toBe(true)
  })

  it('one IP cannot spend another IP’s budget for the same project', async () => {
    const policy = AUTH_LIMITS.endUserSignin.ip
    const first = unique(key('endUserSignin', PROJECT, IP))
    for (let i = 0; i < policy.limit + 1; i++) await consume(first, policy.limit, policy.windowMs)
    expect((await consume(first, policy.limit, policy.windowMs)).allowed).toBe(false)

    const second = key('endUserSignin', PROJECT, OTHER_IP)
    expect((await consume(second, policy.limit, policy.windowMs)).allowed).toBe(true)
  })

  it('signin and signup budgets are independent', async () => {
    // Sharing one budget would let a signup flood disable sign-in.
    const p = AUTH_LIMITS.endUserSignin.ip
    const signinKey = unique(key('endUserSignin', PROJECT, IP))
    for (let i = 0; i < p.limit + 1; i++) await consume(signinKey, p.limit, p.windowMs)
    expect((await consume(signinKey, p.limit, p.windowMs)).allowed).toBe(false)

    const q = AUTH_LIMITS.endUserSignup.ip
    const signupKey = key('endUserSignup', PROJECT, IP)
    expect((await consume(signupKey, q.limit, q.windowMs)).allowed).toBe(true)
  })
})
