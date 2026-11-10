/**
 * AN AGENT DELETES A FUNCTION NOTHING CALLS, AT ONCE
 * ==================================================
 *
 * Production QA (2026-11-09, report 46): deleting any function waited for a
 * person's approval, even a switched-off debug one, so agents left their own
 * clutter behind; and every table came with a `<table>-schema` function
 * nobody asked for.
 *
 * A delete is a governed change that keeps the function, so restoring it
 * brings the function back. A function that is switched off, or has not run
 * in 7 days, is now deleted at once, on both doors (the MCP tool and
 * backend_chat); one that ran in that time still waits for a person. A new
 * table gets no `<table>-schema` function.
 *
 * Real ledger, real project, the real /api/mcp/tool route and brain loop; only
 * the model is scripted.
 */
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER', logRetentionDays: 7 }) }
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
import { withChangeAttribution } from '@/lib/changes/ledger'
import { recoverChange } from '@/lib/changes/recovery'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { deployFunctionCode } from '@/lib/services/ai-functions/agent-actions'
import { executeAction } from '@/lib/ai/minimal-executor'
import { POST } from '@/app/api/mcp/tool/route'
import { runBrain } from '@/lib/ai/brain/agent'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { classified, finished, toolCall } from '../helpers/brain-harness'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string
let mcpKey: string
const original = { edition: process.env.BACKENLY_EDITION, engine: process.env.ENGINE_MODE }
const DAY = 24 * 60 * 60 * 1000

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `fn-delete-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'agents-delete-unused-functions', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })
}, 120_000)

afterAll(async () => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
  const vaults = await prisma.$queryRawUnsafe<{ nspname: string }[]>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = original.edition
  process.env.ENGINE_MODE = original.engine
}, 120_000)

/** A function an agent deployed, then left as `state` says. */
async function deployed(name: string, state: { status?: string; lastRun?: Date | null }) {
  const made = await withChangeAttribution({ source: 'mcp' }, () =>
    deployFunctionCode({ userId: ownerId, projectId }, { name, trigger: 'on_signup', code: `return { probe: '${name}' }` }))
  if (!made.ok) throw new Error(made.summary)
  // Its runs and switch are bookkeeping, as the runtime and set_active write them.
  await prisma.aiFunction.updateMany({ where: { projectId, name }, data: { status: state.status ?? 'active', lastRun: state.lastRun ?? null } })
}

const fnRow = (name: string) => prisma.aiFunction.findFirst({ where: { projectId, name }, select: { generatedCode: true } })
const approvals = () => prisma.agentApprovalRequest.count({ where: { projectId } })

async function mcpDelete(name: string) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
    body: JSON.stringify({ tool: 'functions', args: { action: 'delete', name } }),
  }))
  return { status: res.status, body: await res.json() as any }
}

describe('functions { action: "delete" } over MCP', () => {
  it('deletes a switched-off function at once, and restoring the change brings it back', async () => {
    await deployed('debug-probe', { status: 'inactive', lastRun: new Date(Date.now() - DAY) })
    const before = await approvals()

    const { status, body } = await mcpDelete('debug-probe')

    expect({ status, ok: body.ok }).toEqual({ status: 200, ok: true })
    expect(body.status).not.toBe('awaiting_approval')
    expect(await fnRow('debug-probe')).toBeNull()
    expect(await approvals()).toBe(before)
    const change = body.data?.change as { id: string; seq: number }
    expect(change).toEqual({ id: expect.any(String), seq: expect.any(Number) })
    expect(body.summary).toContain(`It is kept in the change history as change #${change.seq}`)

    expect(await recoverChange(projectId, change.id, { mode: 'manual', actorUserId: ownerId, acknowledged: null })).toMatchObject({ ok: true })
    expect(await fnRow('debug-probe')).toEqual({ generatedCode: "return { probe: 'debug-probe' }" })
  }, 120_000)

  it('deletes an active function at once when it has not run in 7 days', async () => {
    await deployed('old-report', { lastRun: new Date(Date.now() - 8 * DAY) })
    const { body } = await mcpDelete('old-report')
    expect(body.ok).toBe(true)
    expect(await fnRow('old-report')).toBeNull()
  }, 120_000)

  it('holds a function that ran in the last 7 days for a person, and changes nothing', async () => {
    await deployed('send-welcome', { lastRun: new Date(Date.now() - 60 * 60 * 1000) })
    const before = await approvals()
    const { body } = await mcpDelete('send-welcome')
    expect(body.status).toBe('awaiting_approval')
    expect(await approvals()).toBe(before + 1)
    expect(await fnRow('send-welcome')).not.toBeNull()
  }, 120_000)
})

describe('backend_chat', () => {
  it('applies the same rule: a function nothing calls is deleted, not held', async () => {
    await deployed('scratch-fn', { lastRun: null })
    setSpendLedgerForTests(memorySpendLedger())
    setProviderForTests(scriptedProvider([
      classified('MODIFY'),
      toolCall('delete_ai_function', { name: 'scratch-fn' }),
      finished('Deleted scratch-fn.'),
    ]))
    const result = await runBrain({ projectId, userId: ownerId, message: 'delete the scratch-fn function, nothing uses it' }, () => {})
    expect(result.blockedCalls ?? []).toEqual([])
    expect(result.toolsRun).toContain('delete_ai_function')
    expect(await fnRow('scratch-fn')).toBeNull()
  }, 120_000)
})

describe('a new table', () => {
  it('gets no validation schema function', async () => {
    const made: any = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      executeAction({ action: 'CREATE_TABLE', params: { tableName: 'reviews', columns: [{ name: 'body', type: 'text' }] } } as any, projectId, undefined, 0, undefined, false))
    expect(made.success).toBe(true)
    expect(await fnRow('reviews-schema')).toBeNull()
  }, 120_000)
})
