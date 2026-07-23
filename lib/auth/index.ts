// Authentication exports
export * from './jwt'
export * from './session'

// Password hashing — single source of truth. All callers must use these
// helpers; never `bcrypt.hash(..., 10)` directly.
export { hashPassword, verifyPassword, validatePasswordStrength } from './password'

// Backwards-compatible alias for the old name on this module.
export { verifyPassword as comparePassword } from './password'
