/**
 * AN AGENT DISCARDS ITS OWN PREVIEW BRANCH
 * ========================================
 *
 * Production QA (2026-11-09, report 81): the MCP branch tool had no discard,
 * so an agent's cleanup went through backend_chat (AI credits) and waited on a
 * person's approval for each branch. It reached 6 branches on a plan with 5.
 *
 * Discarding drops the branch's own schema and ends its keys. Nothing of
 * production's is touched, so it runs at once, the way Supabase's and Neon's
 * MCP servers offer delete_branch. The console's refusals still apply: only an
 * active or merged branch of this project, never a schema the branch registry
 * does not own, and never from a read-only key.
 *
 * Against a real database, the real /api/mcp/tool route and the real branch
 * engine. Only PostgREST's schema registry is stubbed, as in
 * branch-migrations.spec.ts.
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
import { createBranch } from '@/lib/branches/engine'
import { mintPreviewKey } from '@/lib/branches/preview'
import { needsApproval } from '@/lib/mcp/domains'
import { buildCatalog } from '@/lib/mcp/catalog'

let ownerId: string
let projectId: string
let mainSchema: string
let otherProjectId: string
let otherSchema: string
let writeKey: string
let readKey: string
const originalEdition = process.env.BACKENLY_EDITION

async function mcpKey(readOnly: boolean): Promise<string> {
  const key = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: readOnly ? 'reader' : 'agent', keyPrefix: key.slice(0, 12), keyHash: hashApiKey(key),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: readOnly, permissions: [], capabilities: [],
    },
  })
  return key
}

async function branch(args: Record<string, unknown>, key = writeKey) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ tool: 'branch', args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

async function schemaExists(schema: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = ${schema}`
  return rows[0].n > 0
}

/** A branch with a preview key, as an agent makes them. */
async function branchWithKey(project: string, name: string) {
  const made = await createBranch(project, ownerId, name)
  if (!made.ok) throw new Error((made as { error: string }).error)
  const b = (made as any).branch as { id: string; schemaName: string }
  const key = await mintPreviewKey(project, b.id)
  if (!key.ok) throw new Error('could not mint a preview key')
  return b
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({
    data: { email: `discard-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'agents-discard-branches', userId: ownerId })
  projectId = project.id
  mainSchema = project.postgresSchema
  const other = await createProvisionedProject({ name: 'someone-elses', userId: ownerId })
  otherProjectId = other.id
  otherSchema = other.postgresSchema
  writeKey = await mcpKey(false)
  readKey = await mcpKey(true)
  const made = await dispatchTool('create_table', {
    tableName: 'orders',
    columns: [{ name: 'total', type: 'integer' }],
  }, { projectId, userId: ownerId, createdThisTurn: new Set<string>() })
  if (!made.ok) throw new Error(`setup create_table failed: ${made.summary}`)
}, 180_000)

afterAll(async () => {
  const branches = await prisma.workspaceBranch.findMany({
    where: { projectId: { in: [projectId, otherProjectId] } }, select: { schemaName: true },
  }).catch(() => [])
  for (const b of branches) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  for (const s of [mainSchema, otherSchema]) {
    if (s) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
  }
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
}, 180_000)

describe('branch { action: "discard" }', () => {
  it('drops the branch and ends its keys at once, waiting on nobody, and leaves production alone', async () => {
    const scratch = await branchWithKey(projectId, 'scratch-work')
    const approvalsBefore = await prisma.agentApprovalRequest.count({ where: { projectId } })

    const { status, body } = await branch({ action: 'discard', branchId: scratch.id })

    expect({ status, ok: body.ok }).toEqual({ status: 200, ok: true })
    expect(await schemaExists(scratch.schemaName)).toBe(false)
    expect((await prisma.workspaceBranch.findUnique({ where: { id: scratch.id } }))?.status).toBe('discarded')
    const keys = await prisma.apiKey.findMany({ where: { branchId: scratch.id }, select: { expiresAt: true } })
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(k.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now())
    expect(await prisma.agentApprovalRequest.count({ where: { projectId } })).toBe(approvalsBefore)
    expect(await schemaExists(mainSchema)).toBe(true)
    const orders = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = ${mainSchema} AND table_name = 'orders'`
    expect(orders[0].n).toBe(1)
  }, 120_000)

  it('is offered in the branch tool, and needs no approval through backend_chat either', () => {
    const schema: any = buildCatalog().find((t) => t.name === 'branch')!.inputSchema
    expect(schema.properties.action.enum).toContain('discard')
    expect(needsApproval('discard_branch')).toBe(false)
    // A merge changes production, so it still waits for a person.
    expect(needsApproval('merge_branch')).toBe(true)
  })

  it('refuses a read-only key, and the branch stays', async () => {
    const kept = await branchWithKey(projectId, 'read-only-try')
    const { status, body } = await branch({ action: 'discard', branchId: kept.id }, readKey)
    expect(status).toBe(403)
    expect(body.code).toBe('READ_ONLY_KEY')
    expect(await schemaExists(kept.schemaName)).toBe(true)
    expect((await prisma.workspaceBranch.findUnique({ where: { id: kept.id } }))?.status).toBe('active')
  }, 120_000)

  it('cannot reach another project’s branch', async () => {
    const theirs = await branchWithKey(otherProjectId, 'not-yours')
    const { body } = await branch({ action: 'discard', branchId: theirs.id })
    expect(body.ok).toBe(false)
    expect(await schemaExists(theirs.schemaName)).toBe(true)
    expect((await prisma.workspaceBranch.findUnique({ where: { id: theirs.id } }))?.status).toBe('active')
  }, 120_000)

  it('says what it needs when the branch id is missing', async () => {
    const { body } = await branch({ action: 'discard' })
    expect(body.ok).toBe(false)
    expect(JSON.stringify(body)).toMatch(/branchId/)
  })
})
