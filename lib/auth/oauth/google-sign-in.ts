/**
 * ONE WAY FROM A GOOGLE IDENTITY TO A PLATFORM ACCOUNT
 * ====================================================
 * Two doors hand a Google identity to the platform: the redirect callback
 * (app/api/auth/platform-google/callback) and Google One Tap
 * (app/api/auth/platform-google/one-tap). Both find or create the account
 * here, so the checks a Google sign-in owes cannot differ between them:
 *
 *   1. only an address Google says it verified (verified-email.ts), because
 *      the account is created, or LINKED to an existing one by address, as
 *      email-verified;
 *   2. the founder block list;
 *   3. no sign-in for an account with two-factor authentication, asked before
 *      anything is written to it (second-factor.ts);
 *   4. a new account only where a provider may create one (a self-hosted
 *      deployment waiting for its setup token refuses) and only past the
 *      signup guard.
 *
 * Dashboard login, not project end-user OAuth. The caller proves the identity
 * came from Google (a code exchange, or a verified ID token) and issues the
 * session; this module never sees a credential.
 */

import { prisma } from '@/lib/db'
import { onSignupCompleted } from '@/lib/platform-signals'
import { assertSignupAllowed, isBlocked } from '@/lib/platform-controls'
import { googleVerifiedEmail } from '@/lib/auth/oauth/verified-email'
import { providerSignInRefusal } from '@/lib/auth/oauth/second-factor'
import { oauthMayCreateAccount } from '@/lib/auth/setup-token'

/** The `?error=` codes the login page explains. */
export type GoogleSignInRefusal =
  | 'email_not_verified'
  | 'blocked'
  | 'second_factor_required'
  | 'claim_requires_setup_token'
  | 'signup_not_allowed'

export interface GoogleIdentity {
  /** Google's stable subject for the account (`id` in userinfo, `sub` in an ID token). */
  subject: string
  /** The profile as Google sent it; only a verified address is read from it. */
  profile: unknown
  name?: string | null
}

export type GoogleSignInResult =
  | {
      ok: true
      created: boolean
      user: { id: string; email: string; name: string | null; role: { name: string } | null }
    }
  // Told apart by `'error' in result`: this project compiles without
  // strictNullChecks, where a boolean `ok` does not narrow the union.
  | { ok: false; error: GoogleSignInRefusal }

export async function signInGoogleIdentity(
  identity: GoogleIdentity,
  context: { ip: string; referralCode: string | null },
): Promise<GoogleSignInResult> {
  const email = googleVerifiedEmail(identity.profile)
  if (!email) return { ok: false, error: 'email_not_verified' }

  const ipForBlock = context.ip === 'unknown' ? null : context.ip
  if (await isBlocked({ email, ip: ipForBlock })) return { ok: false, error: 'blocked' }

  const signedInAt = new Date()
  const existing = await prisma.user.findUnique({ where: { email }, include: { role: true } })

  const refusal = providerSignInRefusal(existing)
  if (refusal) return { ok: false, error: refusal }

  if (!existing) {
    // A provider sign-in carries no setup token, so it cannot claim a
    // self-hosted deployment that is waiting for one.
    if (!(await oauthMayCreateAccount())) return { ok: false, error: 'claim_requires_setup_token' }
    const guard = await assertSignupAllowed(email, ipForBlock)
    if (!guard.ok) return { ok: false, error: 'signup_not_allowed' }

    const user = await prisma.user.create({
      data: {
        email,
        name: identity.name ?? null,
        emailVerified: true,
        provider: 'google',
        providerId: identity.subject,
        lastLogin: signedInAt,
        lastActiveAt: signedInAt,
        // Google already proved control of the mailbox, so a Google signup is
        // never held as untrusted. The score is still recorded: a challenge
        // verdict here is worth being able to see later.
        signupScore: guard.score ?? null,
        signupSignals: guard.signals ?? [],
        signupIp: ipForBlock,
      },
      include: { role: true },
    })

    // Reporting the signup is a no-op in single-tenant and never throws, so it
    // cannot block sign-in.
    await onSignupCompleted({
      userId: user.id,
      email: user.email,
      provider: 'google',
      referralCode: context.referralCode,
    })
    return { ok: true, created: true, user }
  }

  // Always stamp lastLogin + lastActiveAt on a successful sign-in; link the
  // provider on the first Google sign-in for an email-only account.
  const linkProvider = !existing.provider || existing.provider === 'email'
  const user = await prisma.user.update({
    where: { id: existing.id },
    data: {
      lastLogin: signedInAt,
      lastActiveAt: signedInAt,
      ...(linkProvider ? { provider: 'google', providerId: identity.subject, emailVerified: true } : {}),
    },
    include: { role: true },
  })
  return { ok: true, created: false, user }
}
