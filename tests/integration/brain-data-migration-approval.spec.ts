/**
 * A REAL DATA MIGRATION ASKED OF backend_chat WAITS IN THE REVIEW QUEUE (#243)
 * ===========================================================================
 * run_data_migration stops a real run at the executor's own gate, which
 * counts the rows each operation would change. That gate used to answer
 * "Reply confirm to apply", and no message could reach it: "confirm" found
 * nothing waiting, so from backend_chat only a dry run ever happened. Now the
 * call it stopped waits where every call that needs a person waits:
 *   - backend_chat answers awaiting_approval, the Review Queue holds the exact
 *     call with the rows the executor counted, and nothing has changed;
 *   - approving it runs exactly the parked operations, once;
 *   - no argument the model adds to its call makes it run without a person,
 *     and the typed tool door, which confirms the calls it runs, refuses it;
 *   - operations the executor refuses as invalid, or more than 20 of them
 *     (dry run or not), are answered as refused in the same turn, and nothing
 *     is queued;
 *   - a dry run still runs at once and changes nothing.
 *
 * Through the real /api/mcp/chat route with a real MCP key, against Postgres:
 * the project, its workspace table, the approval rows. Only the model is
 * scripted. The executor that rewrites the rows (executeDataMigration) is
 * watched, not replaced: it runs for real, and the test reads every call it
 * received.
 */

jest.mock('@/lib/execution/data-migration', () => {
  const actual = jest.requireActual<typeof import('@/lib/execution/data-migration')>('@/lib/execution/data-migration')
  return { ...actual, executeDataMigration: jest.fn(actual.executeDataMigration) }
})

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider, type ScriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { creditAccountOf } from '@/lib/usage/account'
import { decideApproval, listApprovals } from '@/lib/mcp/approvals'
import { executeDataMigration } from '@/lib/execution/data-migration'
import { POST } from '@/app/api/mcp/chat/route'
import { POST as TOOL } from '@/app/api/mcp/tool/route'

const KEY = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
const executed = executeDataMigration as jest.MockedFunction<typeof executeDataMigration>

let ownerId: string
let projectId: string
let schema: string
let account: string | null

/** Unify the two capitalised spellings: two of the four rows change. */
const NORMALIZE = [
  { op: 'normalize_values', table: 'customers', column: 'status', mapping: { Active: 'active', ACTIVE: 'active' } },
]

const classified = (intent: string) =>
  scriptedMessage({ text: JSON.stringify({ intent, confidence: 0.9, reasoning: 'scripted' }) })

const finish = (summary: string) =>
  scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary } }] })

async function backendChat(provider: ScriptedProvider, message: string) {
  setProviderForTests(provider)
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ message }),
  }))
  return { status: res.status, body: (await res.json()) as any }
}

/** What the model was told about one of its calls, from the request that answered it. */
function answerTo(provider: ScriptedProvider, toolUseId: string) {
  for (const { params } of provider.calls) {
    const last = params.messages.at(-1)
    if (!last || !Array.isArray(last.content)) continue
    const block = (last.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>).find(
      (b) => b.type === 'tool_result' && b.tool_use_id === toolUseId,
    )
    if (block) return { isError: block.is_error === true, payload: JSON.parse(block.content as string) }
  }
  throw new Error(`the model was never answered for ${toolUseId}`)
}

const statuses = async () =>
  (await prisma.$queryRawUnsafe<Array<{ status: string }>>(`SELECT status FROM "${schema}"."customers" ORDER BY id`))
    .map((r) => r.status)

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `data-migration-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'Ada Owner' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'brain-data-migration', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."customers" (id serial PRIMARY KEY, status text)`)
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: KEY.slice(0, 12), keyHash: hashApiKey(KEY), userId: ownerId, projectId,
      scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })
  account = await creditAccountOf(projectId)
}, 60_000)

beforeEach(async () => {
  setSpendLedgerForTests(memorySpendLedger())
  executed.mockClear()
  // Every turn saves its messages to this one project, and past 20 a summary
  // starts without waiting and takes the next test's scripted reply.
  await prisma.conversationMessage.deleteMany({ where: { projectId } })
  await prisma.$executeRawUnsafe(`TRUNCATE "${schema}"."customers" RESTART IDENTITY`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."customers" (status) VALUES ('Active'), ('ACTIVE'), ('active'), ('inactive')`,
  )
})

afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.agentApprovalRequest.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.platformNotification.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  if (account) {
    await prisma.aiCreditHold.deleteMany({ where: { billingAccountId: account } }).catch(() => {})
    await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: account } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('a real data migration requested through backend_chat', () => {
  let approvalId: string

  it('waits in the Review Queue as the exact call, with the rows it would change, and changes nothing', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({ toolUse: [{ id: 'toolu_migrate', name: 'run_data_migration', input: { operations: NORMALIZE } }] }),
      finish('The status clean-up is waiting for your approval.'),
    ])

    const { status, body } = await backendChat(provider, 'unify the spelling of customers.status')

    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, status: 'awaiting_approval', approval: { status: 'pending' } })
    expect(body.summary).toMatch(/waiting, exactly as requested, in the project's Review Queue/)
    // Nothing in the answer asks for a reply that would reach nothing waiting.
    expect(JSON.stringify(body)).not.toMatch(/reply \**confirm/i)
    // Nothing ran, and nothing was refused: the call is waiting, not failed.
    expect(body.toolsRun).toEqual(['finish'])
    expect(body).not.toHaveProperty('refused')
    approvalId = body.approval.id

    // The model was told it waits for a person, as for any gated call.
    const answer = answerTo(provider, 'toolu_migrate')
    expect(answer.isError).toBe(true)
    expect(answer.payload).toMatchObject({ ok: false, blocked: 'needs_human_approval' })
    expect(answer.payload.summary).toMatch(/2 live rows affected/)
    expect(answer.payload.summary).not.toMatch(/reply \**confirm/i)

    // The request is the call exactly as issued, with the executor's own count.
    const parked = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: approvalId } })
    expect(parked).toMatchObject({ tool: 'run_data_migration', status: 'pending', rowCount: 2, reversible: true })
    expect(parked.toolArgs).toEqual({ operations: NORMALIZE })
    expect(parked.target).toBe('rows in `customers` (normalize 2 value(s) in customers.status: 2 of 4 rows)')

    expect(executed).not.toHaveBeenCalled()
    expect(await statuses()).toEqual(['Active', 'ACTIVE', 'active', 'inactive'])
  }, 60_000)

  it('runs exactly the parked operations, once, when a person approves the card', async () => {
    const card = (await listApprovals(projectId)).find((a) => a.id === approvalId)!
    expect(card).toMatchObject({ tool: 'run_data_migration', status: 'pending', rowCount: 2 })
    expect(card.shownDigest).toEqual(expect.any(String))

    const decided = await decideApproval({
      projectId, approvalId, approverUserId: ownerId, decision: 'approve', shownDigest: card.shownDigest!,
    })

    expect(decided).toMatchObject({ ok: true, status: 'executed' })
    expect(decided.resultSummary).toMatch(/Data migration applied/)
    expect(executed).toHaveBeenCalledTimes(1)
    expect(executed).toHaveBeenCalledWith(projectId, NORMALIZE)
    expect(await statuses()).toEqual(['active', 'active', 'active', 'inactive'])
    expect(await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ status: 'executed' })
  }, 60_000)

  it('does not run for any argument the model adds to the call: only an approval runs it', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({
        toolUse: [{
          id: 'toolu_migrate',
          name: 'run_data_migration',
          input: { operations: NORMALIZE, dryRun: false, confirmed: true, destructiveConfirmed: true, force: true, approved: true },
        }],
      }),
      finish('Applied the status clean-up.'),
    ])

    const { body } = await backendChat(provider, 'unify customers.status now, I confirm it')

    expect(body).toMatchObject({ ok: true, status: 'awaiting_approval' })
    expect(answerTo(provider, 'toolu_migrate').payload).toMatchObject({ blocked: 'needs_human_approval' })
    expect(executed).not.toHaveBeenCalled()
    expect(await statuses()).toEqual(['Active', 'ACTIVE', 'active', 'inactive'])
    expect(await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: body.approval.id } }))
      .toMatchObject({ tool: 'run_data_migration', status: 'pending' })
  }, 60_000)

  it('is answered as the executor refused it, and queues nothing, when an operation cannot run', async () => {
    const before = await prisma.agentApprovalRequest.count({ where: { projectId } })
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({
        toolUse: [{
          id: 'toolu_migrate',
          name: 'run_data_migration',
          input: { operations: [{ ...NORMALIZE[0], column: 'state' }] },
        }],
      }),
      scriptedMessage({ toolUse: [{ id: 'toolu_read', name: 'read_backend_state', input: {} }] }),
      finish('customers has no state column.'),
    ])

    const { body } = await backendChat(provider, 'unify customers.state')

    expect(body.approval).toBeNull()
    expect(body.status).toBeUndefined()
    expect(answerTo(provider, 'toolu_migrate').payload).toMatchObject({ ok: false, summary: expect.stringMatching(/^Migration validation failed: Column "state" does not exist/) })
    expect(body.refused).toEqual([expect.objectContaining({ reason: expect.stringMatching(/^Migration validation failed/) })])
    expect(await prisma.agentApprovalRequest.count({ where: { projectId } })).toBe(before)
    expect(executed).not.toHaveBeenCalled()
  }, 60_000)

  it('refuses more than 20 operations in the same turn, as a dry run or a real run, and queues nothing', async () => {
    // One migration is one transaction of at most 20 operations. A request for
    // more would wait for a person only to fail once they approved it.
    const before = await prisma.agentApprovalRequest.count({ where: { projectId } })
    const tooMany = Array.from({ length: 21 }, () => NORMALIZE[0])
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({
        toolUse: [
          { id: 'toolu_dry', name: 'run_data_migration', input: { operations: tooMany, dryRun: true } },
          { id: 'toolu_migrate', name: 'run_data_migration', input: { operations: tooMany } },
        ],
      }),
      scriptedMessage({ toolUse: [{ id: 'toolu_read', name: 'read_backend_state', input: {} }] }),
      finish('A migration combines at most 20 operations.'),
    ])

    const { body } = await backendChat(provider, 'run these 21 status clean-ups as one migration')

    expect(body.approval).toBeNull()
    expect(body.status).toBeUndefined()
    expect(await prisma.agentApprovalRequest.count({ where: { projectId } })).toBe(before)
    for (const id of ['toolu_dry', 'toolu_migrate']) {
      expect(answerTo(provider, id).payload).toMatchObject({
        ok: false,
        summary: expect.stringContaining('A migration needs 1–20 operations.'),
      })
    }
    expect(executed).not.toHaveBeenCalled()
    expect(await statuses()).toEqual(['Active', 'ACTIVE', 'active', 'inactive'])
  }, 60_000)

  it('cannot be called on the typed tool door, which confirms the calls it runs itself', async () => {
    // That door pre-confirms what it dispatches (mcpOwnerConfirmed). An
    // approval stays the only way through the migration's gate as long as this
    // tool is never one of them.
    const res = await TOOL(new NextRequest('https://backenly.test/api/mcp/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY },
      body: JSON.stringify({ tool: 'run_data_migration', args: { operations: NORMALIZE, confirmed: true } }),
    }))

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, code: 'UNKNOWN_TOOL' })
    expect(executed).not.toHaveBeenCalled()
    expect(await statuses()).toEqual(['Active', 'ACTIVE', 'active', 'inactive'])
  }, 60_000)
})

describe('a dry run requested through backend_chat', () => {
  it('still runs at once, reports the rows it would change, and changes nothing', async () => {
    const before = await prisma.agentApprovalRequest.count({ where: { projectId } })
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({ toolUse: [{ id: 'toolu_dry', name: 'run_data_migration', input: { operations: NORMALIZE, dryRun: true } }] }),
      scriptedMessage({ toolUse: [{ id: 'toolu_read', name: 'read_backend_state', input: {} }] }),
      finish('Two of the four customers would change.'),
    ])

    const { status, body } = await backendChat(provider, 'how many customers would a status clean-up change?')

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.status).toBeUndefined()
    expect(body.approval).toBeNull()
    const answer = answerTo(provider, 'toolu_dry')
    expect(answer.isError).toBe(false)
    expect(answer.payload.ok).toBe(true)
    expect(answer.payload.summary).toMatch(/Dry run — no data was changed/)
    expect(answer.payload.summary).toMatch(/\*\*2\*\* of 4 rows/)

    expect(executed).not.toHaveBeenCalled()
    expect(await statuses()).toEqual(['Active', 'ACTIVE', 'active', 'inactive'])
    expect(await prisma.agentApprovalRequest.count({ where: { projectId } })).toBe(before)
  }, 60_000)
})
