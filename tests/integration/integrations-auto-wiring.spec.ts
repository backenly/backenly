/**
 * CONNECTING AN INTEGRATION WIRES FUNCTIONS THAT CAN ACTUALLY RUN AND FIRE
 * ========================================================================
 * integrations { action: "connect" } for Stripe/OpenAI/Anthropic auto-wired
 * three broken things:
 *
 *   - INT-01: it generated ROUTE MODULES whose own description told the model
 *     to call ctx.integrations.* — a ctx that only exists in the SANDBOX
 *     runtime; route modules deliberately cannot reach stored provider keys.
 *     Every generated endpoint was dead on arrival.
 *   - INT-02: the stripe-webhook handler was stored triggerType 'manual',
 *     while the platform receiver fires ONLY on_webhook functions — so Stripe
 *     deliveries answered { functionsTriggered: 0 } forever, and readiness
 *     said Complete.
 *   - INT-03: the receiver's own deterministic business logic wrote to
 *     FORCE-RLS workspace tables as bare prisma (no claims) with column names
 *     the auto-wire never creates, and swallowed every failure — "verified
 *     events are recorded in payment_events" was not true in practice.
 *
 * Now the auto-wire creates SANDBOX functions (ctx.integrations is real
 * there), the webhook handler is on_webhook/'stripe' (what the receiver
 * fires), and the business logic runs under the service-role claims with the
 * auto-wire's own column names. The LLM and the key vault are the only mocks.
 */

import { randomUUID } from 'crypto'

jest.mock('@/lib/ai/llm/chat', () => {
  const actual = jest.requireActual('@/lib/ai/llm/chat')
  return {
    ...actual,
    // One canned answer serves both the name call and the code call: a valid
    // sandbox body, and a harmless name that the supplied name overrides.
    chat: jest.fn(async () => ({ text: 'return { ok: true }', result: {} })),
  }
})

jest.mock('@/lib/services/integrationKeyStore', () => {
  const actual = jest.requireActual('@/lib/services/integrationKeyStore')
  return {
    ...actual,
    // The vault (encryption, provider verification) is not under test; the
    // wiring that follows a successful store is.
    storeIntegrationKey: jest.fn(async (_projectId: string, integrationId: string) => ({
      integrationId,
      maskedKey: 'sk_test_…1234',
      connectedAt: new Date().toISOString(),
      verification: 'verified',
      verificationDetail: 'test fixture',
    })),
  }
})

const svcCalls: Array<{ userId: string; serviceRole: boolean }> = []
jest.mock('@/lib/services/workspace-rls', () => {
  const actual = jest.requireActual('@/lib/services/workspace-rls')
  return {
    ...actual,
    executeWithUserContext: jest.fn(async (projectId: string, userId: string, serviceRole: boolean, sql: string, values: unknown[] = [], role?: string) => {
      svcCalls.push({ userId, serviceRole })
      return actual.executeWithUserContext(projectId, userId, serviceRole, sql, values, role)
    }),
  }
})

import { prisma } from '@/lib/db/prisma'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { isRouteModuleFunction } from '@/lib/services/ai-functions/route-module-runner'
import { handleStripeBusinessLogic } from '@/app/api/v1/[projectId]/webhooks/[integration]/route'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId = ''
let projectId = ''
let schema = ''

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `int-wire-${randomUUID()}@test.invalid`, name: 'Integrations Wiring Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `int-wire-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)

  // The executor's Stripe guard looks for a stored key row.
  await prisma.projectIntegrationKey.create({
    data: { projectId, integrationId: 'stripe', encryptedKey: 'enc-test', maskedKey: 'sk_test_…1234' },
  })
}, 120_000)

afterAll(async () => {
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.projectIntegrationKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('connecting Stripe wires functions the runtime can serve and fire', () => {
  it('creates a sandbox checkout function and an on_webhook handler the receiver fires', async () => {
    const res: any = await dispatchTool(
      'store_integration_key',
      { integrationId: 'stripe', apiKey: 'sk_test_fixture' },
      { projectId, userId: ownerId },
    )
    expect(res.ok ?? res.success).toBe(true)

    const checkout = await prisma.aiFunction.findFirst({ where: { projectId, name: 'stripe-checkout-session' } })
    expect(checkout).not.toBeNull()
    expect(checkout!.triggerType).toBe('manual') // callable at POST /fn/stripe-checkout-session
    expect(isRouteModuleFunction(checkout!.generatedCode)).toBe(false) // sandbox: ctx.integrations exists

    const webhook = await prisma.aiFunction.findFirst({ where: { projectId, name: 'stripe-webhook' } })
    expect(webhook).not.toBeNull()
    // The receiver fires exactly this shape; 'manual' was never fired.
    expect(webhook!.triggerType).toBe('on_webhook')
    expect(webhook!.triggerTable).toBe('stripe')
    expect(isRouteModuleFunction(webhook!.generatedCode)).toBe(false)
  }, 120_000)

  it('connecting OpenAI wires sandbox chat and embed functions', async () => {
    const res: any = await dispatchTool(
      'store_integration_key',
      { integrationId: 'openai', apiKey: 'sk-test-fixture' },
      { projectId, userId: ownerId },
    )
    expect(res.ok ?? res.success).toBe(true)
    for (const name of ['openai-chat', 'openai-embed']) {
      const fn = await prisma.aiFunction.findFirst({ where: { projectId, name } })
      expect(fn).not.toBeNull()
      expect(fn!.triggerType).toBe('manual')
      expect(isRouteModuleFunction(fn!.generatedCode)).toBe(false)
    }
  }, 120_000)
})

describe('the receiver business logic lands its writes (INT-03)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."payment_events" (
         id bigserial PRIMARY KEY,
         stripe_event_id text UNIQUE,
         event_type text,
         payload jsonb,
         processed boolean,
         processed_at timestamptz
       )`,
    )
    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."payment_events" ENABLE ROW LEVEL SECURITY`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."payment_events" FORCE ROW LEVEL SECURITY`)

    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."orders" (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id text,
         status text DEFAULT 'pending',
         "stripeSessionId" text,
         stripe_payment_intent_id text,
         "updatedAt" timestamptz DEFAULT now()
       )`,
    )
    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."orders" ENABLE ROW LEVEL SECURITY`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."orders" FORCE ROW LEVEL SECURITY`)
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."orders" (user_id, "stripeSessionId") VALUES ('u1', 'cs_test_123')`,
    )
  }, 120_000)

  it('checkout.session.completed records the event and marks the order paid, under service-role claims', async () => {
    svcCalls.length = 0
    await handleStripeBusinessLogic(projectId, {
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_123', payment_intent: 'pi_test_9' } },
    })

    // Every workspace write went through the claims escape, as service role.
    expect(svcCalls.length).toBeGreaterThan(0)
    expect(svcCalls.every((c) => c.serviceRole === true)).toBe(true)

    const events = await prisma.$queryRawUnsafe<any[]>(
      `SELECT stripe_event_id, event_type FROM "${schema}"."payment_events"`,
    )
    expect(events).toHaveLength(1)
    expect(events[0].stripe_event_id).toBe('evt_test_1')

    const order = await prisma.$queryRawUnsafe<any[]>(
      `SELECT status, stripe_payment_intent_id FROM "${schema}"."orders" WHERE "stripeSessionId" = 'cs_test_123'`,
    )
    expect(order[0].status).toBe('paid')
    expect(order[0].stripe_payment_intent_id).toBe('pi_test_9')
  }, 120_000)

  it('a replay of the same event is idempotent', async () => {
    await handleStripeBusinessLogic(projectId, {
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_123', payment_intent: 'pi_test_9' } },
    })
    const events = await prisma.$queryRawUnsafe<any[]>(
      `SELECT count(*)::int AS n FROM "${schema}"."payment_events"`,
    )
    expect(events[0].n).toBe(1)
  }, 120_000)
})
