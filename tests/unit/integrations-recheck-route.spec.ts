/**
 * "Check again" on the Integrations page (POST /integrations/keys/recheck):
 * asks the provider about a stored key once more, behind the same floor and
 * the same per-person budget as checking a key before it is stored
 * (credentials/verify). Database-free: the project wrapper, the budget and the
 * key store are stubbed; the subject is the route's gate and its answer.
 */

const seen: { options: unknown[] } = { options: [] }
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: async (_req: unknown, handler: (v: { projectId: string; userId: string }) => unknown, options?: unknown) => {
    seen.options.push(options)
    return handler({ projectId: 'p1', userId: 'u1' })
  },
}))
const consume = jest.fn(async (_key: string, _limit: number, _windowMs: number) => ({ allowed: true }))
jest.mock('@/lib/security/auth-rate-limit', () => ({ consume: (k: string, l: number, w: number) => consume(k, l, w) }))
jest.mock('@/lib/security/rate-limit-decision', () => ({
  throttleDecision: () => ({ message: 'Too many key checks. Try again in 4 minutes.', code: 'RATE_LIMITED', status: 429, headers: { 'Retry-After': '240' } }),
}))
const recheck = jest.fn(async (_p: string, _id: string): Promise<unknown> => null)
jest.mock('@/lib/services/integrationKeyStore', () => ({ recheckIntegrationKey: (p: string, id: string) => recheck(p, id) }))

import { POST } from '@/app/api/projects/[id]/integrations/keys/recheck/route'

const post = (body: unknown): any => ({ json: async () => body, headers: new Headers(), method: 'POST', url: 'http://localhost/api/projects/p1/integrations/keys/recheck' })
const params = { params: Promise.resolve({ id: 'p1' }) }

beforeEach(() => {
  seen.options.length = 0
  consume.mockClear()
  recheck.mockReset()
  recheck.mockResolvedValue(null)
})

it('asks the provider again and answers the masked key with its verdict and when it was confirmed', async () => {
  recheck.mockResolvedValueOnce({
    integrationId: 'stripe',
    maskedKey: 'sk_live_••••4242',
    connectedAt: '2026-11-10T00:00:00.000Z',
    verification: 'verified',
    verificationDetail: 'Stripe accepted this key.',
    verifiedAt: '2026-11-16T08:00:00.000Z',
  })
  const res = await POST(post({ integrationId: 'Stripe' }), params)
  expect(res.status).toBe(200)
  expect(recheck).toHaveBeenCalledWith('p1', 'stripe')
  expect(await res.json()).toEqual({
    ok: true,
    key: expect.objectContaining({ maskedKey: 'sk_live_••••4242', verification: 'verified', verifiedAt: '2026-11-16T08:00:00.000Z' }),
  })
})

it('keeps the floor of checking a key before storing it: a developer and above', async () => {
  await POST(post({ integrationId: 'resend' }), params)
  expect(seen.options).toEqual([{ floor: 'write' }])
})

it('spends the same per-person budget as credentials/verify, and refuses past it without asking the provider', async () => {
  consume.mockResolvedValueOnce({ allowed: false })
  const res = await POST(post({ integrationId: 'resend' }), params)
  expect(consume).toHaveBeenCalledWith('integration-key-check:u1', 20, 600_000)
  expect(res.status).toBe(429)
  expect(recheck).not.toHaveBeenCalled()
})

it('says so when no key is stored, and refuses a malformed provider id', async () => {
  const none = await POST(post({ integrationId: 'twilio' }), params)
  expect(none.status).toBe(404)
  expect((await none.json()).error).toBe('No key is stored for this provider.')

  const bad = await POST(post({ integrationId: '../stripe' }), params)
  expect(bad.status).toBe(400)
  const missing = await POST(post({}), params)
  expect(missing.status).toBe(400)
  expect(recheck).toHaveBeenCalledTimes(1)
})
