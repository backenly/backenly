/**
 * May this email create an account here?
 *
 * This is the boundary between what a deployment decides for itself and what
 * Backenly Cloud decides about a stranger. Both halves were tangled in one
 * function before; the order they run in is load-bearing and is preserved
 * exactly:
 *
 *   1. self-hosted slot      is registration closed, and is this the first?
 *   2. kill switches         signupsDisabled / maintenanceMode
 *   3. operator blocklist    an explicit list somebody wrote
 *   4. Cloud admission       the email heuristics, via PlatformSignals
 *
 * Steps 1 to 3 are decisions the operator of this deployment made, so they are
 * public and they run in every edition. Step 4 is a score computed about
 * someone nobody has met, which is Backenly's business and nobody else's; in
 * single-tenant it does not run at all.
 *
 * The first self-hosted operator skips step 4 and always did. Applied to the
 * one account that makes a private install usable, deliverability heuristics
 * only lock the operator out of their own box: measured on a clean acceptance
 * machine, operator@acceptance.test was refused with "That domain cannot
 * receive email." An operator on any internal domain with no public MX could
 * not create an account at all.
 */
import { isBlocked } from './blocklist'
import { recordSecurityEvent } from './security-events'
import { SELF_HOSTED_CLOSED, selfHostedRegistrationClosed, type SignupGuard } from './signup-slot'
import { getPlatformControls, ok } from './state'
import { assessSignupAdmission } from '@/lib/platform-signals'
import { prisma } from '@/lib/db/prisma'

export async function assertSignupAllowed(email: string, ip?: string | null): Promise<SignupGuard> {
  let firstSelfHostedOperator = false

  // Self-hosted is CLOSED after the first account.
  //
  // A self-hosted deployment is one team's infrastructure, usually reachable
  // from the internet, and it has no abuse defence worth the name: Turnstile,
  // the email-trust heuristics and the blocklist are all inert until an
  // operator configures them. Leaving public signup open by default would mean
  // anyone who finds the URL gets an account on it.
  //
  // The first account is allowed, because otherwise a fresh install has no way
  // to create its operator and the only escape is editing the database by
  // hand. After that, an operator who genuinely wants open registration sets
  // BACKENLY_ALLOW_PUBLIC_SIGNUP=true, which is a decision someone made rather
  // than a default nobody chose.
  if (selfHostedRegistrationClosed()) {
    const existing = await prisma.user.count()
    if (existing > 0) return SELF_HOSTED_CLOSED
    firstSelfHostedOperator = true
  }

  const c = await getPlatformControls()
  if (c.signupsDisabled) {
    return { ok: false, reason: 'New sign-ups are temporarily disabled.', status: 503 }
  }
  if (c.maintenanceMode) {
    return { ok: false, reason: 'The platform is in maintenance mode. Try again shortly.', status: 503 }
  }

  // Operator blocklist runs before the heuristics: a hand-added entry is an
  // explicit decision and should never be second-guessed by a score.
  const hit = await isBlocked({ email, ip })
  if (hit) {
    await recordSecurityEvent({
      kind: 'blocklist_hit',
      severity: 'warn',
      userEmail: email,
      ip: ip ?? null,
      summary: `Blocked signup attempt — ${hit.kind}=${hit.value}`,
      detail: { match: hit, email, ip },
    }).catch(() => {})
    return { ok: false, reason: 'Sign-up is not allowed for this account.', status: 403 }
  }

  // The Cloud email heuristics, skipped for the one account described above.
  // Everything before this point — the kill switches and the operator
  // blocklist — has already run, because those are explicit decisions rather
  // than a score computed about a stranger.
  if (firstSelfHostedOperator) return ok

  return assessSignupAdmission({ email, ip: ip ?? null })
}
