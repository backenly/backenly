/**
 * Connect auto-wiring does what the receipt claims (medium finding INT-14).
 *
 * Connecting a provider through STORE_INTEGRATION_KEY promises real backend
 * changes: Stripe adds payment columns to the orders table and registers a
 * checkout function plus a webhook handler the platform receiver can actually
 * fire (triggerType on_webhook / triggerTable stripe — NOT a manual function
 * the receiver never calls); an email provider wires a welcome email to
 * sign-up when auth is enabled; and every connect flips
 * project.activeIntegrations[id].enabled so the dashboard agrees with chat.
 * None of this was covered — the INT-* connect cases were deferred wholesale
 * to a staging run with real keys.
 *
 * Two seams are stubbed, both external services CI cannot honestly reach, on
 * the listener-hub precedent (realtime-sse-slot-release.spec.ts):
 *   - verifyIntegrationKey: the live provider probe (api.stripe.com etc.).
 *     Format gates, the dangerous-secret scan and the vault write stay real.
 *   - generateFunctionCode / generateFixedFunctionCode: the LLM. The wiring
 *     under test is which functions get created with which trigger shapes,
 *     not what code a model writes.
 * Everything else — the executor, the vault, prisma rows, the workspace DDL
 * executeAddColumn performs — runs against the real test database.
 */
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'

jest.mock('@/lib/integrations/key-verification', () => {
  const actual = jest.requireActual('@/lib/integrations/key-verification')
  return {
    ...actual,
    verifyIntegrationKey: jest.fn(async () => ({
      status: 'verified',
      detail: 'Stubbed in CI: the live provider probe is the one seam this suite does not run.',
    })),
  }
})

jest.mock('@/lib/services/ai-functions/generator', () => {
  const actual = jest.requireActual('@/lib/services/ai-functions/generator')
  let n = 0
  return {
    ...actual,
    generateFunctionCode: jest.fn(async () => ({
      name: `generated-fn-${++n}`,
      code: 'return { handled: true }',
    })),
    generateFixedFunctionCode: jest.fn(async () => null),
  }
})

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId: string
const projectIds: string[] = []

async function seedProject(name: string): Promise<string> {
  const id = (
    await prisma.project.create({ data: { name, userId: ownerId }, select: { id: true } })
  ).id
  projectIds.push(id)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${id}"`)
  return id
}

async function workspaceColumns(projectId: string, table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
    `workspace_${projectId}`,
    table,
  )
  return rows.map((r) => r.column_name)
}

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: {
        email: `autowire-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Autowiring Suite',
      },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  for (const id of projectIds) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
  }
  await prisma.aiFunction.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.projectIntegrationKey?.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.backendGraph.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('INT-14: Stripe connect wires what its receipt lists', () => {
  let projectId: string

  beforeAll(async () => {
    projectId = await seedProject('autowire-stripe')
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "workspace_${projectId}"."orders" (id SERIAL PRIMARY KEY, total NUMERIC)`,
    )
    await prisma.table.create({ data: { name: 'orders', projectId } })
  }, 120_000)

  it('connect succeeds degraded without a webhook secret and says so', async () => {
    const out = await executeAction(
      {
        action: 'STORE_INTEGRATION_KEY',
        params: { integrationId: 'stripe', apiKey: 'sk_test_' + crypto.randomBytes(16).toString('hex') },
      } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(out.success).toBe(true)
    expect((out.data as any)?.webhookSecretPending).toBe(true)
    expect(out.message).toContain('Webhook signature verification is NOT active')
  }, 120_000)

  it('the orders table really gained the payment columns', async () => {
    const cols = await workspaceColumns(projectId, 'orders')
    expect(cols).toEqual(expect.arrayContaining(['stripeSessionId', 'status']))
  }, 60_000)

  it('the webhook handler has the one shape the receiver fires', async () => {
    const webhookFn = await prisma.aiFunction.findFirst({
      where: { projectId, name: 'stripe-webhook' },
      select: { triggerType: true, triggerTable: true, status: true },
    })
    expect(webhookFn).toMatchObject({ triggerType: 'on_webhook', triggerTable: 'stripe', status: 'active' })
    const checkoutFn = await prisma.aiFunction.findFirst({
      where: { projectId, name: 'stripe-checkout-session' },
      select: { triggerType: true },
    })
    expect(checkoutFn).toMatchObject({ triggerType: 'manual' })
  }, 60_000)

  it('the dashboard state agrees: activeIntegrations.stripe is enabled with its verification', async () => {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { activeIntegrations: true },
    })
    const stripe = (project?.activeIntegrations as any)?.stripe
    expect(stripe).toMatchObject({ enabled: true, verification: 'verified', webhookSecretPending: true })
  }, 60_000)
})

describe('INT-14: email connect wires the welcome trigger only where auth exists', () => {
  it('with email auth enabled, connect creates an on_signup function', async () => {
    const projectId = await seedProject('autowire-resend')
    const graph = await prisma.backendGraph.create({
      data: {
        projectId,
        graphData: { auth: { providers: { email: { enabled: true } } } },
      },
      select: { id: true },
    })
    await prisma.project.update({ where: { id: projectId }, data: { activeGraphId: graph.id } })

    // jest.setup pins ENGINE_MODE=integration, which routes getActiveGraph to
    // an in-memory store this suite never filled. The auth-enabled check under
    // test reads the REAL activeGraph row, so lift the pin for this one call.
    const engineMode = process.env.ENGINE_MODE
    delete process.env.ENGINE_MODE
    let out
    try {
      out = await executeAction(
        {
          action: 'STORE_INTEGRATION_KEY',
          params: { integrationId: 'resend', apiKey: 're_' + crypto.randomBytes(16).toString('hex') },
        } as any,
        projectId, undefined, 0, undefined, false,
      )
    } finally {
      if (engineMode !== undefined) process.env.ENGINE_MODE = engineMode
    }
    expect(out.success).toBe(true)
    const welcome = await prisma.aiFunction.findFirst({
      where: { projectId, triggerType: 'on_signup' },
      select: { id: true, status: true },
    })
    expect(welcome).not.toBeNull()
  }, 120_000)
})

describe('INT-14: a provider with no wiring still syncs, and wires nothing', () => {
  it('posthog connect flips activeIntegrations without inventing functions', async () => {
    const projectId = await seedProject('autowire-posthog')
    const out = await executeAction(
      {
        action: 'STORE_INTEGRATION_KEY',
        params: { integrationId: 'posthog', apiKey: 'phc_' + crypto.randomBytes(16).toString('hex') },
      } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(out.success).toBe(true)
    expect((out.data as any)?.autoWired).toEqual([])
    const fns = await prisma.aiFunction.count({ where: { projectId } })
    expect(fns).toBe(0)
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { activeIntegrations: true },
    })
    expect((project?.activeIntegrations as any)?.posthog?.enabled).toBe(true)
  }, 120_000)
})
