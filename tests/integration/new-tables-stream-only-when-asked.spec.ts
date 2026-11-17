/**
 * A NEW TABLE STREAMS ONLY WHEN REALTIME IS TURNED ON FOR IT
 * ==========================================================
 *
 * Production QA re-test (2026-11-16, new finding N9 and report #77): realtime
 * was turned on for `orders` alone. A branch merge then brought
 * `product_views`, and it carried Backenly's realtime trigger: create_table
 * gave every new table that trigger whenever any table streamed, and a merge
 * replays create_table on production. History said only "Created table".
 * Turning realtime on for `qa_probe`, which had joined the same way, changed
 * nothing, so History recorded nothing, while the answer listed it under
 * "Enabled by this call".
 *
 * Real provisioned project, branch, triggers, change records and schema
 * snapshots. Only PostgREST's schema registry is stubbed, as in every branch
 * suite. Pinned here:
 *  1. A table made by a migration on production, by create_table from a
 *     description, or by a merge does not stream. Each result names the tables
 *     that do, and the call that adds this one.
 *  2. Turning realtime on for such a table installs its trigger and History
 *     records it. Asking again is answered "already on": nothing is re-created
 *     and nothing is recorded.
 *  3. FIX_TABLE re-creating a missing table puts its trigger back only when
 *     the table streamed when last recorded. REGISTER_TABLE adds none.
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

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { createProvisionedProject } from '@/lib/projects/provision'
import { POST } from '@/app/api/mcp/tool/route'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { executeAction } from '@/lib/ai/minimal-executor'
import { createBranch } from '@/lib/branches/engine'
import { withChangeAttribution } from '@/lib/changes/ledger'
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'
import { closeChangeLockPool } from '@/lib/changes/lock'

let ownerId: string
let projectId: string
let schema: string
let mcpKey: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const ctx = () => ({ projectId, userId: ownerId, createdThisTurn: new Set<string>() })
const asOwner = <T>(fn: () => Promise<T>) => withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, fn)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)
const titles = async () =>
  (await prisma.backendChange.findMany({ where: { projectId }, orderBy: { seq: 'asc' }, select: { title: true } })).map((c) => c.title)

/** The realtime trigger's oid on a production table, or null when it has none. */
async function realtimeTrigger(table: string): Promise<string | null> {
  const r = await rows<{ oid: string }>(
    `SELECT t.oid::text AS oid FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${schema}' AND c.relname = '${table}' AND t.tgname = 'backenly_realtime'`,
  )
  return r[0]?.oid ?? null
}

async function call(tool: string, args: Record<string, unknown> = {}) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

async function migrate(sql: string) {
  const r: any = await asOwner(() => applyMigrationToMain(projectId, ownerId, sql, { agentSurface: false, workspaceSchema: schema }))
  if (!r.ok) throw new Error(`migration failed: ${JSON.stringify(r)}`)
  return r
}

async function turnOn(tableName: string) {
  return asOwner(() => dispatchTool('enable_realtime', { tableName }, ctx()))
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js points the executor at an in-memory graph that skips DDL.
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (await prisma.user.create({
    data: { email: `rt-asked-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'new-tables-stream-only-when-asked', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })

  // Production: orders, with realtime turned on for it and for nothing else.
  await migrate('CREATE TABLE orders (total integer, user_id uuid)')
  const on = await turnOn('orders')
  if (!on.ok) throw new Error(`enable_realtime failed: ${on.summary}`)
}, 240_000)

afterAll(async () => {
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  const vaults = await rows<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  await closeChangeLockPool()
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
}, 240_000)

describe('a new table does not stream until realtime is turned on for it', () => {
  it('made by a migration on production, and the result says what streams and how to add it', async () => {
    expect(await realtimeTrigger('orders')).not.toBeNull()

    const made = await migrate('CREATE TABLE qa_probe (ext_id text, sku text)')

    expect(await realtimeTrigger('qa_probe')).toBeNull()
    expect(made.summary).toContain(
      'Realtime streams orders; qa_probe does not. To stream it: realtime { "action": "enable", "tableName": "qa_probe" }.',
    )
  })

  it('made by create_table from a description', async () => {
    const made = await asOwner(() => dispatchTool('create_table', {
      tableName: 'contacts',
      columns: [{ name: 'email', type: 'text' }, { name: 'status', type: 'text' }],
    }, ctx()))

    expect(made.ok).toBe(true)
    expect(await realtimeTrigger('contacts')).toBeNull()
    expect(made.summary).toContain('Realtime streams orders; contacts does not.')
  })

  it('brought by a merge, and the merge says so', async () => {
    const created = await createBranch(projectId, ownerId, 'views')
    if (!created.ok) throw new Error(`createBranch failed: ${(created as any).error}`)
    const branchId = (created as any).branch.id as string
    const applied = await call('apply_migration', {
      branchId,
      sql: 'CREATE TABLE product_views (product_id uuid, viewed_at timestamptz); CREATE TABLE price_alerts (product_id uuid, below integer)',
    })
    if (applied.status !== 200) throw new Error(`branch migration failed: ${JSON.stringify(applied.body)}`)

    // As a person's approval runs it (lib/mcp/approvals.ts).
    const merged = await asOwner(() => dispatchTool('merge_branch', { branchId }, { ...ctx(), destructiveConfirmed: true }))

    expect(merged.ok).toBe(true)
    expect(await realtimeTrigger('product_views')).toBeNull()
    expect(await realtimeTrigger('price_alerts')).toBeNull()
    const note =
      'Realtime streams orders; product_views and price_alerts do not. ' +
      'To stream one: realtime { "action": "enable", "tableName": "product_views" }, once for each table.'
    expect(merged.summary).toContain(note)
    expect((merged.data as any)?.realtime).toEqual({ streaming: ['orders'], notStreaming: ['product_views', 'price_alerts'], note })
  }, 120_000)
})

describe('turning realtime on for a table', () => {
  it('installs its trigger, and History records it', async () => {
    const before = await titles()

    const on = await turnOn('product_views')

    expect(on.ok).toBe(true)
    expect(await realtimeTrigger('product_views')).not.toBeNull()
    expect((await titles()).slice(before.length)).toEqual(['Turn on realtime for product_views'])
  })

  it('a second time is answered "already on", re-creates nothing and records nothing', async () => {
    const trigger = await realtimeTrigger('product_views')
    const before = await titles()

    const again = await asOwner(() =>
      executeAction({ action: 'ENABLE_REALTIME', params: { tableName: 'product_views' } } as any, projectId))

    expect(again.success).toBe(true)
    expect(await realtimeTrigger('product_views')).toBe(trigger)
    expect((again.data as any)?.enabledNow).toEqual([])
    expect((again.data as any)?.alreadyEnabled).toEqual(expect.arrayContaining(['orders', 'product_views']))
    expect(await titles()).toEqual(before)
    expect(again.message).toContain('Realtime is already on for `product_views`; this call changed nothing.')
    expect(again.message).not.toContain('Enabled by this call')
  })
})

describe('repairs', () => {
  it('FIX_TABLE puts the trigger back only on a table that streamed when last recorded', async () => {
    await migrate('CREATE TABLE rt_live (body text); CREATE TABLE rt_quiet (body text)')
    expect((await turnOn('rt_live')).ok).toBe(true)
    // Both tables vanish outside Backenly; their records stay.
    await prisma.$executeRawUnsafe(`DROP TABLE "${schema}"."rt_live", "${schema}"."rt_quiet"`)
    // A table Backenly has a record of but no snapshot ever saw.
    await prisma.table.create({ data: { projectId, name: 'rt_unseen', schema, description: 'fixture' } })

    const live = await asOwner(() => executeAction({ action: 'FIX_TABLE', params: { tableName: 'rt_live' } } as any, projectId))
    const quiet = await asOwner(() => executeAction({ action: 'FIX_TABLE', params: { tableName: 'rt_quiet' } } as any, projectId))
    const unseen = await asOwner(() => executeAction({ action: 'FIX_TABLE', params: { tableName: 'rt_unseen' } } as any, projectId))

    expect([live.success, quiet.success, unseen.success]).toEqual([true, true, true])
    expect(await realtimeTrigger('rt_live')).not.toBeNull()
    expect(await realtimeTrigger('rt_quiet')).toBeNull()
    expect(await realtimeTrigger('rt_unseen')).toBeNull()
    expect(live.message).toContain('Reinstalled the realtime trigger on `rt_live`: it streamed when last recorded.')
    expect(quiet.message).not.toContain('realtime')
    expect(unseen.message).toContain(
      'Realtime was not turned on for `rt_unseen`: no record shows whether it streamed. ' +
      'To stream it: realtime { "action": "enable", "tableName": "rt_unseen" }.',
    )
  }, 120_000)

  it('REGISTER_TABLE adopts a table without streaming it', async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."legacy_imports" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text)`)

    const registered = await asOwner(() =>
      executeAction({ action: 'REGISTER_TABLE', params: { tableName: 'legacy_imports' } } as any, projectId))

    expect(registered.success).toBe(true)
    expect(await realtimeTrigger('legacy_imports')).toBeNull()
    expect(registered.message).toContain(
      'legacy_imports does not. To stream it: realtime { "action": "enable", "tableName": "legacy_imports" }.',
    )
  }, 120_000)
})
