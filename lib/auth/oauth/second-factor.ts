/**
 * A GOOGLE OR GITHUB SIGN-IN DOES NOT STAND IN FOR A SECOND FACTOR
 * ================================================================
 * An account with two-factor authentication turned on signs in with its
 * password and a code from its authenticator app (or a backup code):
 * POST /api/auth/login asks for that code before it issues a session.
 *
 * The provider callbacks have no step that asks for the code yet. So for such
 * an account they do not complete the sign-in: no session, no cookie, and
 * nothing written to the account (no provider link, no last-login stamp). The
 * person is sent to the login page with SECOND_FACTOR_REQUIRED, which the page
 * explains: sign in with the password and the authenticator code instead.
 *
 * Accounts without two-factor authentication sign in exactly as before, and a
 * provider sign-in that creates a new account is unaffected: a new account has
 * no second factor yet.
 *
 * Every callback that issues a platform session from a provider identity asks
 * this right after it looks the account up and before it writes anything to
 * it. tests/unit/oauth-second-factor.spec.ts holds every such callback to that.
 */

/** The `?error=` code the login page explains. */
export const SECOND_FACTOR_REQUIRED = 'second_factor_required'

/**
 * Why a provider sign-in may not complete for this account, or null when it
 * may. `account` is the row found by the provider's verified address, or null
 * when there is none yet.
 *
 * `twoFactorEnabled` is required in the type on purpose: a lookup that does
 * not load it cannot be passed here.
 */
export function providerSignInRefusal(
  account: { twoFactorEnabled: boolean } | null,
): typeof SECOND_FACTOR_REQUIRED | null {
  return account?.twoFactorEnabled ? SECOND_FACTOR_REQUIRED : null
}
