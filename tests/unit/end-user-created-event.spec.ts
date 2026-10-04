/**
 * `auth.user.created` has one emitter, used by both signup servers (#147).
 *
 *  - The contract sweep signs up a synthetic `…@*.internal` user every minute.
 *    The Next route emitted this event for it, so a customer who subscribed
 *    would have received a fake sign-up every minute.
 *  - The Express runtime, which serves single-box installs, never emitted it.
 *  - The two answered success differently (200 and 201), and the probe expects
 *    201, so production's auth probe failed on every project.
 *
 * Only the webhook dispatcher is replaced: the property is whether, and with
 * what payload, the event is handed to it.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const triggerWebhooks = jest.fn()
jest.mock('@/lib/webhooks', () => ({ triggerWebhooks: (...a: unknown[]) => triggerWebhooks(...a) }))

import { emitEndUserCreated } from '@/lib/services/end-user-auth-events'

const ROOT = join(__dirname, '..', '..')
const NEXT_ROUTE = 'app/api/v1/[projectId]/auth/signup/route.ts'
const RUNTIME_ROUTE = 'server/routes/auth.ts'

beforeEach(() => {
  triggerWebhooks.mockReset()
  triggerWebhooks.mockResolvedValue(undefined)
})

describe('emitEndUserCreated', () => {
  it('never emits for the contract sweep’s synthetic account', async () => {
    await emitEndUserCreated('p1', { id: 'u1', email: '__cv_m1a2b3@backenly.internal' })
    await emitEndUserCreated('p1', { id: 'u2', email: 'probe@backenly-selftest.com' })
    expect(triggerWebhooks).not.toHaveBeenCalled()
  })

  it('emits for a real sign-up, with exactly the fixed fields', async () => {
    await emitEndUserCreated('p1', {
      id: 'u3',
      email: 'ada@example.com',
      name: 'Ada',
      created_at: '2026-09-29T00:00:00.000Z',
      // What the schema-tolerant INSERT may return, and must never be sent:
      password: '$2b$12$hash',
      password_hash: '$2b$12$hash',
    } as any)
    expect(triggerWebhooks).toHaveBeenCalledTimes(1)
    const [projectId, event, payload] = triggerWebhooks.mock.calls[0]
    expect(projectId).toBe('p1')
    expect(event).toBe('auth.user.created')
    expect(payload).toEqual({
      id: 'u3',
      email: 'ada@example.com',
      name: 'Ada',
      role: 'user',
      createdAt: '2026-09-29T00:00:00.000Z',
    })
  })

  it('never throws, even when delivery fails', async () => {
    triggerWebhooks.mockRejectedValue(new Error('receiver down'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(emitEndUserCreated('p1', { id: 'u4', email: 'bob@example.com' })).resolves.toBeUndefined()
    warn.mockRestore()
  })
})

describe('both signup servers', () => {
  it.each([NEXT_ROUTE, RUNTIME_ROUTE])('%s emits through the shared emitter only', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    expect(src).toMatch(/emitEndUserCreated\(projectId, user\)/)
    expect(src).not.toMatch(/'auth\.user\.created'/)
  })

  it('answer a successful sign-up with 201', () => {
    // A preview branch's sign-up adds `skippedOnBranch` after user and token.
    expect(readFileSync(join(ROOT, NEXT_ROUTE), 'utf8')).toMatch(
      /createSuccessResponse\(\s*\{ user, token\b[^\n]*\},\s*undefined,\s*201,?\s*\)/,
    )
    expect(readFileSync(join(ROOT, RUNTIME_ROUTE), 'utf8')).toMatch(
      /res\.status\(201\)\.json\(\{\s*data: \{ user, token\b/,
    )
  })
})
