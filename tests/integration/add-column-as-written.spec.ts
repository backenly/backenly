/**
 * A COLUMN ADDED IN SQL IS ADDED AS WRITTEN
 * ========================================
 *
 * Production QA (2026-11-09), report 6: after #654 made CREATE TABLE exactly
 * as written, `ALTER TABLE … ADD COLUMN customer_email text` still came out
 * UNIQUE, because the column's name has "email" in it, on production and on a
 * branch alike; and `ADD COLUMN team_id uuid` got a foreign key to teams that
 * the statement never declared.
 *
 * Pinned on a real provisioned project, through a person's migration on
 * production and an agent's on a preview branch: the column gets what the
 * statement declares and nothing its name suggests.
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
import { POST as mcp } from '@/app/api/mcp/tool/route'
import { createBranch } from '@/lib/branches/engine'
import { withChangeAttribution } from '@/lib/changes/attribution'
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'
import { closeChangeLockPool } from '@/lib/changes/lock'

let ownerId: string
let projectId: string
let mainSchema: string
let mcpKey: string
const env = { BACKENLY_EDITION: process.env.BACKENLY_EDITION, ENGINE_MODE: process.env.ENGINE_MODE }

async function migrated(sql: string) {
  const out = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    applyMigrationToMain(projectId, ownerId, sql, { agentSurface: false, workspaceSchema: mainSchema }),
  )
  if (!out.ok) throw new Error(`"${sql}" did not apply: ${JSON.stringify(out)}`)
  return out
}

async function rules(schema: string, table: string): Promise<Array<{ name: string; definition: string }>> {
  return prisma.$queryRawUnsafe(
    `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND c.contype <> 'p'`,
    schema,
    table,
  )
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (await prisma.user.create({
    data: { email: `add-col-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'add-column-as-written', userId: ownerId })
  projectId = project.id
  mainSchema = project.postgresSchema
  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })
  await migrated('CREATE TABLE teams (name text)')
  await migrated('CREATE TABLE shop_orders (total integer)')
}, 240_000)

afterAll(async () => {
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  const schemas = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}%'`,
  ).catch(() => [])
  for (const s of schemas) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s.nspname}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  await closeChangeLockPool()
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}, 120_000)

it('adds a column on production with nothing its name suggests', async () => {
  await migrated('ALTER TABLE shop_orders ADD COLUMN customer_email text')
  await migrated('ALTER TABLE shop_orders ADD COLUMN team_id uuid')
  expect(await rules(mainSchema, 'shop_orders')).toEqual([])

  // What the statement declares is still added, exactly.
  await migrated('ALTER TABLE shop_orders ADD COLUMN coupon_code text UNIQUE')
  expect(await rules(mainSchema, 'shop_orders')).toEqual([{ name: 'shop_orders_coupon_code_key', definition: 'UNIQUE (coupon_code)' }])
}, 120_000)

it('adds one on a preview branch the same way', async () => {
  const created = await createBranch(projectId, ownerId, 'add-columns')
  if (!created.ok) throw new Error(`createBranch failed: ${(created as any).error}`)
  const branch = (created as any).branch as { id: string; schemaName: string }

  const res = await mcp(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
    body: JSON.stringify({ tool: 'apply_migration', args: { branchId: branch.id, sql: 'ALTER TABLE shop_orders ADD COLUMN notify_email text' } }),
  }))
  const body = await res.json() as any
  expect({ status: res.status, ok: body.ok }).toEqual({ status: 200, ok: true })
  expect((await rules(branch.schemaName, 'shop_orders')).map((r) => r.definition)).not.toContain('UNIQUE (notify_email)')
}, 240_000)
