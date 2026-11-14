/**
 * STRIPE'S BUILT-IN SYNC APPLIES EVENTS TO TABLES MADE BY create_table (#610)
 * ==========================================================================
 * The receiver's sync wrote `updated_at` and `cancel_at_period_end` to a
 * `subscriptions` table that has "updatedAt" and neither, `message` and
 * `created_at` to a `notifications` table that has `body` and "createdAt",
 * found orders by "stripeSessionId" where the blueprint has stripe_session_id,
 * and wrote `inactive` (and Stripe's `canceled`) where create_table's CHECK
 * allows `cancelled`. Each statement failed into `.catch(() => {})`, Stripe got
 * a 200, and a cancelled customer kept `status = 'active'`. It also read the
 * subscription period and an invoice's subscription where Stripe stopped
 * putting them in API version 2025-03-31.basil.
 *
 * Here the tables are made by the real create_table, Stripe's events (in the
 * basil shape) are signed with the project's stored secret and posted to the
 * real receiver, and the rows, the reply, payment_events and the project's
 * logs are read back. A table that cannot take a change is reported in the
 * project's logs, which the console's Logs tab reads (GET /api/logs).
 *
 * Real sessions, routes, executor, vault and database; no provider is called.
 */
import crypto, { randomUUID } from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { executeAction } from '@/lib/ai/minimal-executor'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { storeIntegrationKey } from '@/lib/services/integrationKeyStore'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

// Visibly synthetic, built at runtime so no key-shaped literal sits in the repository.
const SECRET = ['whsec', 'i610'.repeat(8)].join('_')
const RUN = randomUUID().slice(0, 8)
const SUB = `sub_i610_${RUN}`
const SESSION = `cs_i610_${RUN}`

let ownerId = ''
let token = ''
let projectId = '' // tables from create_table's blueprints, and the Stripe executor's payment_events
let unlinkedProjectId = '' // a subscriptions table with no column to find a Stripe subscription by
let endUserId = ''
const projectIds: string[] = []

const schemaOf = (id: string) => `workspace_${id}`
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
let eventCount = 0
const eventId = () => `evt_i610_${RUN}_${++eventCount}`

async function createTable(id: string, tableName: string, columns: unknown[]) {
  const result = await executeAction({ action: 'CREATE_TABLE', params: { tableName, columns } } as any, id, undefined, 0, undefined, false)
  if (!result.success) throw new Error(`create_table ${tableName}: ${result.error ?? result.message}`)
}

async function newProject(name: string): Promise<string> {
  const id = (await prisma.project.create({ data: { name, userId: ownerId }, select: { id: true } })).id
  projectIds.push(id)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaOf(id)}"`)
  await storeIntegrationKey(id, 'stripe_webhook_secret', SECRET)
  // A key into `users` is a key into the end-user table, as in a real project.
  await createTable(id, 'users', [{ name: 'email', type: 'TEXT' }])
  return id
}

/** Post an event to the receiver as Stripe does: signed with the endpoint's secret. */
async function deliver(id: string, event: { id: string; type: string; object: Record<string, unknown> }) {
  const body = JSON.stringify({ id: event.id, object: 'event', api_version: '2025-03-31.basil', type: event.type, data: { object: event.object } })
  const t = Math.floor(Date.now() / 1000)
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')
  const url = `http://localhost:3000/api/v1/${id}/webhooks/stripe`
  const request: any = {
    method: 'POST',
    url,
    nextUrl: new URL(url),
    headers: new Headers({ 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` }),
    cookies: { get: () => undefined },
    text: async () => body,
  }
  const { POST } = await import('@/app/api/v1/[projectId]/webhooks/[integration]/route')
  const res = await POST(request, { params: Promise.resolve({ projectId: id, integration: 'stripe' }) } as any)
  return { status: res.status, body: (await res.json()) as any }
}

const one = async <T = any>(sql: string, ...values: unknown[]): Promise<T> =>
  (await prisma.$queryRawUnsafe<T[]>(sql, ...values))[0]

const subscription = () =>
  one<{ status: string; current_period_end: Date | null; updatedAt: Date }>(
    `SELECT status, current_period_end, "updatedAt" FROM "${schemaOf(projectId)}".subscriptions WHERE stripe_subscription_id = $1`,
    SUB,
  )

const notifications = (type: string) =>
  prisma.$queryRawUnsafe<Array<{ user_id: string; title: string; body: string; createdAt: Date }>>(
    `SELECT user_id::text AS user_id, title, body, "createdAt" FROM "${schemaOf(projectId)}".notifications WHERE type = $1`,
    type,
  )

const recorded = (id: string, evt: string) =>
  one<{ event_type: string; processed: boolean; processed_at: Date | null; error: string | null }>(
    `SELECT event_type, processed, processed_at, error FROM "${schemaOf(id)}".payment_events WHERE stripe_event_id = $1`,
    evt,
  )

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  const email = `i610-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, name: 'Stripe Sync Suite' }, select: { id: true } })).id
  token = (await createSession(ownerId, email, 'user')).token

  // The tables as create_table makes them when asked for these names, and
  // payment_events as the Stripe connect makes it.
  projectId = await newProject('i610-create-table')
  for (const name of ['subscriptions', 'notifications', 'orders', 'credit_wallets']) await createTable(projectId, name, [])
  // Connecting Stripe adds this to an existing orders table (lib/integrations/stripe.executor.ts).
  const added = await executeAction(
    { action: 'ADD_COLUMN', params: { tableName: 'orders', columnName: 'stripe_payment_intent_id', columnType: 'TEXT' } } as any,
    projectId,
    undefined,
    0,
    undefined,
    false,
  )
  if (!added.success) throw new Error(`add_column: ${added.error ?? added.message}`)
  await createTable(projectId, 'payment_events', [
    { name: 'stripe_event_id', type: 'TEXT', notNull: true, unique: true },
    { name: 'event_type', type: 'TEXT', notNull: true },
    { name: 'payload', type: 'JSONB' },
    { name: 'processed', type: 'BOOLEAN', default: 'false' },
    { name: 'processed_at', type: 'TIMESTAMP' },
    { name: 'error', type: 'TEXT' },
  ])

  const s = schemaOf(projectId)
  endUserId = (await one<{ id: string }>(`INSERT INTO "${s}".users (email) VALUES ($1) RETURNING id::text AS id`, `buyer-${RUN}@example.test`)).id
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${s}".subscriptions (user_id, plan, status, stripe_subscription_id, current_period_end)
     VALUES ($1::uuid, 'pro', 'active', $2, '2026-01-01 00:00:00')`,
    endUserId,
    SUB,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${s}".orders (user_id, stripe_session_id, total_amount) VALUES ($1::uuid, $2, 49.00)`,
    endUserId,
    SESSION,
  )
  await prisma.$executeRawUnsafe(`INSERT INTO "${s}".credit_wallets (user_id, balance) VALUES ($1::uuid, 10)`, endUserId)

  // A subscriptions table someone described with their own columns: no
  // stripe_subscription_id or provider_subscription_id, and no payment_events.
  unlinkedProjectId = await newProject('i610-unlinked')
  await createTable(unlinkedProjectId, 'subscriptions', [
    { name: 'user_id', type: 'UUID' },
    { name: 'status', type: 'TEXT' },
    { name: 'stripe_ref', type: 'TEXT' },
  ])
}, 240_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  for (const id of projectIds) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaOf(id)}" CASCADE`).catch(() => {})
  await prisma.log.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.projectIntegrationKey.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe('subscription events, against the subscriptions table create_table makes', () => {
  it("customer.subscription.updated writes Stripe's status and the period from the subscription's items", async () => {
    const before = await subscription()
    const evt = eventId()
    const res = await deliver(projectId, {
      id: evt,
      type: 'customer.subscription.updated',
      object: {
        id: SUB,
        object: 'subscription',
        status: 'active',
        cancel_at_period_end: false,
        // From 2025-03-31.basil the period is on the items, not the subscription.
        items: { data: [{ current_period_start: at('2026-11-01T00:00:00Z'), current_period_end: at('2026-12-01T00:00:00Z') }] },
      },
    })

    expect(res.status).toBe(200)
    expect(res.body.sync.result).toBe('applied')
    expect(res.body.sync.notApplied).toEqual([])
    const row = await subscription()
    expect(row.status).toBe('active')
    expect(row.current_period_end!.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(row.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
    expect(await recorded(projectId, evt)).toMatchObject({ event_type: 'customer.subscription.updated', processed: true, error: null })
    expect((await recorded(projectId, evt)).processed_at).not.toBeNull()
  }, 120_000)

  it('invoice.payment_failed finds the subscription under parent.subscription_details, sets past_due, and tells the user', async () => {
    const res = await deliver(projectId, {
      id: eventId(),
      type: 'invoice.payment_failed',
      object: { id: `in_i610_${RUN}_1`, object: 'invoice', parent: { type: 'subscription_details', subscription_details: { subscription: SUB } } },
    })

    expect(res.status).toBe(200)
    expect(res.body.sync.result).toBe('applied')
    expect((await subscription()).status).toBe('past_due')
    const sent = await notifications('payment_failed')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      user_id: endUserId,
      title: 'Payment Failed',
      body: 'Your most recent payment failed. Please update your payment method to keep your subscription active.',
    })
    expect(sent[0].createdAt).toBeInstanceOf(Date)
  }, 120_000)

  it('invoice.paid sets a past_due subscription back to active, from an invoice in the older shape too', async () => {
    const res = await deliver(projectId, {
      id: eventId(),
      type: 'invoice.paid',
      // Before basil the subscription was top-level on the invoice.
      object: { id: `in_i610_${RUN}_2`, object: 'invoice', subscription: SUB },
    })

    expect(res.status).toBe(200)
    expect(res.body.sync.result).toBe('applied')
    expect((await subscription()).status).toBe('active')
  }, 120_000)

  it("customer.subscription.deleted writes cancelled, as create_table's CHECK spells it, and tells the user", async () => {
    const evt = eventId()
    const res = await deliver(projectId, {
      id: evt,
      type: 'customer.subscription.deleted',
      object: { id: SUB, object: 'subscription', status: 'canceled', cancel_at_period_end: false, items: { data: [] } },
    })

    expect(res.status).toBe(200)
    expect(res.body.sync.result).toBe('applied')
    expect((await subscription()).status).toBe('cancelled')
    const sent = await notifications('subscription_canceled')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ user_id: endUserId, title: 'Subscription Canceled', body: 'Your subscription has been canceled.' })
    expect(await recorded(projectId, evt)).toMatchObject({ processed: true, error: null })

    // Stripe redelivers: recorded once, applied once.
    const again = await deliver(projectId, {
      id: evt,
      type: 'customer.subscription.deleted',
      object: { id: SUB, object: 'subscription', status: 'canceled', cancel_at_period_end: false, items: { data: [] } },
    })
    expect(again.body.sync.result).toBe('already recorded in payment_events, so not applied again')
    expect(await notifications('subscription_canceled')).toHaveLength(1)
  }, 120_000)
})

describe('a checkout, against the orders table create_table makes', () => {
  it('checkout.session.completed finds the order by stripe_session_id and marks payment_status paid', async () => {
    const res = await deliver(projectId, {
      id: eventId(),
      type: 'checkout.session.completed',
      object: { id: SESSION, object: 'checkout.session', mode: 'payment', payment_intent: `pi_i610_${RUN}` },
    })

    expect(res.status).toBe(200)
    expect(res.body.sync.result).toBe('applied')
    const order = await one<{ status: string; payment_status: string; stripe_payment_intent_id: string }>(
      `SELECT status, payment_status, stripe_payment_intent_id FROM "${schemaOf(projectId)}".orders WHERE stripe_session_id = $1`,
      SESSION,
    )
    // orders.status is the fulfilment state (its CHECK has no `paid`); payment_status says it.
    expect(order).toEqual({ status: 'pending', payment_status: 'paid', stripe_payment_intent_id: `pi_i610_${RUN}` })
  }, 120_000)

  it("payment_intent.succeeded finds the order by its payment intent, credits the buyer's wallet, and tells the buyer", async () => {
    const res = await deliver(projectId, {
      id: eventId(),
      type: 'payment_intent.succeeded',
      object: {
        id: `pi_i610_${RUN}`,
        object: 'payment_intent',
        amount_received: 4900,
        currency: 'usd',
        metadata: { credits_amount: '50', user_id: endUserId },
      },
    })

    expect(res.status).toBe(200)
    expect(res.body.sync.result).toBe('applied')
    const order = await one<{ id: string; payment_status: string }>(
      `SELECT id::text AS id, payment_status FROM "${schemaOf(projectId)}".orders WHERE stripe_payment_intent_id = $1`,
      `pi_i610_${RUN}`,
    )
    expect(order.payment_status).toBe('paid')
    const wallet = await one<{ balance: number }>(`SELECT balance FROM "${schemaOf(projectId)}".credit_wallets WHERE user_id = $1::uuid`, endUserId)
    expect(Number(wallet.balance)).toBe(60)
    const sent = await notifications('payment_succeeded')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      user_id: endUserId,
      title: 'Payment Confirmed',
      body: `Your payment of 49.00 USD was successful. Order ${order.id} is confirmed.`,
    })
  }, 120_000)
})

describe('what cannot be applied is said, not swallowed', () => {
  it("a status the column's CHECK does not list: the rest is written, and the event is marked not applied, with why", async () => {
    // Since main's 4ce06143 (2026-11-13) the status list create_table gives a new subscriptions table includes
    // Stripe's incomplete statuses, so no Stripe status is refused there. Tables made before it keep the old list,
    // which is the case this test is about: give this one that list.
    const s = schemaOf(projectId)
    const check = await one<{ name: string }>(
      `SELECT k.conname AS name
         FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
        WHERE n.nspname = $1 AND c.relname = 'subscriptions' AND k.contype = 'c' AND a.attname = 'status'`,
      s,
    )
    await prisma.$executeRawUnsafe(`ALTER TABLE "${s}".subscriptions DROP CONSTRAINT "${check.name}"`)
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${s}".subscriptions ADD CONSTRAINT "${check.name}"
         CHECK (status IN ('active', 'trialing', 'past_due', 'cancelled', 'unpaid', 'paused'))`,
    )
    const evt = eventId()
    const res = await deliver(projectId, {
      id: evt,
      type: 'customer.subscription.updated',
      object: {
        id: SUB,
        object: 'subscription',
        status: 'incomplete_expired',
        items: { data: [{ current_period_start: at('2026-12-01T00:00:00Z'), current_period_end: at('2027-01-01T00:00:00Z') }] },
      },
    })

    expect(res.status).toBe(200)
    expect(res.body.sync.result).toBe('partly applied')
    expect(res.body.sync.notApplied).toEqual([
      "no column of `subscriptions` takes Stripe's status incomplete_expired: status allows active, trialing, past_due, cancelled, unpaid, paused",
    ])
    const row = await subscription()
    expect(row.status).toBe('cancelled')
    expect(row.current_period_end!.toISOString()).toBe('2027-01-01T00:00:00.000Z')

    const event = await recorded(projectId, evt)
    expect(event.processed).toBe(false)
    expect(event.error).toBe(res.body.sync.notApplied[0])

    const logged = await prisma.log.findMany({ where: { projectId, service: 'stripe' } })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ severity: 'error', endpoint: `/api/v1/${projectId}/webhooks/stripe` })
    expect(logged[0].message).toBe(
      `Stripe customer.subscription.updated ${evt} was not fully applied: no column of \`subscriptions\` takes Stripe's status incomplete_expired. ` +
        'Its row in payment_events and the reply Stripe shows for it give the details.',
    )
  }, 120_000)

  it('a subscriptions table with no column to find the subscription by: not applied, and shown in the Logs tab', async () => {
    const evt = eventId()
    const res = await deliver(unlinkedProjectId, {
      id: evt,
      type: 'customer.subscription.deleted',
      object: { id: SUB, object: 'subscription', status: 'canceled', items: { data: [] } },
    })

    expect(res.status).toBe(200)
    expect(res.body.sync).toEqual({
      result: 'not applied',
      changes: [],
      notApplied: [
        '`subscriptions` has no stripe_subscription_id or provider_subscription_id column to find the row for the Stripe subscription by',
      ],
      notes: [],
    })

    // What the console's Logs tab loads.
    const { GET } = await import('@/app/api/logs/route')
    const url = 'http://localhost:3000/api/logs?service=stripe'
    const headers = new Headers({ authorization: `Bearer ${token}`, 'x-project-id': unlinkedProjectId })
    const logsRes = await GET({
      method: 'GET',
      url,
      nextUrl: new URL(url),
      headers,
      cookies: { get: (k: string) => (k === 'auth-token' ? { value: token } : undefined) },
    } as any)
    expect(logsRes.status).toBe(200)
    const { logs } = (await logsRes.json()) as { logs: Array<{ severity: string; service: string; message: string }> }
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ severity: 'error', service: 'stripe' })
    expect(logs[0].message).toBe(
      `Stripe customer.subscription.deleted ${evt} was not fully applied: ` +
        '`subscriptions` has no stripe_subscription_id or provider_subscription_id column to find the row for the Stripe subscription by. ' +
        'The reply Stripe shows for it gives the details.',
    )
  }, 120_000)
})
