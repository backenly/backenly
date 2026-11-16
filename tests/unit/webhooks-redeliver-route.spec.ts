/**
 * POST /api/projects/[id]/webhooks/[webhookId]/logs/[logId]/redeliver: the
 * console's "Send again" on a delivery that failed or gave up (project console
 * rebuild, 2026-11-16, Logic backend change 3).
 *
 *   - the floor is the test route's: a VIEWER is refused, a DEVELOPER may,
 *     and a plan without webhooks refuses it (sending again is a change);
 *   - both path ids reach the lookup, so a delivery of another endpoint or
 *     another project is a 404, never sent;
 *   - the answer is the result: the receiver's status code and the new log
 *     id, or the service's own reason for refusing, as a 409.
 *
 * Database-free: the project checks and the plan are stubbed per case, the
 * route's service call is recorded, and the service's lookup runs against a
 * stubbed prisma that only records its query.
 */

type Access = { read: boolean; write: boolean; admin: boolean }
let access: Access = { read: true, write: true, admin: true }
let plan: { allowed: true } | { allowed: false; currentPlan: string; requiredPlan: 'PRO' } = { allowed: true }

jest.mock('@/lib/auth/route-protection', () => ({
  withAuth: (handler: any) => async (request: any, ctx: any = {}) => handler(request, { user: { userId: 'u_member' }, params: ctx.params }),
}))
jest.mock('@/lib/edition/guard', () => ({
  canAccessProject: async () => access.read,
  canWriteProject: async () => access.write,
  canAdministerProject: async () => access.admin,
}))
jest.mock('@/lib/webhooks/plan', () => ({ webhookPlan: async () => plan }))

const redeliver = jest.fn()
jest.mock('@/lib/webhooks', () => ({ redeliverWebhookLog: (...args: unknown[]) => redeliver(...args) }))

const findFirst = jest.fn()
jest.mock('@/lib/db/prisma', () => ({ prisma: { webhookLog: { findFirst: (...args: unknown[]) => findFirst(...args) } } }))

import { POST } from '@/app/api/projects/[id]/webhooks/[webhookId]/logs/[logId]/redeliver/route'

const post = (ids = { id: 'p1', webhookId: 'w1', logId: 'l1' }) =>
  POST({ method: 'POST', url: `http://localhost/api/projects/${ids.id}/webhooks/${ids.webhookId}/logs/${ids.logId}/redeliver` } as any, {
    params: Promise.resolve(ids),
  })

beforeEach(() => {
  access = { read: true, write: true, admin: true }
  plan = { allowed: true }
  redeliver.mockReset()
  findFirst.mockReset()
})

describe('who may send a delivery again', () => {
  it('refuses a viewer as the test route does, without sending anything', async () => {
    access = { read: true, write: false, admin: false }
    const res = await post()
    expect(res.status).toBe(404)
    expect(redeliver).not.toHaveBeenCalled()
  })

  it('refuses a project the caller cannot reach with the same 404', async () => {
    access = { read: false, write: false, admin: false }
    const res = await post()
    expect(res.status).toBe(404)
    expect(redeliver).not.toHaveBeenCalled()
  })

  it('refuses on a plan without webhooks, saying so', async () => {
    plan = { allowed: false, currentPlan: 'SANDBOX', requiredPlan: 'PRO' }
    const res = await post()
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('PLAN_LIMIT_EXCEEDED')
    expect(redeliver).not.toHaveBeenCalled()
  })

  it('lets a developer send it again (admin is not needed)', async () => {
    access = { read: true, write: true, admin: false }
    redeliver.mockResolvedValue({ replayOf: 'l1', logId: 'l2', success: true, statusCode: 200 })
    const res = await post()
    expect(res.status).toBe(200)
    expect(redeliver).toHaveBeenCalledWith('p1', 'l1', 'w1')
  })
})

describe('what the answer says', () => {
  it('passes on the receiver’s answer and the new delivery’s id', async () => {
    redeliver.mockResolvedValue({ replayOf: 'l1', logId: 'l2', success: false, statusCode: 503, error: 'HTTP 503' })
    const body = await (await post()).json()
    expect(body).toEqual({ success: false, statusCode: 503, error: 'HTTP 503', blocked: false, logId: 'l2', replayOf: 'l1' })
  })

  it('says why a delivery cannot be sent again, as a 409', async () => {
    redeliver.mockResolvedValue({ refused: 'it was delivered; sending it again would deliver the event twice', status: 'SUCCESS' })
    const res = await post()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'Not sent again: it was delivered; sending it again would deliver the event twice.',
      code: 'NOT_REPLAYABLE',
      status: 'SUCCESS',
    })
  })

  it('answers 404 for a delivery the service does not find', async () => {
    redeliver.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(404)
  })
})

describe('the lookup is scoped by both ids', () => {
  const { redeliverWebhookLog } = jest.requireActual('@/lib/webhooks') as typeof import('@/lib/webhooks')

  it('asks for the delivery under this endpoint and this project', async () => {
    findFirst.mockResolvedValue(null)
    expect(await redeliverWebhookLog('p1', 'l1', 'w1')).toBeNull()
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'l1', webhookId: 'w1', webhook: { projectId: 'p1' } },
      include: { webhook: true },
    })
  })

  it('keeps the agent’s two-id call scoped by project', async () => {
    findFirst.mockResolvedValue(null)
    await redeliverWebhookLog('p1', 'l1')
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'l1', webhook: { projectId: 'p1' } }, include: { webhook: true } })
  })

  it('refuses a delivery that was delivered, before sending anything', async () => {
    findFirst.mockResolvedValue({ id: 'l1', status: 'SUCCESS', payload: {}, webhook: { active: true } })
    expect(await redeliverWebhookLog('p1', 'l1', 'w1')).toEqual({
      refused: 'it was delivered; sending it again would deliver the event twice',
      status: 'SUCCESS',
    })
  })
})
