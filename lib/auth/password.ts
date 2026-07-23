import bcrypt from 'bcryptjs'

/**
 * Bcrypt rounds (work factor). 12 is the 2026 OWASP floor.
 * ALL password hashing in the codebase must go through hashPassword(),
 * never raw `bcrypt.hash(..., 10)`. The platform/end-user split that used
 * to allow 10 for end-users was a security drift; everything is 12 now.
 */
const BCRYPT_ROUNDS = 12

/**
 * Hash a password using bcrypt.
 */
export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, BCRYPT_ROUNDS)
}

/**
 * Verify a password against a hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash)
}

/**
 * Validate password strength. Used by signup, password reset, and any other
 * surface that accepts a new password.
 */
export function validatePasswordStrength(password: string): { valid: boolean; message?: string } {
  if (password.length < 12) {
    return { valid: false, message: 'Password must be at least 12 characters long' }
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
