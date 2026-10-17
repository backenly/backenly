/**
 * The web sign-in client (lib/api/auth.ts login) carries an authenticator code
 * and says why a sign-in was refused, so the login page can ask for the code
 * of an account with two-factor authentication and try again:
 *
 *   - a code given is sent as `totpCode`, the field POST /api/auth/login reads;
 *   - a refusal carries the server's code (TOTP_REQUIRED, TOTP_INVALID), not
 *     only its words;
 *   - a sign-in without a code sends none, as before.
 */

const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}

import { login, LoginError } from '@/lib/api/auth'

const sent: Array<Record<string, unknown>> = []
let answer: { status: number; body: unknown } = { status: 200, body: {} }

beforeEach(() => {
  sent.length = 0
  store.clear()
  ;(globalThis as any).fetch = jest.fn(async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body))
    return {
      ok: answer.status < 400,
      status: answer.status,
      json: async () => answer.body,
    }
  })
})

it('sends the authenticator code when it is given', async () => {
  answer = { status: 200, body: { token: 'session-token', user: { id: 'u1', email: 'a@example.test' } } }
  await login({ email: 'a@example.test', password: 'pw', totpCode: '123456' })
  expect(sent[0]).toEqual({ email: 'a@example.test', password: 'pw', totpCode: '123456' })
  expect(store.get('auth-token')).toBe('session-token')
})

it('sends no code when none is given', async () => {
  answer = { status: 200, body: { token: 't', user: { id: 'u1', email: 'a@example.test' } } }
  await login({ email: 'a@example.test', password: 'pw' })
  expect(sent[0]).toEqual({ email: 'a@example.test', password: 'pw' })
})

it.each(['TOTP_REQUIRED', 'TOTP_INVALID'])('surfaces %s as the refusal code', async (code) => {
  answer = { status: 401, body: { error: 'Two-factor authentication code required', code } }
  const refused = await login({ email: 'a@example.test', password: 'pw' }).catch((e) => e)
  expect(refused).toBeInstanceOf(LoginError)
  expect(refused.code).toBe(code)
  expect(store.get('auth-token')).toBeUndefined()
})

it('keeps a refusal without a code readable', async () => {
  answer = { status: 401, body: { error: 'Invalid email or password' } }
  const refused = await login({ email: 'a@example.test', password: 'wrong' }).catch((e) => e)
  expect(refused).toBeInstanceOf(LoginError)
  expect(refused.code).toBeNull()
  expect(refused.message).toBe('Invalid email or password')
})
