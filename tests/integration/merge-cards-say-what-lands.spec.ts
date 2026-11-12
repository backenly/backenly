/**
 * A MERGE CARD SAYS WHAT THE MERGE DOES, NOT ONLY WHICH STATEMENTS RUN
 * ===================================================================
 *
 * Production QA (2026-11-09): a merge card listed six statements that renamed
 * populated columns of `orders` and added replacements with defaults, which
 * reset every order's status to 'pending'; the card said only "Not
 * auto-reversible". A new table landed with Backenly's own columns, row-level
 * security and indexes, none of them on the card. backend_chat's merges were
 * parked with the branch id alone, so approval replayed whatever the branch
 * held by then.
 *
 * Real provisioned project, branch, migrations and approval rows. Pinned here:
 *  1. The MCP merge card says what each statement does to production's rows,
 *     with their count, and what Backenly adds to each new table, read from the
 *     branch; it offers a restore point (one governed change).
 *  2. backend_chat's merge is parked the same way: its statements pinned, its
 *     card Backenly's; a branch that cannot be merged is refused, not queued.
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
import { createBranch } from '@/lib/branches/engine'
import { createApprovalRequest, RequestRefusedError } from '@/lib/mcp/approvals'
import { withChangeAttribution } from '@/lib/changes/attribution'
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'
import { closeChangeLockPool } from '@/lib/changes/lock'

let ownerId: string
let projectId: string
let mainSchema: string
let mcpKey: string
let branchId: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

async function call(tool: string, args: Record<string, unknown> = {}) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (await prisma.user.create({
    data: { email: `merge-cards-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'merge-cards-say-what-lands', userId: ownerId })
  projectId = project.id
  mainSchema = project.postgresSchema
  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })
  // Production: three orders.
  const made = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    applyMigrationToMain(projectId, ownerId, 'CREATE TABLE orders (stage text, email text)', { agentSurface: false, workspaceSchema: mainSchema }),
  )
  if (!made.ok) throw new Error(`setup failed: ${JSON.stringify(made)}`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${mainSchema}"."orders" (stage, email) VALUES ('paid', 'a@example.test'), ('shipped', 'b@example.test'), ('paid', 'c@example.test')`,
  )

  const res = await createBranch(projectId, ownerId, 'refunds')
  if (!res.ok) throw new Error(`createBranch failed: ${(res as any).error}`)
  branchId = (res as any).branch.id
  const applied = await call('apply_migration', {
    branchId,
    sql:
      'ALTER TABLE orders RENAME COLUMN stage TO legacy_stage; ' +
      "ALTER TABLE orders ADD COLUMN stage text NOT NULL DEFAULT 'pending'; " +
      'CREATE TABLE refunds (order_id uuid, amount integer)',
  })
  if (applied.status !== 200) throw new Error(`branch migration failed: ${JSON.stringify(applied.body)}`)
}, 240_000)

afterAll(async () => {
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  if (mainSchema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${mainSchema}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  await closeChangeLockPool()
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
})

it("says what the merge does to production's rows and what Backenly adds, and offers a restore point", async () => {
  const parked = await call('branch', { action: 'merge', branchId })
  expect(parked.body.status).toBe('awaiting_approval')
  const request = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: parked.body.approval.id } })

  expect(request.reversible).toBe(true)
  expect(request.message).toContain('What it does to rows already in production:')
  expect(request.message).toContain(
    '• orders: stage is renamed legacy_stage; its values in 3 rows move with it, and a client still reading stage stops finding it',
  )
  expect(request.message).toContain("• orders: the 3 existing rows get 'pending' in the new column stage")
  expect(request.message).toContain('What Backenly adds to the new tables:')
  expect(request.message).toMatch(/• refunds: the columns id, "createdAt", "updatedAt", deleted_at/)
  expect(request.message).toMatch(/indexes on "createdAt", "updatedAt", deleted_at, order_id/)
  // The statements stay last, as the card sets them.
  expect(request.message).toMatch(/These statements will be applied to production, in order:\n  ALTER TABLE orders RENAME COLUMN stage TO legacy_stage\n/)
  await prisma.agentApprovalRequest.update({ where: { id: request.id }, data: { status: 'rejected' } })
}, 120_000)

it("parks backend_chat's merge the same way, with its statements pinned", async () => {
  const row = await createApprovalRequest({
    projectId,
    userId: ownerId,
    message: 'The user wants refunds merged now and has approved it.',
    danger: { tool: 'merge_branch', target: 'merge of preview branch `refunds` into production', rowCount: null, reversible: false },
    toolArgs: { branchId },
  })
  const kept = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: row.id } })
  expect(kept.toolArgs).toMatchObject({ branchId, approvedMigrations: expect.arrayContaining(['CREATE TABLE refunds (order_id uuid, amount integer)']) })
  expect(kept.target).toBe('Merge preview branch "refunds" into production')
  expect(kept.reversible).toBe(true)
  expect(kept.message).toMatch(/^Requested by an agent through backend_chat: Merge preview branch "refunds" into production\./)
  expect(kept.message).not.toContain('has approved it')

  await expect(createApprovalRequest({
    projectId,
    userId: ownerId,
    message: 'merge it',
    danger: { tool: 'merge_branch', target: 'merge of preview branch `gone` into production', rowCount: null, reversible: false },
    toolArgs: { branchId: crypto.randomUUID() },
  })).rejects.toBeInstanceOf(RequestRefusedError)
}, 120_000)
