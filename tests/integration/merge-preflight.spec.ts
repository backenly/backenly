/**
 * A MERGE THAT WOULD FAIL ON PRODUCTION'S ROWS IS NOT PUT TO A PERSON
 * ===================================================================
 *
 * A branch is cut without production's rows and records a foreign key without
 * enforcing it, so statements that hold there can fail on production. On
 * production (2026-11-09) a merge a person approved failed part-way and was
 * recovered: they had approved a change that could not land.
 *
 * Real provisioned project and branches; production's `bookings` has a row
 * with no stage, two rows sharing a contact, a stage outside a new CHECK, and
 * a reference to no customer. Pinned here:
 *  1. Each kind of statement that would fail on those rows is named, the
 *     merge is refused with MERGE_WOULD_FAIL, and nothing is queued, through
 *     MCP and through backend_chat's door.
 *  2. Column names are followed through a rename earlier in the same merge:
 *     a UNIQUE on a new, empty column is fine, one on the renamed populated
 *     column is not.
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

async function branchWith(name: string, sql: string): Promise<string> {
  const res = await createBranch(projectId, ownerId, name)
  if (!res.ok) throw new Error(`createBranch failed: ${(res as any).error}`)
  const id = (res as any).branch.id
  const applied = await call('apply_migration', { branchId: id, sql })
  if (applied.status !== 200) throw new Error(`branch migration failed: ${JSON.stringify(applied.body)}`)
  return id
}

const person = (sql: string) =>
  withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    applyMigrationToMain(projectId, ownerId, sql, { agentSurface: false, workspaceSchema: mainSchema }),
  )

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (await prisma.user.create({
    data: { email: `merge-preflight-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'merge-preflight', userId: ownerId })
  projectId = project.id
  mainSchema = project.postgresSchema
  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })
  for (const sql of ['CREATE TABLE customers (label text)', 'CREATE TABLE bookings (stage text, contact text, customer_ref uuid)']) {
    const out = await person(sql)
    if (!out.ok) throw new Error(`setup failed: ${JSON.stringify(out)}`)
  }
  const [customer] = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO "${mainSchema}"."customers" (label) VALUES ('ada') RETURNING id::text`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${mainSchema}"."bookings" (stage, contact, customer_ref) VALUES
       ('paid', 'a@example.test', $1::uuid),
       (NULL, 'a@example.test', $2::uuid),
       ('pending', 'b@example.test', NULL)`,
    customer.id, crypto.randomUUID(),
  )
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

it("refuses a merge whose statements held on the empty branch but would fail on production's rows, naming each", async () => {
  const branchId = await branchWith(
    'strict',
    'ALTER TABLE bookings ALTER COLUMN stage SET NOT NULL; ' +
    'ALTER TABLE bookings ADD CONSTRAINT one_contact UNIQUE (contact); ' +
    'ALTER TABLE bookings ADD COLUMN placed_by text NOT NULL; ' +
    "ALTER TABLE bookings ADD CONSTRAINT stage_known CHECK (stage IN ('paid', 'shipped')); " +
    'ALTER TABLE bookings ADD FOREIGN KEY (customer_ref) REFERENCES customers(id)',
  )
  const requests = await prisma.agentApprovalRequest.count({ where: { projectId } })

  const parked = await call('branch', { action: 'merge', branchId })
  expect(parked.status).toBe(409)
  expect(parked.body).toMatchObject({ ok: false, code: 'MERGE_WOULD_FAIL' })
  const error = String(parked.body.error)
  expect(error).toContain('bookings has rows with no value in stage, so it cannot be made NOT NULL')
  expect(error).toContain('bookings has rows that share a value of contact, so it cannot be made UNIQUE')
  expect(error).toContain('bookings has rows, and placed_by is added NOT NULL with no default, so they would have no value for it')
  expect(error).toMatch(/bookings has rows that break CHECK \(stage IN \('paid', ?'shipped'\)\)/)
  expect(error).toContain('bookings has rows whose customer_ref matches no customers.id, so the foreign key cannot be added')
  expect(parked.body.hint).toMatch(/without production's rows/)
  expect(await prisma.agentApprovalRequest.count({ where: { projectId } })).toBe(requests)

  // backend_chat's door refuses the same merge, and queues nothing either.
  await expect(createApprovalRequest({
    projectId,
    userId: ownerId,
    message: 'merge it',
    danger: { tool: 'merge_branch', target: 'merge of preview branch `strict` into production', rowCount: null, reversible: false },
    toolArgs: { branchId },
  })).rejects.toMatchObject({ code: 'MERGE_WOULD_FAIL' })
  await expect(createApprovalRequest({
    projectId,
    userId: ownerId,
    message: 'merge it',
    danger: { tool: 'merge_branch', target: 'x', rowCount: null, reversible: false },
    toolArgs: { branchId },
  })).rejects.toBeInstanceOf(RequestRefusedError)
  expect(await prisma.agentApprovalRequest.count({ where: { projectId } })).toBe(requests)
}, 240_000)

it('follows a column through a rename: a UNIQUE on the new empty column is fine, one on the renamed populated column is not', async () => {
  const fine = await branchWith(
    'fresh-contact',
    'ALTER TABLE bookings RENAME COLUMN contact TO legacy_contact; ' +
    'ALTER TABLE bookings ADD COLUMN contact text; ' +
    'ALTER TABLE bookings ADD CONSTRAINT one_contact UNIQUE (contact)',
  )
  const parked = await call('branch', { action: 'merge', branchId: fine })
  expect(parked.body.status).toBe('awaiting_approval')

  const broken = await branchWith(
    'legacy-unique',
    'ALTER TABLE bookings RENAME COLUMN contact TO legacy_contact; ' +
    'ALTER TABLE bookings ADD CONSTRAINT one_legacy UNIQUE (legacy_contact)',
  )
  const refused = await call('branch', { action: 'merge', branchId: broken })
  expect(refused.body).toMatchObject({ code: 'MERGE_WOULD_FAIL' })
  expect(String(refused.body.error)).toContain('bookings has rows that share a value of legacy_contact, so it cannot be made UNIQUE')
}, 240_000)
