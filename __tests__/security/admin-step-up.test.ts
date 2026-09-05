/**
 * Admin Step-Up ("sudo mode") Security Tests
 * =========================================
 * The second factor on every destructive admin endpoint. What must hold:
 *
 *   - a token only validates for the user it was minted for
 *   - a token stops validating once it expires
 *   - any tampering with the payload invalidates the signature
 *   - a request with no factor at all is refused with SUDO_REQUIRED, so the
 *     dashboard knows to prompt rather than showing a dead-end error
 *
 * The regression this guards: the gate used to demand an HMAC signature that
 * only a holder of ADMIN_SIGNING_SECRET could produce, which no browser can
 * be — so every admin write from the dashboard 401'd.
 */

import { describe, it, expect, beforeAll } from '@jest/globals'

process.env.ADMIN_SIGNING_SECRET = process.env.ADMIN_SIGNING_SECRET || 'test-admin-signing-secret'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  ADMIN_SUDO_COOKIE,
  mintAdminSudoToken,
  verifyAdminSudoToken,
  hasAdminSudo,
  requireAdminStepUp,
} = require('@/lib/admin/auth/adminStepUp')

const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const USER_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const PATH = '/api/admin/controls'

/**
 * jest.setup.js swaps the global Request/Headers for naive stubs, so a real
 * NextRequest cannot be constructed here. The gate only ever touches cookies,
 * headers, method, nextUrl and clone(), so a duck-typed stand-in exercises the
 * exact same code path without fighting the test environment.
 */
function fakeRequest(opts: { sudo?: string; headers?: Record<string, string>; method?: string } = {}): any {
  const headers = new Map(Object.entries(opts.headers ?? {}))
  const req: any = {
    method: opts.method ?? 'POST',
    nextUrl: { pathname: PATH },
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    cookies: { get: (k: string) => (k === ADMIN_SUDO_COOKIE && opts.sudo ? { value: opts.sudo } : undefined) },
  }
  req.clone = () => ({ arrayBuffer: async () => new ArrayBuffer(0) })
  return req
}

describe('Admin step-up tokens', () => {
  let token: string

  beforeAll(() => {
    const minted = mintAdminSudoToken(USER_A)
    expect(minted).not.toBeNull()
    token = minted.token
  })

  it('validates for the user it was minted for', () => {
    expect(verifyAdminSudoToken(token, USER_A)).toBe(true)
  })

  it('does NOT validate for a different admin', () => {
    expect(verifyAdminSudoToken(token, USER_B)).toBe(false)
  })

  it('rejects an expired token', () => {
    const expired = mintAdminSudoToken(USER_A, -1)
    expect(verifyAdminSudoToken(expired.token, USER_A)).toBe(false)
  })

  it('rejects a tampered expiry', () => {
    const [version, userId, exp, sig] = token.split('.')
    const stretched = [version, userId, String(Number(exp) + 86_400), sig].join('.')
    expect(verifyAdminSudoToken(stretched, USER_A)).toBe(false)
  })

  it('rejects a tampered signature', () => {
    const [version, userId, exp] = token.split('.')
    expect(verifyAdminSudoToken([version, userId, exp, 'de'.repeat(32)].join('.'), USER_A)).toBe(false)
  })

  it('rejects garbage and empty input', () => {
    expect(verifyAdminSudoToken('', USER_A)).toBe(false)
    expect(verifyAdminSudoToken(null, USER_A)).toBe(false)
    expect(verifyAdminSudoToken('not-a-token', USER_A)).toBe(false)
    expect(verifyAdminSudoToken('v1.x.y.z', USER_A)).toBe(false)
  })
})

describe('requireAdminStepUp', () => {
  it('lets a request with a valid sudo cookie through', async () => {
    const { token } = mintAdminSudoToken(USER_A)
    expect(hasAdminSudo(fakeRequest({ sudo: token }), USER_A)).toBe(true)
    expect(await requireAdminStepUp(fakeRequest({ sudo: token }), USER_A)).toBeNull()
  })

  it('refuses a request carrying no second factor with SUDO_REQUIRED', async () => {
    const response = await requireAdminStepUp(fakeRequest(), USER_A)
    expect(response).not.toBeNull()
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.code).toBe('SUDO_REQUIRED')
    expect(body.reauthPath).toBe('/api/admin/reauth')
  })

  it("refuses another admin's sudo cookie", async () => {
    const { token } = mintAdminSudoToken(USER_B)
    const response = await requireAdminStepUp(fakeRequest({ sudo: token }), USER_A)
    expect(response).not.toBeNull()
    expect(response.status).toBe(401)
  })

  it('falls through to the HMAC path only when signature headers are present', async () => {
    const response = await requireAdminStepUp(fakeRequest({
      headers: {
        'x-admin-signature': 'deadbeef',
        'x-admin-timestamp': String(Math.floor(Date.now() / 1000)),
      },
    }), USER_A)
    // Wrong signature — refused, but by the HMAC branch, not the sudo prompt.
    expect(response).not.toBeNull()
    const body = await response.json()
    expect(body.code).toBeUndefined()
    expect(body.error).toMatch(/signature/i)
  })
})
