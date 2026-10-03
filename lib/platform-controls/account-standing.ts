/**
 * Account standing gate.
 * ======================
 *
 * The structural half of the anti-abuse work, and the half that does not depend
 * on correctly identifying an abusive domain.
 *
 * PUBLIC, and it stays public for the same reason the blocklist does: both
 * rules it enforces are decisions somebody made about this deployment, not
 * scores computed about a stranger.
 *
 *   - suspendedAt is an operator action, and public auth already enforces it
 *     in lib/auth/middleware.ts, lib/auth/server.ts and lib/auth/session.ts.
 *     Moving this gate private would have left a self-hosted deployment
 *     enforcing suspension on sign-in but not on project creation.
 *   - the untrusted gate is inert in single-tenant by construction: nothing
 *     there ever sets trustLevel to 'untrusted', because that only happens when
 *     Cloud signup scoring returns a challenge verdict, and that scoring does
 *     not run. So it needs no private module to be correct in OSS.
 *
 * It reads only User columns that stay in the public schema.
 *
 * A signup whose email scored in the challenge band (the Cloud admission path)
 * is created as `untrusted`. It can sign in and look around, but it cannot
 * consume anything — no projects, no databases, no compute — until it proves it
 * controls the mailbox. That inverts the economics: minting an account stops
 * being free value for a bot operator, and no blocklist has to be right for it
 * to hold.
 *
 * Two deliberate properties:
 *
 *   - Only `untrusted` accounts are gated. Every pre-existing user, and every
 *     signup that scores clean, is unaffected — so this can ship to production
 *     without a migration window or a grandfather cutoff.
 *   - Verifying the mailbox promotes the account (see the verify-email route),
 *     so a real person caught by a heuristic clears it themselves in one click
 *     and never has to contact support.
 */

import { prisma } from '@/lib/db/prisma'

export interface StandingGuard {
  ok: boolean
  reason: string
  status: number
  code?: 'EMAIL_VERIFICATION_REQUIRED' | 'ACCOUNT_SUSPENDED'
}

const allowed: StandingGuard = { ok: true, reason: '', status: 200 }

/**
 * Assert that a user is allowed to create or consume resources.
 * Call this at the top of any route that provisions something durable.
 */
export async function assertAccountCanConsume(userId: string): Promise<StandingGuard> {
  let account: { emailVerified: boolean; trustLevel: string; suspendedAt: Date | null } | null = null
  try {
    account = await prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true, trustLevel: true, suspendedAt: true },
    })
  } catch {
    // A database hiccup must not block a paying customer from working.
    // The other layers (rate limits, the signup gate itself) still apply.
    return allowed
  }

  if (!account) return allowed

  if (account.suspendedAt) {
    return {
      ok: false,
      reason: 'This account is suspended. Contact support if you believe this is a mistake.',
      status: 403,
      code: 'ACCOUNT_SUSPENDED',
    }
  }

  if (account.trustLevel === 'untrusted' && !account.emailVerified) {
    return {
      ok: false,
      reason:
        'Please verify your email address before creating a project. Check your inbox for the verification link, or request a new one from your account settings.',
      status: 403,
      code: 'EMAIL_VERIFICATION_REQUIRED',
    }
  }

  return allowed
}

/**
 * Promote an account once it proves control of its mailbox. Idempotent, and
 * only ever moves `untrusted` → `trusted` — it must never be able to downgrade
 * someone or resurrect a suspension.
 */
export async function promoteOnEmailVerified(userId: string): Promise<void> {
  try {
    await prisma.user.updateMany({
      where: { id: userId, trustLevel: 'untrusted' },
      data: { trustLevel: 'trusted' },
    })
  } catch {
    // Non-fatal: verification itself already succeeded.
  }
}
