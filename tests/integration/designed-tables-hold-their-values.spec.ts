/**
 * THE TABLES BACKENLY DESIGNS HOLD THEIR OWN DEFAULTS AND THE VALUES BACKENLY WRITES
 * ==================================================================================
 *
 * Production QA (2026-11-09), report 7, inside Backenly's own designs. A table
 * Backenly designs through a typed door gets its name rules
 * (lib/db/name-rules.ts), and they contradicted the design:
 *
 *  - the Stripe wiring made `subscriptions` with `status NOT NULL DEFAULT
 *    'inactive'`, and the CHECK for a table named subscriptions refused
 *    'inactive', so every insert that left status out failed (23514), as did
 *    Stripe's own `canceled`; its `user_id`, declared text, came out uuid;
 *  - Backenly writes "paid" and "awaiting_payment" into orders.status, and
 *    "pending" into a job table's and a tasks table's status, which their
 *    CHECKs refused;
 *  - the integrations' text ids (a OneSignal id, a SendGrid message id, a
 *    PostHog distinct id, an end user's id) came out uuid, several NOT NULL,
 *    and the build's credits and job tables NOT NULL on columns Backenly's own
 *    endpoints leave empty; a guest's second order was refused by a UNIQUE on
 *    the email.
 *
 * Each table here is made through the door Backenly makes it through, on a
 * real provisioned project, and then written as Backenly writes it.
 *
 * Tables made before this change keep what they were made with. A rule
 * Backenly guessed on one, such as `chk_subscriptions_status` on a project
 * wired to Stripe before today, is offered for removal by the
 * guessed_constraint finding (#763): checked here at the end.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})
// The key vault and provider checks are not under test: every integration
// reads as connected, so its executor goes on to make its tables.
jest.mock('@/lib/services/integrationKeyStore', () => {
  const actual = jest.requireActual('@/lib/services/integrationKeyStore')
  return {
    ...actual,
    hasIntegrationKey: jest.fn(async () => true),
    storeIntegrationKey: jest.fn(async (_projectId: string, integrationId: string) => ({ integrationId, maskedKey: '…1234' })),
  }
})
// The functions an integration generates are written by a model; their code is not under test.
jest.mock('@/lib/ai/function-generator', () => {
  const actual = jest.requireActual('@/lib/ai/function-generator')
  return { ...actual, executeGenerateFunction: jest.fn(async () => ({ success: true, message: 'generated (test)' })) }
})

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { executeNode } from '@/lib/ai/build-runtime/node-executor'
import type { BuildNode } from '@/lib/ai/build-runtime/types'
import { executeStripeIntegration } from '@/lib/integrations/stripe.executor'
import { executePushIntegration } from '@/lib/integrations/push.executor'
import { executeEmailIntegration } from '@/lib/integrations/email.executor'
import { executeAiIntegration } from '@/lib/integrations/ai.executor'
import { executePostHogIntegration } from '@/lib/integrations/posthog.executor'
import { detectGuessedConstraints } from '@/lib/autonomy/guessed-constraints'
import { markDesignedByBackenly } from '@/lib/db/declared-tables'
import { summariseFinding } from '@/lib/core/finding-summaries'
import { runObserverForProject } from '@/lib/services/workspace-observer'
import { closeChangeLockPool } from '@/lib/changes/lock'

let ownerId: string
let projectId: string
let ws: string

const env = {
  BACKENLY_EDITION: process.env.BACKENLY_EDITION,
  ENGINE_MODE: process.env.ENGINE_MODE,
  ENABLE_AUTONOMY_RECONCILER: process.env.ENABLE_AUTONOMY_RECONCILER,
  ENABLE_AUTONOMY_LIVE_EXECUTION: process.env.ENABLE_AUTONOMY_LIVE_EXECUTION,
}

/** Stripe's subscription statuses (API reference, the Subscription object). */
const STRIPE_SUBSCRIPTION_STATUSES = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']

const sql = (statement: string, ...values: unknown[]) => prisma.$executeRawUnsafe(statement, ...values)
const rows = <T = any>(statement: string, ...values: unknown[]) => prisma.$queryRawUnsafe<T[]>(statement, ...values)

/** A column as the catalog has it. */
async function column(table: string, name: string) {
  const [c] = await rows<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    ws, table, name,
  )
  if (!c) throw new Error(`${table}.${name} does not exist`)
  return c
}

/** The CHECK and UNIQUE constraints on one table, by name. */
async function constraints(table: string): Promise<string[]> {
  const found = await rows<{ conname: string }>(
    `SELECT c.conname FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND c.contype IN ('c', 'u')`,
    ws, table,
  )
  return found.map((r) => r.conname).sort()
}

/** Each value written by `write`, with the error PostgreSQL gave it, or null for none. */
async function refusals(values: string[], write: (value: string) => Promise<string | null>): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  for (const v of values) out[v] = await write(v)
  return out
}

const accepted = (values: string[]) => Object.fromEntries(values.map((v) => [v, null]))

/** The error PostgreSQL gives a statement, or null when it succeeds. */
async function refusal(statement: string, ...values: unknown[]): Promise<string | null> {
  try {
    await sql(statement, ...values)
    return null
  } catch (err: any) {
    return String(err?.meta?.code ?? err?.code ?? err?.message)
  }
}

const schemaNode = (table: string, executionParams?: Record<string, unknown>): BuildNode =>
  ({ id: `schema.${table}`, label: table, type: 'schema', status: 'pending', phase: 1, dependencies: [], ...(executionParams ? { executionParams } : {}) }) as BuildNode

async function designed(tableName: string, columns: Array<Record<string, unknown>>) {
  const made = await dispatchTool('create_table', { tableName, columns }, {
    projectId, userId: ownerId, sessionToken: undefined, createdThisTurn: new Set<string>(),
  })
  if (!made.ok) throw new Error(`${tableName}: ${made.summary}`)
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
  process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

  const email = `designed-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'owner' } })).id
  const project = await createProvisionedProject({ name: 'designed-tables', userId: ownerId })
  projectId = project.id
  ws = project.postgresSchema
}, 300_000)

afterAll(async () => {
  const schemas = await rows<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}%'`,
  ).catch(() => [])
  for (const s of schemas) await sql(`DROP SCHEMA IF EXISTS "${s.nspname}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.session.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  await closeChangeLockPool()
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}, 120_000)

describe('the Stripe wiring (lib/integrations/stripe.executor.ts)', () => {
  beforeAll(async () => {
    const wired = await executeStripeIntegration(projectId)
    if (!wired.success) throw new Error(`Stripe: ${wired.message}`)
  }, 240_000)

  it('makes subscriptions as designed: user_id text, status with its own default and no CHECK', async () => {
    expect(await column('subscriptions', 'user_id')).toMatchObject({ data_type: 'text', is_nullable: 'NO' })
    expect(await column('subscriptions', 'status')).toMatchObject({ data_type: 'text', is_nullable: 'NO', column_default: "'inactive'::text" })
    expect(await constraints('subscriptions')).not.toContain('chk_subscriptions_status')
  })

  it('takes a subscription row that leaves status out, as inactive', async () => {
    // The id as a literal, so it fits the column whatever its type: what is under test is status.
    const [row] = await rows<{ status: string }>(
      `INSERT INTO "${ws}".subscriptions (user_id, stripe_subscription_id) VALUES ('${crypto.randomUUID()}', 'sub_left_out') RETURNING status`,
    )
    expect(row.status).toBe('inactive')
  })

  it('takes the user id of any sign-in, not only a uuid', async () => {
    expect(await refusal(`INSERT INTO "${ws}".subscriptions (user_id, stripe_subscription_id) VALUES ('user_2NNEqL2nrIRdJ194ndJqAHwEfxC', 'sub_clerk')`)).toBeNull()
  })

  it('takes every status Stripe sends, and inactive', async () => {
    await sql(`INSERT INTO "${ws}".subscriptions (user_id, status, stripe_subscription_id) VALUES ('${crypto.randomUUID()}', 'active', 'sub_moves')`)
    const statuses = [...STRIPE_SUBSCRIPTION_STATUSES, 'inactive']
    expect(await refusals(statuses, (status) =>
      refusal(`UPDATE "${ws}".subscriptions SET status = $1 WHERE stripe_subscription_id = 'sub_moves'`, status),
    )).toEqual(accepted(statuses))
  })

  it('logs Stripe events as before', async () => {
    expect(await column('payment_events', 'stripe_event_id')).toMatchObject({ data_type: 'text', is_nullable: 'NO' })
    expect(await refusal(`INSERT INTO "${ws}".payment_events (stripe_event_id, event_type) VALUES ('evt_1', 'checkout.session.completed')`)).toBeNull()
  })
})

describe('the tables Backenly designs from a description or the build', () => {
  beforeAll(async () => {
    // The build's guest orders, credits ledger and generation jobs (lib/ai/build-runtime/node-executor.ts).
    for (const node of [schemaNode('orders', { guestMode: true }), schemaNode('credits'), schemaNode('generation_jobs')]) {
      const made = await executeNode(node, projectId)
      if (made.status !== 'verified') throw new Error(`${node.id}: ${made.failureReason ?? made.detail}`)
    }
    // A description's subscription and tasks tables, through create_table.
    await designed('subscription', [
      { name: 'user_id', type: 'uuid' }, { name: 'plan', type: 'text' }, { name: 'status', type: 'text' },
      { name: 'stripe_subscription_id', type: 'text' },
    ])
    await designed('tasks', [{ name: 'title', type: 'text' }, { name: 'status', type: 'text' }])
  }, 300_000)

  it('orders: holds what Backenly writes into status, starting pending as before', async () => {
    expect(await constraints('orders')).toContain('chk_orders_status')
    const [order] = await rows<{ id: string; status: string }>(`INSERT INTO "${ws}".orders (total) VALUES (10) RETURNING id, status`)
    expect(order.status).toBe('pending')
    // POST /stripe/session, the Stripe wiring, the build's Stripe handler.
    const statuses = ['awaiting_payment', 'paid', 'refunded', 'failed']
    expect(await refusals(statuses, (status) => refusal(`UPDATE "${ws}".orders SET status = $1 WHERE id = $2::uuid`, status, order.id)))
      .toEqual(accepted(statuses))
  })

  it('orders: takes a guest who orders twice, as POST /checkout writes the email on each order', async () => {
    expect(await refusal(`INSERT INTO "${ws}".orders (customer_email, total) VALUES ('guest@example.test', 10)`)).toBeNull()
    expect(await refusal(`INSERT INTO "${ws}".orders (customer_email, total) VALUES ('guest@example.test', 12)`)).toBeNull()
  })

  it('subscriptions: holds Stripe\'s statuses, starting active as before', async () => {
    const [row] = await rows<{ status: string }>(
      `INSERT INTO "${ws}".subscription (user_id, plan, stripe_subscription_id) VALUES ($1::uuid, 'pro', 'sub_designed') RETURNING status`,
      crypto.randomUUID(),
    )
    expect(row.status).toBe('active')
    const statuses = ['incomplete', 'incomplete_expired', 'cancelled']
    expect(await refusals(statuses, (status) =>
      refusal(`UPDATE "${ws}".subscription SET status = $1 WHERE stripe_subscription_id = 'sub_designed'`, status),
    )).toEqual(accepted(statuses))
  })

  it('generation_jobs: takes the job endpoints\' pending row, starting queued as before', async () => {
    const user = crypto.randomUUID()
    // Their fallback insert: no project_id, status pending (domain-business-logic.ts).
    expect(await refusal(
      `INSERT INTO "${ws}".generation_jobs (id, user_id, status, "createdAt", "updatedAt") VALUES ($1::uuid, $2::uuid, 'pending', NOW(), NOW())`,
      crypto.randomUUID(), user,
    )).toBeNull()
    const [row] = await rows<{ status: string }>(`INSERT INTO "${ws}".generation_jobs (user_id) VALUES ($1::uuid) RETURNING status`, user)
    expect(row.status).toBe('queued')
  })

  it('tasks: takes pending, starting todo as before', async () => {
    const [row] = await rows<{ id: string; status: string }>(`INSERT INTO "${ws}".tasks (title) VALUES ('write it') RETURNING id, status`)
    expect(row.status).toBe('todo')
    expect(await refusal(`UPDATE "${ws}".tasks SET status = 'pending' WHERE id = $1::uuid`, row.id)).toBeNull()
  })

  it('credits: takes the credit endpoints\' ledger rows, which name nothing they refer to', async () => {
    expect(await refusal(
      `INSERT INTO "${ws}".credits (id, user_id, amount, type, description, "createdAt") VALUES (gen_random_uuid(), $1::uuid, -1, 'consume', 'Reserved for a job', NOW())`,
      crypto.randomUUID(),
    )).toBeNull()
  })
})

describe('the other integrations\' tables keep the types they declare', () => {
  beforeAll(async () => {
    for (const [name, connect] of [
      ['OneSignal', () => executePushIntegration(projectId)],
      ['SendGrid', () => executeEmailIntegration(projectId, 'sendgrid')],
      ['OpenAI', () => executeAiIntegration(projectId, 'openai')],
      ['PostHog', () => executePostHogIntegration(projectId)],
    ] as const) {
      const wired = await connect()
      if (!wired.success) throw new Error(`${name}: ${wired.message}`)
    }
  }, 300_000)

  it('push: a broadcast is logged with no one user and no OneSignal id yet', async () => {
    expect(await column('device_tokens', 'player_id')).toMatchObject({ data_type: 'text' })
    expect(await column('push_notifications', 'onesignal_id')).toMatchObject({ data_type: 'text', is_nullable: 'YES' })
    expect(await refusal(`INSERT INTO "${ws}".push_notifications (title, body) VALUES ('Sale', 'Everything is 20% off')`)).toBeNull()
  })

  it('email: the provider\'s message id as it comes, and none before it answers', async () => {
    expect(await refusal(`INSERT INTO "${ws}".email_events (recipient, subject, message_id) VALUES ('a@example.test', 'Hi', 'sg_1731400000000')`)).toBeNull()
    expect(await refusal(`INSERT INTO "${ws}".email_events (recipient, subject) VALUES ('b@example.test', 'Hi')`)).toBeNull()
  })

  it('AI: a call no end user made, and one an end user from any sign-in made', async () => {
    expect(await refusal(`INSERT INTO "${ws}".ai_responses (model) VALUES ('gpt-4o-mini')`)).toBeNull()
    expect(await refusal(`INSERT INTO "${ws}".ai_responses (model, user_id) VALUES ('gpt-4o-mini', 'user_2NNEqL2nrIRdJ194ndJqAHwEfxC')`)).toBeNull()
  })

  it('PostHog: any distinct id the app chose', async () => {
    expect(await refusal(`INSERT INTO "${ws}".analytics_events (distinct_id, event) VALUES ('user_123', 'signed_up')`)).toBeNull()
  })
})

describe('a project wired to Stripe before this change', () => {
  // `subscriptions` exactly as the wiring made it until now: the CHECK the
  // rule gave a table named subscriptions, under the rule's own name.
  const OLD_SUBSCRIPTIONS =
    `CREATE TABLE "%s".subscriptions (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP,
       "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP,
       deleted_at timestamptz NULL,
       user_id uuid NOT NULL,
       plan text NOT NULL DEFAULT 'free',
       status text NOT NULL DEFAULT 'inactive',
       stripe_customer_id text,
       stripe_subscription_id text,
       stripe_price_id text,
       current_period_start timestamp,
       current_period_end timestamp,
       cancel_at_period_end boolean DEFAULT false,
       CONSTRAINT chk_subscriptions_status CHECK (status IN ('active', 'trialing', 'past_due', 'cancelled', 'unpaid', 'paused'))
     )`

  const forgetHowMade = (table: string) =>
    prisma.projectPreference.deleteMany({
      where: { projectId, key: table, type: { in: ['table_declared_in_sql', 'table_designed_by_backenly'] } },
    })

  const found = async () => new Map((await detectGuessedConstraints(projectId)).map((f) => [String(f.details.constraintName), f.details]))

  beforeAll(async () => {
    await sql(`DROP TABLE "${ws}".subscriptions CASCADE`)
    await sql(OLD_SUBSCRIPTIONS.replace('%s', ws))
  }, 60_000)

  it('refused a subscription row that left status out (what the change fixes)', async () => {
    expect(await refusal(`INSERT INTO "${ws}".subscriptions (user_id) VALUES ($1::uuid)`, crypto.randomUUID())).toBe('23514')
  })

  it('is offered chk_subscriptions_status to remove, when made before tables were marked', async () => {
    await forgetHowMade('subscriptions')
    const f = (await found()).get('chk_subscriptions_status')
    expect(f).toMatchObject({ tableName: 'subscriptions', columnName: 'status', rule: 'check_by_table_name' })
    expect(summariseFinding('guessed_constraint', f!)).toBe(
      'Backenly added a CHECK on subscriptions.status that allows only active, trialing, past_due, cancelled, unpaid and paused, ' +
        "because of the table's name. The request didn't ask for it, and it refuses any other status. Remove it?",
    )
  }, 120_000)

  it('is offered it too when made after #763 marked it designed, since the rule no longer makes that list', async () => {
    await markDesignedByBackenly(projectId, 'subscriptions')
    expect((await found()).has('chk_subscriptions_status')).toBe(true)
    // A table designed now carries the rule's current list, its design: not offered.
    expect((await found()).has('chk_subscription_status')).toBe(false)
    expect((await found()).has('chk_orders_status')).toBe(false)
  }, 120_000)

  it('reaches the Autonomy page as Remove it / Keep it, and nothing removes it on its own', async () => {
    // A scan the wiring's own schema.changed event started may still be running; this one waits its turn.
    for (let i = 0; i < 60; i++) {
      const scan = await runObserverForProject(projectId)
      if (!scan.errors.some((e) => /already running/.test(e))) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    const filed = await prisma.healthFinding.findFirst({
      where: { projectId, type: 'guessed_constraint', details: { path: ['constraintName'], equals: 'chk_subscriptions_status' } },
      orderBy: { detectedAt: 'desc' },
    })
    expect(filed?.status).toBe('pending_approval')
    expect(await constraints('subscriptions')).toContain('chk_subscriptions_status')
  }, 240_000)
})
