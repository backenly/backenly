/**
 * RULES BACKENLY GUESSED FROM A NAME, OFFERED FOR REMOVAL
 * =======================================================
 *
 * Production QA (2026-11-09), reports 6 and 7: `orders.email` carried
 * `orders_email_key`, which nobody wrote, so each customer could place one
 * order; and `chk_orders_status` (pending … refunded) sat next to the agent's
 * own CHECK (pending, paid, …), so together they refused "paid". #654 makes a
 * table declared in SQL exactly as written, but the tables made before it keep
 * the rules, and nothing told their owners.
 *
 * Pinned here on a real provisioned project (protected production, Cloud's
 * default), with the old rules made exactly as the old code made them:
 *
 *  1. A table made the old way is found, and the finding says what the rule
 *     does and why Backenly says nobody asked for it: the SQL in History, the
 *     request's recorded columns, or, with neither, the name rules themselves.
 *  2. A rule the SQL declared is not, even with the same name.
 *  3. Nothing on a table made after #654 is: declared in SQL, or designed by
 *     Backenly.
 *  4. The loop and the agent only get a proposal: nothing drops it on its own.
 *  5. A person's one click drops it as a governed change, and History puts it
 *     back; a rule a person decided on is not raised again.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})
// Signing in is delegated (its decision is pinned elsewhere): the Approve
// button's route runs as the owner, with its project check and everything
// behind it real.
const mockOwner = { userId: '', email: '' }
jest.mock('@/lib/auth/route-protection', () => {
  const actual = jest.requireActual('@/lib/auth/route-protection')
  return {
    ...actual,
    withProjectAccess: (handler: any) => async (request: any, ctx: any = {}) => {
      const projectId = (await ctx.params).id
      return handler(request, { user: { ...mockOwner }, project: { id: projectId }, projectId, params: ctx.params })
    },
  }
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

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { createProvisionedProject } from '@/lib/projects/provision'
import { POST as mcp } from '@/app/api/mcp/tool/route'
import { POST as approve } from '@/app/api/projects/[id]/health/approve/route'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { withChangeAttribution } from '@/lib/changes/attribution'
import { applyMigrationToMain, type MigrationSuccess } from '@/lib/mcp/apply-migration'
import { previewRecovery, recoverChange } from '@/lib/changes/recovery'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { detectGuessedConstraints } from '@/lib/autonomy/guessed-constraints'
import { runObserverForProject } from '@/lib/services/workspace-observer'
import { computeReconciliationPlan, runReconcilerLive } from '@/lib/autonomy/reconciler'
import { summariseFinding } from '@/lib/core/finding-summaries'
import { postgresConstraintName } from '@/lib/db/name-rules'

let ownerId: string
let ownerEmail: string
let projectId: string
let ws: string
let mcpKey: string

const env = {
  BACKENLY_EDITION: process.env.BACKENLY_EDITION,
  ENGINE_MODE: process.env.ENGINE_MODE,
  ENABLE_AUTONOMY_RECONCILER: process.env.ENABLE_AUTONOMY_RECONCILER,
  ENABLE_AUTONOMY_LIVE_EXECUTION: process.env.ENABLE_AUTONOMY_LIVE_EXECUTION,
}

const ORDER_STATES = "'pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'"
const LONG_TABLE = 'customer_contact_preferences_for_marketing_and_billing'
const LONG_COLUMN = 'secondary_contact_email_address'

/** A person's own migration on production, as the dashboard runs it. */
async function migrated(sql: string): Promise<MigrationSuccess> {
  const out = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    applyMigrationToMain(projectId, ownerId, sql, { agentSurface: false, workspaceSchema: ws }),
  )
  if (!out.ok) throw new Error(`"${sql}" did not apply: ${JSON.stringify(out)}`)
  return out as MigrationSuccess
}

/** DDL as the old executor ran it, outside anything Backenly records now. */
const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

/** A table made before Backenly kept how tables were made. */
const forgetHowMade = (table: string) =>
  prisma.projectPreference.deleteMany({
    where: { projectId, key: table, type: { in: ['table_declared_in_sql', 'table_designed_by_backenly'] } },
  })

async function rules(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
    `SELECT c.conname FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2`,
    ws,
    table,
  )
  return rows.map((r) => r.conname).sort()
}

async function found(): Promise<Map<string, Record<string, unknown>>> {
  const findings = await detectGuessedConstraints(projectId)
  return new Map(findings.map((f) => [String(f.details.constraintName), f.details as Record<string, unknown>]))
}

async function call(tool: string, args: Record<string, unknown> = {}) {
  const res = await mcp(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

/** The Autonomy page's Approve button, as the signed-in owner presses it. */
async function approveAsOwner(findingId: string) {
  const req: any = { json: async () => ({ findingId }) }
  const res: any = await (approve as any)(req, { params: Promise.resolve({ id: projectId }) })
  return { status: res.status as number, body: await res.json() }
}

const findingFor = (constraintName: string) =>
  prisma.healthFinding.findFirst({
    where: { projectId, type: 'guessed_constraint', details: { path: ['constraintName'], equals: constraintName } },
    orderBy: { detectedAt: 'desc' },
  })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
  process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

  ownerEmail = `guessed-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, password: 'not-a-real-hash', name: 'owner' } })).id
  Object.assign(mockOwner, { userId: ownerId, email: ownerEmail })
  const project = await createProvisionedProject({ name: 'guessed-constraints', userId: ownerId })
  projectId = project.id
  ws = project.postgresSchema

  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })

  // ── Made the old way ──────────────────────────────────────────────────────
  // orders: the QA table. The agent's SQL, in History, declared its own CHECK
  // on status and nothing on email; the old executor added both rules inline,
  // under exactly these names.
  await migrated(
    "CREATE TABLE orders (email text, status text CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')), total integer)",
  )
  await forgetHowMade('orders')
  await raw(`ALTER TABLE "${ws}".orders ADD CONSTRAINT orders_email_key UNIQUE (email)`)
  await raw(`ALTER TABLE "${ws}".orders ADD CONSTRAINT chk_orders_status CHECK (status IN (${ORDER_STATES}))`)

  // customers: the SQL declared `email text UNIQUE`, which PostgreSQL names
  // exactly as the rule's would be. Asked for, so never offered.
  await migrated('CREATE TABLE customers (email text UNIQUE, name text)')
  await forgetHowMade('customers')

  // posts: the old executor itself, through the typed door it still uses for a
  // table Backenly designs, before the table's making was recorded.
  const posts = await dispatchTool('create_table', {
    tableName: 'posts',
    columns: [{ name: 'title', type: 'text' }, { name: 'slug', type: 'text' }, { name: 'status', type: 'text' }],
  }, { projectId, userId: ownerId, sessionToken: undefined, createdThisTurn: new Set<string>() })
  if (!posts.ok) throw new Error(`posts: ${posts.summary}`)
  await forgetHowMade('posts')

  // members: nothing recorded at all, only the rule's exact name and definition.
  await raw(`CREATE TABLE "${ws}".members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text UNIQUE)`)
  // A name PostgreSQL has to shorten.
  await raw(`CREATE TABLE "${ws}".${LONG_TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${LONG_COLUMN} text UNIQUE)`)
}, 300_000)

afterAll(async () => {
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await raw(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  const schemas = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}%'`,
  ).catch(() => [])
  for (const s of schemas) await raw(`DROP SCHEMA IF EXISTS "${s.nspname}" CASCADE`).catch(() => {})
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

describe('a table made before #654', () => {
  it('is found, with what each rule does and why nobody asked for it', async () => {
    const longName = postgresConstraintName(LONG_TABLE, LONG_COLUMN, 'key')
    expect(longName.length).toBeLessThanOrEqual(63)
    expect(await rules(LONG_TABLE)).toContain(longName)

    const f = await found()
    expect([...f.keys()].sort()).toEqual(
      ['chk_orders_status', 'chk_posts_status', longName, 'members_username_key', 'orders_email_key', 'posts_slug_key'].sort(),
    )

    // The SQL is in History and declared neither rule.
    expect(f.get('orders_email_key')).toMatchObject({ rule: 'unique_by_name', evidence: 'sql', tableName: 'orders', columnName: 'email' })
    expect(summariseFinding('guessed_constraint', f.get('orders_email_key')!)).toBe(
      "Backenly added UNIQUE on orders.email. Your SQL didn't ask for it, and it stops two rows of orders from having the same email. Remove it?",
    )
    expect(f.get('chk_orders_status')).toMatchObject({ rule: 'check_by_table_name', evidence: 'sql', refusesAllowedByOwnCheck: ['paid'] })
    expect(summariseFinding('guessed_constraint', f.get('chk_orders_status')!)).toBe(
      'Backenly added a CHECK on orders.status that allows only pending, processing, shipped, delivered, cancelled and refunded. ' +
        "Your SQL didn't ask for it, and it refuses paid, which your own CHECK on status allows. Remove it?",
    )

    // The request's columns are recorded; it was not SQL.
    expect(f.get('posts_slug_key')).toMatchObject({ evidence: 'request' })
    expect(f.get('chk_posts_status')).toMatchObject({ evidence: 'request', allowedValues: ['draft', 'published', 'archived', 'scheduled'] })

    // Nothing recorded: the rule's own name and definition, said as such.
    expect(f.get('members_username_key')).toMatchObject({ evidence: 'unrecorded' })
    expect(summariseFinding('guessed_constraint', f.get('members_username_key')!)).toBe(
      'Backenly\'s name rules added UNIQUE on members.username, because the column\'s name has "username" in it. ' +
        'Nothing recorded shows the request asked for it, and it stops two rows of members from having the same username. Remove it?',
    )
    // The agent reads who decides, and the statement, in list_findings.
    expect(f.get('orders_email_key')!.reason).toMatch(/Removing it waits for a person on the Autonomy page\.$/)
    expect(f.get('orders_email_key')!.drop).toBe('ALTER TABLE orders DROP CONSTRAINT orders_email_key;')
  }, 120_000)

  it('leaves alone a rule the SQL declared, even under the same name', async () => {
    expect(await rules('customers')).toContain('customers_email_key')
    // The agent's own CHECK on orders.status is not one either.
    const ownCheck = (await rules('orders')).find((n) => n.startsWith('chk_orders_status_'))
    expect(ownCheck).toBeTruthy()

    let f = await found()
    expect(f.has('customers_email_key')).toBe(false)
    expect(f.has(ownCheck!)).toBe(false)

    // History alone says so too, when the intent ledger has nothing.
    await prisma.schemaIntent.deleteMany({ where: { projectId, tableName: 'customers' } })
    f = await found()
    expect(f.has('customers_email_key')).toBe(false)
  }, 120_000)
})

describe('a table made after #654', () => {
  it('is never flagged: declared in SQL, or designed by Backenly', async () => {
    // Declared in SQL, with exactly the names and definitions the rules give.
    await migrated(
      'CREATE TABLE subscriptions (email text UNIQUE, status text, CONSTRAINT chk_subscriptions_status ' +
        "CHECK (status IN ('active', 'trialing', 'past_due', 'cancelled', 'unpaid', 'paused')))",
    )
    expect(await rules('subscriptions')).toEqual(expect.arrayContaining(['chk_subscriptions_status', 'subscriptions_email_key']))

    // Designed by Backenly: its name rules apply by design.
    const tasks = await dispatchTool('create_table', {
      tableName: 'tasks',
      columns: [{ name: 'title', type: 'text' }, { name: 'status', type: 'text' }, { name: 'owner_email', type: 'text' }],
    }, { projectId, userId: ownerId, sessionToken: undefined, createdThisTurn: new Set<string>() })
    expect(tasks.ok).toBe(true)
    expect(await rules('tasks')).toEqual(expect.arrayContaining(['chk_tasks_status', 'tasks_owner_email_key']))

    // A column added to it in SQL is added as written.
    await migrated('ALTER TABLE subscriptions ADD COLUMN backup_email text')
    expect(await rules('subscriptions')).not.toContain('subscriptions_backup_email_key')

    const f = await found()
    for (const name of ['chk_subscriptions_status', 'subscriptions_email_key', 'chk_tasks_status', 'tasks_owner_email_key']) {
      expect(f.has(name)).toBe(false)
    }
  }, 120_000)
})

describe('on a protected production', () => {
  it('reaches the Autonomy page and the agent as a proposal, and nothing drops it on its own', async () => {
    await runObserverForProject(projectId)
    const waiting = await prisma.healthFinding.findMany({
      where: { projectId, type: 'guessed_constraint' },
      select: { status: true, details: true },
    })
    expect(waiting.map((w) => (w.details as any).constraintName).sort()).toEqual([...(await found()).keys()].sort())
    expect(new Set(waiting.map((w) => w.status))).toEqual(new Set(['pending_approval']))

    // The loop rates it a person's decision and leaves it in place.
    const plan = await computeReconciliationPlan(projectId)
    const decisions = plan.decisions.filter((d) => d.type === 'guessed_constraint')
    expect(decisions.length).toBe(waiting.length)
    expect(new Set(decisions.map((d) => d.action))).toEqual(new Set(['NEEDS_APPROVAL']))
    await runReconcilerLive(projectId)
    expect(await rules('orders')).toContain('orders_email_key')

    // The agent reads it, and cannot drop it: production is protected.
    const listed = await call('autonomy', { action: 'findings' })
    expect(listed.status).toBe(200)
    const row = (listed.body.data.findings as any[]).find((r) => r.type === 'guessed_constraint' && r.target === 'orders.email')
    expect(row.reason).toBe(
      "Backenly added UNIQUE on orders.email. Your SQL didn't ask for it, and it stops two rows of orders from having the same email. " +
        'Removing it waits for a person on the Autonomy page.',
    )
    const dropped = await call('apply_migration', { sql: 'ALTER TABLE orders DROP CONSTRAINT orders_email_key' })
    expect(dropped.status).toBe(403)
    expect(dropped.body.code).toBe('BRANCH_REQUIRED')
    const finding = await findingFor('orders_email_key')
    const resolved = await dispatchTool('resolve_finding', { findingId: finding!.id }, {
      projectId, userId: ownerId, sessionToken: undefined, createdThisTurn: new Set<string>(), agentSurface: true,
    })
    expect(resolved.ok).toBe(false)
    expect(resolved.summary).toMatch(/needs a person's approval/)

    expect(await rules('orders')).toContain('orders_email_key')
    expect((await findingFor('orders_email_key'))!.status).toBe('pending_approval')
  }, 240_000)
})

describe('a person', () => {
  it('removes it in one click, as a change History restores', async () => {
    const finding = await findingFor('orders_email_key')
    const before = await prisma.backendChange.count({ where: { projectId } })
    const out = await approveAsOwner(finding!.id)
    expect(out).toMatchObject({ status: 200, body: { success: true } })
    expect(await rules('orders')).not.toContain('orders_email_key')
    const fixed = await findingFor('orders_email_key')
    expect(fixed!.status).toBe('auto_fixed')
    // The probe looked again and found it gone: a verified removal.
    expect((fixed!.details as any).rollbackData).toMatchObject({ verification: 'confirmed', rollbackFormat: 3 })

    // Two orders from one customer are accepted now.
    await raw(`INSERT INTO "${ws}".orders (email, status) VALUES ('a@example.test', 'pending'), ('a@example.test', 'shipped')`)

    // One governed change, that History can restore.
    const change = await prisma.backendChange.findFirst({ where: { projectId }, orderBy: { seq: 'desc' } })
    expect(await prisma.backendChange.count({ where: { projectId } })).toBe(before + 1)
    expect(change!.status).toBe('healthy')
    expect((change!.statements as Array<{ sql: string }>).map((st) => st.sql).join('\n')).toMatch(/DROP CONSTRAINT "orders_email_key"/)

    // Restoring needs rows that meet the rule again.
    await raw(`DELETE FROM "${ws}".orders`)
    const preview = (await previewRecovery(projectId, change!.id))!
    const restored = await recoverChange(projectId, change!.id, {
      mode: 'manual', actorUserId: ownerId, acknowledged: preview.acknowledgement ?? null,
    })
    expect(restored).toMatchObject({ ok: true, status: 'restored' })
    expect(await rules('orders')).toContain('orders_email_key')

    // Restored is kept: it is not offered again.
    expect((await found()).has('orders_email_key')).toBe(false)
  }, 240_000)

  it('who keeps one is not asked about it again', async () => {
    const finding = await findingFor('posts_slug_key')
    await prisma.healthFinding.update({ where: { id: finding!.id }, data: { status: 'dismissed' } })
    expect((await found()).has('posts_slug_key')).toBe(false)
    await runObserverForProject(projectId)
    expect(await prisma.healthFinding.count({
      where: { projectId, type: 'guessed_constraint', status: { in: ['open', 'pending_approval'] }, details: { path: ['constraintName'], equals: 'posts_slug_key' } },
    })).toBe(0)
  }, 240_000)
})
