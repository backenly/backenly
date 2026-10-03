/**
 * ONE PASSWORD POLICY FOR PLATFORM ACCOUNTS
 * =========================================
 * The register route enforced 12+ characters with a symbol while the signup
 * page checked 8+ and no symbol, so the page accepted passwords the server
 * then refused. These pin the single policy both now share, and that every
 * page taking a new platform password uses it rather than a copy.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_HINT,
  validatePasswordStrength,
} from '@/lib/auth/password-policy'
import { validatePasswordStrength as serverValidate } from '@/lib/auth/password'

const STRONG = 'Operator1234!'

describe('the policy', () => {
  test('accepts a password meeting every rule', () => {
    expect(validatePasswordStrength(STRONG)).toEqual({ valid: true })
  })

  test('refuses what the old signup page accepted: no symbol', () => {
    // Twelve characters, upper, lower and a number. The page let this through
    // and the route answered 400, after the operator had already submitted.
    const r = validatePasswordStrength('Operator1234')
    expect(r.valid).toBe(false)
    expect(r.message).toMatch(/special character/)
  })

  test('draws the length line where it says it does', () => {
    const body = 'Aa1!'
    const pad = (n: number) => body + 'x'.repeat(n - body.length)
    expect(validatePasswordStrength(pad(PASSWORD_MIN_LENGTH - 1)).valid).toBe(false)
    expect(validatePasswordStrength(pad(PASSWORD_MIN_LENGTH)).valid).toBe(true)
  })

  test.each([
    ['operator1234!', /uppercase/],
    ['OPERATOR1234!', /lowercase/],
    ['Operatorabcd!', /number/],
  ])('names the missing class in %s', (password, message) => {
    const r = validatePasswordStrength(password)
    expect(r.valid).toBe(false)
    expect(r.message).toMatch(message)
  })

  test('counts a backslash as a symbol', () => {
    expect(validatePasswordStrength('Operator1234' + String.fromCharCode(92)).valid).toBe(true)
  })

  test('the hint states the length that is enforced', () => {
    expect(PASSWORD_POLICY_HINT).toContain(`${PASSWORD_MIN_LENGTH}+`)
  })
})

describe('one policy, not copies', () => {
  test('the server check is this function', () => {
    expect(serverValidate).toBe(validatePasswordStrength)
  })

  test.each([
    'app/auth/signup/page.tsx',
    // Where a new password is chosen after an emailed reset code.
    // app/auth/reset-password only redirects here now.
    'app/auth/forgot-password/page.tsx',
  ])('%s checks passwords with the shared policy', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    expect(source).toContain("from '@/lib/auth/password-policy'")
    expect(source).toContain('validatePasswordStrength(')
    // The copies this replaced each carried their own length.
    expect(source).not.toMatch(/length\s*<\s*\d+/)
  })
})
