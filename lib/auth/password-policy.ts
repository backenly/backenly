/**
 * THE PLATFORM PASSWORD POLICY, IN ONE PLACE
 * ==========================================
 * The register and reset routes enforced 12+ characters with upper and lower
 * case, a number and a symbol. The signup page checked 8+ characters and no
 * symbol and told people "8+ chars, mix of upper, lower, and a number", and the
 * reset page promised "at least 8". So the pages accepted passwords the server
 * then refused, on the path every new account takes.
 *
 * One function, imported by the routes and the pages alike. It is pure and
 * imports nothing, so it is safe in a client bundle, which lib/auth/password.ts
 * (bcrypt, crypto) is not.
 *
 * Platform accounts only. End-user auth inside a project has its own policy in
 * lib/services/workspaceAuth.ts.
 */

export const PASSWORD_MIN_LENGTH = 12

/** What a page tells someone choosing a password, so it matches what is enforced. */
export const PASSWORD_POLICY_HINT =
  `${PASSWORD_MIN_LENGTH}+ characters, with upper and lower case, a number and a symbol.`

export function validatePasswordStrength(password: string): { valid: boolean; message?: string } {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { valid: false, message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long` }
  }

  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one uppercase letter' }
  }

  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one lowercase letter' }
  }

  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number' }
  }

  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one special character' }
  }

  return { valid: true }
}
