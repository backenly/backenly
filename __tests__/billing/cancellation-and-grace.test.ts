/**
 * CANCELLING IS NOT A FAILED PAYMENT
 * ==================================
 * One function, `initiateGracePeriod`, served both, so the two lifecycles were
 * literally the same local state. A customer who cancelled had their paid plan
 * replaced by a seven-day window that had nothing to do with the period they
 * had paid for — cancel on day 1 of 30 and access ended on day 8, losing 22
 * days they had already been charged for — and they were emailed
 * "We couldn't process your payment" about a payment that never failed.
 *
 * The terminal event made it worse rather than better. Paddle sends
 * subscription.canceled when access actually ends, and the handler called
 * initiateGracePeriod again, which would have granted a *further* seven days of
 * a paid plan. It only failed to because that function matched ACTIVE|PAST_DUE
 * rows and the subscription was already GRACE — so the event that is supposed
 * to end the subscription silently matched zero rows and did nothing at all.
 *
 * The split asserted here:
 *
 *   voluntary cancel  → status stays ACTIVE, cancelScheduledAt mirrors Paddle,
 *                       graceUntil untouched, entitlement runs to period end
 *   payment failure   → status GRACE + graceUntil, our recovery policy
 *
 * Real database, because the defects live in `where` clauses and enum columns:
 * the zero-row updateMany above is invisible to any mock that does not model
 * the filter.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'

// ─── Provider SDK ────────────────────────────────────────────────────────────
// Stubbed so the tests drive webhook payloads and cancellation outcomes
// directly. Signature verification is exercised separately below by asserting
// the route still rejects an unsigned request.
const mockUnmarshal = jest.fn()
const mockPaddleCancel = jest.fn()

jest.mock('@paddle/paddle-node-sdk', () => ({
  Paddle: class {
    webhooks = { unmarshal: (...a: any[]) => mockUnmarshal(...a) }
    subscriptions = { cancel: (...a: any[]) => mockPaddleCancel(...a) }
  },
  Environment: { production: 'production', sandbox: 'sandbox' },
  EventName: {
    SubscriptionCreated: 'subscription.created',
    SubscriptionUpdated: 'subscription.updated',
    SubscriptionCanceled: 'subscription.canceled',
    SubscriptionPastDue: 'subscription.past_due',
    SubscriptionActivated: 'subscription.activated',
  },
}))

// ─── Notifications ───────────────────────────────────────────────────────────
// What the customer is told is part of the contract: a cancellation must never
// send a payment-failure notice.
const mockNotifyPaymentFailed = jest.fn()
const mockNotifyPaymentSuccess = jest.fn()
const mockNotifySubscriptionCanceled = jest.fn()

jest.mock('@/lib/notifications/platform', () => ({
  notifyPaymentFailed: (...a: any[]) => mockNotifyPaymentFailed(...a),
  notifyPaymentSuccess: (...a: any[]) => mockNotifyPaymentSuccess(...a),
  notifySubscriptionCanceled: (...a: any[]) => mockNotifySubscriptionCanceled(...a),
}))

// ─── Identity ────────────────────────────────────────────────────────────────
// withAuth stays real; only the identity source is stubbed.
let currentUserId = ''
jest.mock('@/lib/auth/server', () => ({
  ...jest.requireActual('@/lib/auth/server'),
  requireUser: () => Promise.resolve({ userId: currentUserId, email: 'billing@test.invalid', role: 'user' }),
}))

// ─── Admin auth ──────────────────────────────────────────────────────────────
// The founder gate is a separate concern with its own tests; these cases are
// about what the billing actions DO once past it.
let founderUserId = ''
jest.mock('@/lib/admin/auth/requireFounder', () => ({
  requireFounder: () => Promise.resolve(null),
}))
jest.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: () =>
    Promise.resolve({ authenticated: true, userId: founderUserId, userEmail: 'founder@test.invalid' }),
}))

// Required after the mocks so the modules under test pick them up.
const { POST: cancelRoute } = require('@/app/api/billing/cancel/route')
const { POST: webhookRoute } = require('@/app/api/billing/webhook/route')
const { POST: checkoutRoute } = require('@/app/api/billing/create-checkout/route')
const { POST: adminBillingRoute } = require('@/app/api/admin/billing-actions/route')
const { processExpiredGracePeriods, PAYMENT_GRACE_DAYS } = require('@/lib/billing/grace')
const { getUserSubscription } = require('@/lib/billing')

const DB_URL = process.env.TEST_DATABASE_URL ?? ''
const createdUserIds: string[] = []
const createdPlanIds: string[] = []

/**
 * Cleanup is scoped to this file's own rows because suites run in parallel
 * against one database.
 */
function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const DAY = 24 * 60 * 60 * 1000

/** Minimal stand-in for the parts of NextRequest these routes actually use. */
function req(body: unknown, headers: Record<string, string> = {}): any {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => raw,
    json: async () => JSON.parse(raw),
  }
}

/** Deliver a signed provider event through the real webhook route. */
async function deliverEvent(eventType: string, data: any, eventId = `evt_${randomUUID()}`) {
  mockUnmarshal.mockReturnValueOnce({ eventId, eventType, data })
  return webhookRoute(req({}, { 'paddle-signature': 'ts=1;h1=stub' }))
}

async function makePaidPlan(): Promise<{ id: string; name: string }> {
  const plan = await prisma.plan.create({
    data: { name: `TESTPAID_${randomUUID().slice(0, 8)}`, priceCents: 2500, allowDeployment: true },
    select: { id: true, name: true },
  })
  createdPlanIds.push(plan.id)
  return plan
}

async function makeSubscribedUser(overrides: Record<string, any> = {}) {
  const user = await prisma.user.create({
    data: { email: `billing-${randomUUID()}@test.invalid`, name: 'Billing Test' },
    select: { id: true },
  })
  createdUserIds.push(user.id)

  const plan = await makePaidPlan()
  const paddleSubscriptionId = `sub_${randomUUID().slice(0, 12)}`

  const subscription = await prisma.subscription.create({
    data: {
      userId: user.id,
      planId: plan.id,
      paddleSubscriptionId,
      status: 'ACTIVE',
      currentPeriodEnd: new Date(Date.now() + 22 * DAY),
      ...overrides,
    },
  })

  return { user, plan, subscription, paddleSubscriptionId }
}

const reload = (id: string) => prisma.subscription.findUnique({ where: { id } })

beforeAll(async () => {
  assertSafeTestDatabase()
  // A real row: the admin actions write an AuditLog with a userId foreign key,
  // so a fabricated actor id fails the constraint rather than the assertion.
  const founder = await prisma.user.create({
    data: { email: `founder-${randomUUID()}@test.invalid`, name: 'Founder Test' },
    select: { id: true },
  })
  founderUserId = founder.id
  createdUserIds.push(founder.id)

  // Idempotent: creates SANDBOX if this database has never been seeded, and
  // leaves an existing row untouched so parallel suites are unaffected.
  await prisma.plan.upsert({
    where: { name: 'SANDBOX' },
    update: {},
    create: { name: 'SANDBOX', priceCents: 0, maxProjects: 1, allowDeployment: false, isSandboxPlan: false },
  })

  // BUILDER, on the same terms, because the checkout guard cases post
  // { plan: 'BUILDER' } and create-checkout resolves the plan row BEFORE it
  // reaches the duplicate-subscription guard. With no such row the route
  // answers 404 'Plan not found' and the 409 assertions fail, which is what
  // happened the first time this suite ran on CI against an empty database.
  //
  // Seeding it from prisma/seed-billing.ts in the workflow would also have made
  // the job pass, and would have been wrong twice over: it makes a self-contained
  // suite depend on ambient product data, and this suite passed locally only
  // because the developer database happened to hold plans from earlier work.
  // Every other row here is built by the suite; this one was the exception.
  await prisma.plan.upsert({
    where: { name: 'BUILDER' },
    update: {},
    create: { name: 'BUILDER', priceCents: 2500, allowDeployment: true },
  })
})

beforeEach(() => {
  jest.clearAllMocks()
  // Every notification call site is fire-and-forget with `.catch()` attached,
  // so these must return real promises or the route throws on the happy path.
  mockNotifyPaymentFailed.mockResolvedValue(undefined)
  mockNotifyPaymentSuccess.mockResolvedValue(undefined)
  mockNotifySubscriptionCanceled.mockResolvedValue(undefined)
  process.env.PADDLE_API_KEY = 'test-key-not-a-real-credential'
  process.env.PADDLE_WEBHOOK_SECRET = 'test-secret-not-a-real-credential'
})

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.subscription.deleteMany({ where: { userId: { in: createdUserIds } } })
    await prisma.auditLog.deleteMany({ where: { userId: { in: createdUserIds } } })
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
  if (createdPlanIds.length) {
    await prisma.plan.deleteMany({ where: { id: { in: createdPlanIds } } })
  }
})

// ============================================================================
// VOLUNTARY CANCELLATION
// ============================================================================

describe('voluntary cancellation', () => {
  it('asks the provider to cancel at the next billing period', async () => {
    const { user, subscription, paddleSubscriptionId } = await makeSubscribedUser()
    currentUserId = user.id
    const effectiveAt = new Date(Date.now() + 22 * DAY)
    mockPaddleCancel.mockResolvedValue({ scheduledChange: { action: 'cancel', effectiveAt: effectiveAt.toISOString() } })

    const res = await cancelRoute(req({}))

    expect(res.status).toBe(200)
    expect(mockPaddleCancel).toHaveBeenCalledWith(paddleSubscriptionId, { effectiveFrom: 'next_billing_period' })
    expect((await reload(subscription.id))!.status).toBe('ACTIVE')
  })

  it('stores the provider effectiveAt verbatim, not now + 7 days', async () => {
    const { user, subscription } = await makeSubscribedUser()
    currentUserId = user.id
    // Deliberately far from any local seven-day arithmetic.
    const effectiveAt = new Date(Date.now() + 22 * DAY)
    mockPaddleCancel.mockResolvedValue({ scheduledChange: { action: 'cancel', effectiveAt: effectiveAt.toISOString() } })

    await cancelRoute(req({}))

    const after = await reload(subscription.id)
    expect(after!.cancelScheduledAt!.toISOString()).toBe(effectiveAt.toISOString())

    const localSevenDays = new Date(Date.now() + PAYMENT_GRACE_DAYS * DAY)
    expect(Math.abs(after!.cancelScheduledAt!.getTime() - localSevenDays.getTime())).toBeGreaterThan(10 * DAY)
  })

  it('never opens a payment-failure grace window', async () => {
    const { user, subscription } = await makeSubscribedUser()
    currentUserId = user.id
    mockPaddleCancel.mockResolvedValue({
      scheduledChange: { action: 'cancel', effectiveAt: new Date(Date.now() + 22 * DAY).toISOString() },
    })

    await cancelRoute(req({}))

    const after = await reload(subscription.id)
    expect(after!.status).toBe('ACTIVE')
    expect(after!.graceUntil).toBeNull()
  })

  it('never sends a payment-failure notification', async () => {
    const { user } = await makeSubscribedUser()
    currentUserId = user.id
    mockPaddleCancel.mockResolvedValue({
      scheduledChange: { action: 'cancel', effectiveAt: new Date(Date.now() + 22 * DAY).toISOString() },
    })

    await cancelRoute(req({}))

    expect(mockNotifyPaymentFailed).not.toHaveBeenCalled()
    expect(mockNotifySubscriptionCanceled).toHaveBeenCalled()
  })

  it('writes nothing locally when the provider call fails', async () => {
    const { user, subscription } = await makeSubscribedUser()
    currentUserId = user.id
    mockPaddleCancel.mockRejectedValue(new Error('provider unavailable'))

    const res = await cancelRoute(req({}))

    expect(res.status).toBe(500)
    const after = await reload(subscription.id)
    expect(after!.status).toBe('ACTIVE')
    expect(after!.cancelScheduledAt).toBeNull()
    expect(after!.graceUntil).toBeNull()
  })

})

// ============================================================================
// cancelScheduledAt IS A PROVIDER STATEMENT, NOT AN INFERENCE
// ============================================================================
//
// The field means one thing: a date Paddle said a cancellation takes effect.
// An earlier revision of this commit let it fall back to
// currentBillingPeriod.endsAt and then to the stored currentPeriodEnd, which
// quietly reintroduced the original defect in a new place — a renewal date
// stored under a cancellation name is a second billing clock, and the stored
// currentPeriodEnd can itself be a locally computed 30 days
// (handleSubscriptionCreated still falls back that way when Paddle omits the
// billing period). These tests pin the field to explicit provider statements.

describe('cancelScheduledAt provenance', () => {
  it('stores the provider effectiveAt exactly', async () => {
    const { user, subscription } = await makeSubscribedUser()
    currentUserId = user.id
    const effectiveAt = new Date(Date.now() + 22 * DAY)
    mockPaddleCancel.mockResolvedValue({
      scheduledChange: { action: 'cancel', effectiveAt: effectiveAt.toISOString() },
    })

    await cancelRoute(req({}))

    const after = await reload(subscription.id)
    expect(after!.cancelScheduledAt!.toISOString()).toBe(effectiveAt.toISOString())
    expect(after!.cancelScheduledAt!.getTime()).toBe(effectiveAt.getTime())
  })

  it('stores nothing when the provider accepts the cancel without an effective date', async () => {
    const { user, subscription } = await makeSubscribedUser()
    currentUserId = user.id
    mockPaddleCancel.mockResolvedValue({})

    const res = await cancelRoute(req({}))

    // Accepted by the provider — this is NOT a failure path.
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)

    const after = await reload(subscription.id)
    expect(after!.cancelScheduledAt).toBeNull()
    expect(after!.status).toBe('ACTIVE')
    expect(after!.graceUntil).toBeNull()
    expect(mockNotifyPaymentFailed).not.toHaveBeenCalled()
  })

  it('does not populate from currentBillingPeriod.endsAt', async () => {
    const { user, subscription } = await makeSubscribedUser()
    currentUserId = user.id
    const renewal = new Date(Date.now() + 22 * DAY)
    // A renewal date, offered with no scheduled change. Not a cancellation date.
    mockPaddleCancel.mockResolvedValue({ currentBillingPeriod: { endsAt: renewal.toISOString() } })

    await cancelRoute(req({}))

    expect((await reload(subscription.id))!.cancelScheduledAt).toBeNull()
  })

  it('does not populate from the stored currentPeriodEnd', async () => {
    const { user, subscription } = await makeSubscribedUser()
    currentUserId = user.id
    expect(subscription.currentPeriodEnd).not.toBeNull() // the tempting fallback exists
    mockPaddleCancel.mockResolvedValue({})

    await cancelRoute(req({}))

    expect((await reload(subscription.id))!.cancelScheduledAt).toBeNull()
  })

  it('never lets a locally computed date reach the field', async () => {
    const { user, subscription } = await makeSubscribedUser()
    currentUserId = user.id
    // Every shape that previously produced a date, none of them a cancellation
    // statement — including the 30-day value handleSubscriptionCreated invents.
    const localThirty = new Date(Date.now() + 30 * DAY)
    mockPaddleCancel.mockResolvedValue({
      currentBillingPeriod: { endsAt: localThirty.toISOString() },
      scheduledChange: { action: 'pause', effectiveAt: localThirty.toISOString() },
    })

    await cancelRoute(req({}))

    expect((await reload(subscription.id))!.cancelScheduledAt).toBeNull()
  })

  it('is filled in later by the provider update that carries the real date', async () => {
    const { user, subscription, paddleSubscriptionId } = await makeSubscribedUser()
    currentUserId = user.id
    mockPaddleCancel.mockResolvedValue({})
    await cancelRoute(req({}))
    expect((await reload(subscription.id))!.cancelScheduledAt).toBeNull()

    const effectiveAt = new Date(Date.now() + 19 * DAY)
    await deliverEvent('subscription.updated', {
      id: paddleSubscriptionId,
      status: 'active',
      scheduledChange: { action: 'cancel', effectiveAt: effectiveAt.toISOString() },
    })

    const after = await reload(subscription.id)
    expect(after!.cancelScheduledAt!.toISOString()).toBe(effectiveAt.toISOString())
    expect(after!.status).toBe('ACTIVE')
  })

  it('ignores a scheduled cancel that carries no date, rather than inventing one', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser()

    await deliverEvent('subscription.updated', {
      id: paddleSubscriptionId,
      status: 'active',
      scheduledChange: { action: 'cancel' },
    })

    expect((await reload(subscription.id))!.cancelScheduledAt).toBeNull()
  })

  it('leaves an existing value alone when a payload says nothing about scheduled changes', async () => {
    const effectiveAt = new Date(Date.now() + 15 * DAY)
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser({
      cancelScheduledAt: effectiveAt,
    })

    // No scheduledChange key at all. Absence is not the provider saying "none";
    // the SDK normalises a real absence to null, which is handled separately.
    await deliverEvent('subscription.updated', { id: paddleSubscriptionId, status: 'active' })

    expect((await reload(subscription.id))!.cancelScheduledAt!.toISOString()).toBe(effectiveAt.toISOString())
  })

  it('does not manufacture a date on payment recovery', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser({
      status: 'GRACE',
      graceUntil: new Date(Date.now() + 3 * DAY),
    })

    await deliverEvent('subscription.activated', {
      id: paddleSubscriptionId,
      currentBillingPeriod: { endsAt: new Date(Date.now() + 30 * DAY).toISOString() },
      scheduledChange: null,
    })

    const after = await reload(subscription.id)
    expect(after!.cancelScheduledAt).toBeNull()
    expect(after!.status).toBe('ACTIVE')
  })
})

// ============================================================================
// PROVIDER-DRIVEN LIFECYCLE
// ============================================================================

describe('provider-scheduled cancellation', () => {
  it('is persisted from subscription.updated, so portal cancellations are seen', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser()
    const effectiveAt = new Date(Date.now() + 15 * DAY)

    await deliverEvent('subscription.updated', {
      id: paddleSubscriptionId,
      status: 'active',
      scheduledChange: { action: 'cancel', effectiveAt: effectiveAt.toISOString() },
    })

    const after = await reload(subscription.id)
    expect(after!.status).toBe('ACTIVE')
    expect(after!.cancelScheduledAt!.toISOString()).toBe(effectiveAt.toISOString())
  })

  it('is cleared when the provider reports the cancellation reversed', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser({
      cancelScheduledAt: new Date(Date.now() + 15 * DAY),
    })

    await deliverEvent('subscription.updated', {
      id: paddleSubscriptionId,
      status: 'active',
      scheduledChange: null,
    })

    const after = await reload(subscription.id)
    expect(after!.cancelScheduledAt).toBeNull()
    expect(after!.status).toBe('ACTIVE')
  })

  it('ignores pause and resume scheduled changes rather than reading them as cancellations', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser()

    await deliverEvent('subscription.updated', {
      id: paddleSubscriptionId,
      status: 'active',
      scheduledChange: { action: 'pause', effectiveAt: new Date(Date.now() + 5 * DAY).toISOString() },
    })

    expect((await reload(subscription.id))!.cancelScheduledAt).toBeNull()
  })
})

describe('terminal cancellation', () => {
  it('moves an active paid subscription to the canonical free plan with no intermediate grace', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser({
      cancelScheduledAt: new Date(Date.now() - 1000),
    })
    const sandbox = await prisma.plan.findUnique({ where: { name: 'SANDBOX' } })

    await deliverEvent('subscription.canceled', { id: paddleSubscriptionId, status: 'canceled' })

    const after = await reload(subscription.id)
    expect(after!.status).toBe('FREE')
    expect(after!.planId).toBe(sandbox!.id)
    expect(after!.graceUntil).toBeNull()
    expect(after!.cancelScheduledAt).toBeNull()
    // The old handler granted a further seven days here.
    expect(mockNotifyPaymentFailed).not.toHaveBeenCalled()
  })

  it('is idempotent — a duplicated terminal event does not re-apply', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser()

    await deliverEvent('subscription.canceled', { id: paddleSubscriptionId, status: 'canceled' })
    const firstPass = await reload(subscription.id)

    mockNotifySubscriptionCanceled.mockClear()
    await deliverEvent('subscription.canceled', { id: paddleSubscriptionId, status: 'canceled' })
    const secondPass = await reload(subscription.id)

    expect(secondPass!.status).toBe('FREE')
    expect(secondPass!.planId).toBe(firstPass!.planId)
    expect(secondPass!.updatedAt.toISOString()).toBe(firstPass!.updatedAt.toISOString())
    expect(mockNotifySubscriptionCanceled).not.toHaveBeenCalled()
  })

  it('is reached even when the terminal state arrives on subscription.updated instead', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser()

    await deliverEvent('subscription.updated', { id: paddleSubscriptionId, status: 'canceled' })

    expect((await reload(subscription.id))!.status).toBe('FREE')
  })

  it('replays of the same provider event id are skipped entirely', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser()
    const eventId = `evt_${randomUUID()}`

    await deliverEvent('subscription.canceled', { id: paddleSubscriptionId, status: 'canceled' }, eventId)

    // Put the subscription back on a paid plan, then replay the same event id.
    const plan = await makePaidPlan()
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { planId: plan.id, status: 'ACTIVE' },
    })

    const res = await deliverEvent('subscription.canceled', { id: paddleSubscriptionId, status: 'canceled' }, eventId)

    expect(await res.json()).toMatchObject({ idempotent: true })
    expect((await reload(subscription.id))!.status).toBe('ACTIVE')

    await prisma.processedWebhookEvent.deleteMany({ where: { id: eventId } })
  })
})

// ============================================================================
// PAYMENT FAILURE
// ============================================================================

describe('failed payment', () => {
  it('opens the recovery window in a single write, without a transient PAST_DUE', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser()
    const before = Date.now()

    await deliverEvent('subscription.past_due', { id: paddleSubscriptionId, status: 'past_due' })

    const after = await reload(subscription.id)
    expect(after!.status).toBe('GRACE')
    const expected = before + PAYMENT_GRACE_DAYS * DAY
    expect(Math.abs(after!.graceUntil!.getTime() - expected)).toBeLessThan(60_000)
  })

  it('sends the payment-failure notification with the stored deadline', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser()

    await deliverEvent('subscription.past_due', { id: paddleSubscriptionId, status: 'past_due' })

    expect(mockNotifyPaymentFailed).toHaveBeenCalledTimes(1)
    const passed: Date = mockNotifyPaymentFailed.mock.calls[0][1]
    expect(passed.toISOString()).toBe((await reload(subscription.id))!.graceUntil!.toISOString())
  })

  it('never sets a scheduled cancellation', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser()

    await deliverEvent('subscription.past_due', { id: paddleSubscriptionId, status: 'past_due' })

    expect((await reload(subscription.id))!.cancelScheduledAt).toBeNull()
  })

  it('survives a trailing subscription.updated that repeats past_due', async () => {
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser()

    await deliverEvent('subscription.past_due', { id: paddleSubscriptionId, status: 'past_due' })
    const opened = await reload(subscription.id)

    // Paddle sends subscription.updated alongside lifecycle events, so it can
    // land after the window is open. PAST_DUE is not in the entitlement filter,
    // so writing it here would revoke access in the middle of the recovery
    // window we just promised the customer.
    await deliverEvent('subscription.updated', { id: paddleSubscriptionId, status: 'past_due' })

    const after = await reload(subscription.id)
    expect(after!.status).toBe('GRACE')
    expect(after!.graceUntil!.toISOString()).toBe(opened!.graceUntil!.toISOString())
  })
})

describe('payment recovery', () => {
  it('clears the recovery window and keeps paid access', async () => {
    const { subscription, paddleSubscriptionId, plan } = await makeSubscribedUser({
      status: 'GRACE',
      graceUntil: new Date(Date.now() + 3 * DAY),
    })

    await deliverEvent('subscription.activated', {
      id: paddleSubscriptionId,
      currentBillingPeriod: { endsAt: new Date(Date.now() + 30 * DAY).toISOString() },
      scheduledChange: null,
    })

    const after = await reload(subscription.id)
    expect(after!.status).toBe('ACTIVE')
    expect(after!.graceUntil).toBeNull()
    expect(after!.planId).toBe(plan.id)
  })

  it('does not erase a still-valid scheduled cancellation', async () => {
    const effectiveAt = new Date(Date.now() + 12 * DAY)
    const { subscription, paddleSubscriptionId } = await makeSubscribedUser({
      status: 'GRACE',
      graceUntil: new Date(Date.now() + 3 * DAY),
      cancelScheduledAt: effectiveAt,
    })

    // Payment recovers while the cancellation is still scheduled — the provider
    // says so on this very payload, so the handler must believe the payload
    // rather than assume activation means "not cancelling".
    await deliverEvent('subscription.activated', {
      id: paddleSubscriptionId,
      currentBillingPeriod: { endsAt: new Date(Date.now() + 30 * DAY).toISOString() },
      scheduledChange: { action: 'cancel', effectiveAt: effectiveAt.toISOString() },
    })

    const after = await reload(subscription.id)
    expect(after!.status).toBe('ACTIVE')
    expect(after!.graceUntil).toBeNull()
    expect(after!.cancelScheduledAt!.toISOString()).toBe(effectiveAt.toISOString())
  })
})

// ============================================================================
// THE REGRESSION THIS COMMIT EXISTS FOR
// ============================================================================

describe('cancellation versus payment failure', () => {
  it('produces two different local lifecycles', async () => {
    const cancelled = await makeSubscribedUser()
    const failed = await makeSubscribedUser()

    currentUserId = cancelled.user.id
    mockPaddleCancel.mockResolvedValue({
      scheduledChange: { action: 'cancel', effectiveAt: new Date(Date.now() + 22 * DAY).toISOString() },
    })
    await cancelRoute(req({}))

    await deliverEvent('subscription.past_due', { id: failed.paddleSubscriptionId, status: 'past_due' })

    const c = await reload(cancelled.subscription.id)
    const f = await reload(failed.subscription.id)

    expect(c!.status).toBe('ACTIVE')
    expect(c!.graceUntil).toBeNull()
    expect(c!.cancelScheduledAt).not.toBeNull()

    expect(f!.status).toBe('GRACE')
    expect(f!.graceUntil).not.toBeNull()
    expect(f!.cancelScheduledAt).toBeNull()

    // The precise thing that was wrong: these were the same row shape.
    expect(c!.status).not.toBe(f!.status)
  })

  it('leaves a scheduled cancellation alone when the payment-grace cron runs', async () => {
    const { subscription } = await makeSubscribedUser({
      cancelScheduledAt: new Date(Date.now() - 5 * DAY), // already due
    })

    await processExpiredGracePeriods()

    // Only the provider's terminal event ends a subscription. The recovery cron
    // must not double as a cancellation clock.
    const after = await reload(subscription.id)
    expect(after!.status).toBe('ACTIVE')
    expect(after!.cancelScheduledAt).not.toBeNull()
  })

  it('downgrades an expired payment-grace subscription', async () => {
    const { subscription } = await makeSubscribedUser({
      status: 'GRACE',
      graceUntil: new Date(Date.now() - 1 * DAY),
    })
    const sandbox = await prisma.plan.findUnique({ where: { name: 'SANDBOX' } })

    await processExpiredGracePeriods()

    const after = await reload(subscription.id)
    expect(after!.status).toBe('FREE')
    expect(after!.planId).toBe(sandbox!.id)
    expect(after!.graceUntil).toBeNull()
  })

  it('leaves a payment-grace subscription that has not expired alone', async () => {
    const { subscription, plan } = await makeSubscribedUser({
      status: 'GRACE',
      graceUntil: new Date(Date.now() + 3 * DAY),
    })

    await processExpiredGracePeriods()

    const after = await reload(subscription.id)
    expect(after!.status).toBe('GRACE')
    expect(after!.planId).toBe(plan.id)
  })
})

// ============================================================================
// ENTITLEMENT
// ============================================================================

describe('entitlement', () => {
  it('keeps full paid access while a cancellation is scheduled', async () => {
    const { user, plan } = await makeSubscribedUser({
      cancelScheduledAt: new Date(Date.now() + 22 * DAY),
    })

    const sub = await getUserSubscription(user.id)

    // The whole reason a scheduled cancellation stays ACTIVE: the existing
    // entitlement filter keeps working untouched.
    expect(sub).not.toBeNull()
    expect(sub.plan.name).toBe(plan.name)
    expect(sub.status).toBe('ACTIVE')
  })

  it('keeps access during an unexpired payment-grace window', async () => {
    const { user, plan } = await makeSubscribedUser({
      status: 'GRACE',
      graceUntil: new Date(Date.now() + 3 * DAY),
    })

    const sub = await getUserSubscription(user.id)
    expect(sub.plan.name).toBe(plan.name)
  })

  it('resolves to the free plan once the provider has ended the subscription', async () => {
    const { user, paddleSubscriptionId } = await makeSubscribedUser()

    await deliverEvent('subscription.canceled', { id: paddleSubscriptionId, status: 'canceled' })

    const sub = await getUserSubscription(user.id)
    expect(sub.plan.name).toBe('SANDBOX')
    expect(sub.status).toBe('FREE')
  })
})

// ============================================================================
// CHECKOUT GUARD
// ============================================================================

describe('checkout guard', () => {
  it('still blocks a second checkout for an active unscheduled subscription', async () => {
    const { user } = await makeSubscribedUser()
    currentUserId = user.id

    const res = await checkoutRoute(req({ plan: 'BUILDER' }))
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe('ACTIVE_SUBSCRIPTION_EXISTS')
    expect(body).not.toHaveProperty('priceId')
    expect(body.error).toMatch(/Cancel your current plan/)
  })

  it('still blocks, but stops telling a cancelling customer to cancel again', async () => {
    const endsAt = new Date(Date.now() + 22 * DAY)
    const { user } = await makeSubscribedUser({ cancelScheduledAt: endsAt })
    currentUserId = user.id

    const res = await checkoutRoute(req({ plan: 'BUILDER' }))
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).not.toHaveProperty('priceId')
    expect(body.error).toMatch(/scheduled to end on/)
    expect(body.error).not.toMatch(/Cancel your current plan/)
    expect(body.cancelScheduledAt).toBe(endsAt.toISOString())
  })
})

// ============================================================================
// ADMIN
// ============================================================================

describe('admin billing actions', () => {
  it('uncomp actually moves the subscription onto the canonical free plan', async () => {
    const { user, subscription } = await makeSubscribedUser()
    currentUserId = user.id
    const sandbox = await prisma.plan.findUnique({ where: { name: 'SANDBOX' } })

    const res = await adminBillingRoute(req({ action: 'uncomp', userId: user.id }))

    // It used to report success while leaving the paid subscription in place.
    expect(res.status).toBe(200)
    const after = await reload(subscription.id)
    expect(after!.planId).toBe(sandbox!.id)
    expect(after!.status).toBe('FREE')
    expect(after!.cancelScheduledAt).toBeNull()
  })

  it('cancel schedules at period end rather than entering payment-failure grace', async () => {
    const { user, subscription, paddleSubscriptionId } = await makeSubscribedUser()
    currentUserId = user.id
    const effectiveAt = new Date(Date.now() + 22 * DAY)
    mockPaddleCancel.mockResolvedValue({ scheduledChange: { action: 'cancel', effectiveAt: effectiveAt.toISOString() } })

    const res = await adminBillingRoute(req({ action: 'cancel', userId: user.id }))

    expect(res.status).toBe(200)
    expect(mockPaddleCancel).toHaveBeenCalledWith(paddleSubscriptionId, { effectiveFrom: 'next_billing_period' })
    const after = await reload(subscription.id)
    expect(after!.status).toBe('ACTIVE')
    expect(after!.graceUntil).toBeNull()
    expect(after!.cancelScheduledAt!.toISOString()).toBe(effectiveAt.toISOString())
  })
})

// ============================================================================
// WEBHOOK SECURITY
// ============================================================================

describe('webhook verification is unchanged', () => {
  it('rejects a request with no signature header', async () => {
    const res = await webhookRoute(req({}))
    expect(res.status).toBe(401)
    expect(mockUnmarshal).not.toHaveBeenCalled()
  })

  it('rejects when the signing secret is not configured', async () => {
    delete process.env.PADDLE_WEBHOOK_SECRET
    const res = await webhookRoute(req({}, { 'paddle-signature': 'ts=1;h1=stub' }))
    expect(res.status).toBe(500)
    expect(mockUnmarshal).not.toHaveBeenCalled()
  })

  it('rejects a payload that fails verification', async () => {
    mockUnmarshal.mockImplementationOnce(() => { throw new Error('bad signature') })
    const res = await webhookRoute(req({}, { 'paddle-signature': 'ts=1;h1=wrong' }))
    expect(res.status).toBe(401)
  })
})
