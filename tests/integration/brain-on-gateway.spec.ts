/**
 * The brain runs on the AI gateway (lib/ai/llm), end to end.
 *
 * Real database: the project, its workspace schema, the conversation log, the
 * usage rows and the tables a refused or cut-off step must leave untouched.
 * Only the model is scripted, so each test pins exactly what the brain sent
 * and what it did with each answer.
 *
 * Spend reservations go to the gateway's in-memory ledger. The Postgres ledger
 * has its own suite (tests/integration/ai-spend-ledger.spec.ts); writing this
 * suite's calls into the current month of a shared test database would leave
 * spend behind that no test can safely subtract.
 */

import crypto from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/db/prisma'
import { AiError, setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider, type ScriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests, type MemorySpendLedger } from '@/lib/ai/llm/spend'
import { classifierPrompt } from '@/lib/ai/brain/prompts'
import { BRAIN_MODEL_TOOLS } from '@/lib/ai/brain/tools'
import { runBrain, type BrainEvent, type BrainInput } from '@/lib/ai/brain/agent'
import { collectProof } from '@/lib/ai/proof-system'

jest.mock('@/lib/ai/proof-system', () => {
  const actual = jest.requireActual<typeof import('@/lib/ai/proof-system')>('@/lib/ai/proof-system')
  return { ...actual, collectProof: jest.fn(actual.collectProof) }
})

let ownerId: string
let projectId: string
let schema: string
let ledger: MemorySpendLedger

const classified = (intent: string) =>
  scriptedMessage({ text: JSON.stringify({ intent, confidence: 0.9, reasoning: 'scripted' }) })

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    schema,
    name,
  )
  return rows[0].n > 0
}

async function turn(provider: ScriptedProvider, message: string, extra: Partial<BrainInput> = {}) {
  setProviderForTests(provider)
  const events: BrainEvent[] = []
  const spent: number[] = []
  const result = await runBrain(
    { projectId, userId: ownerId, message, onTokens: (n) => spent.push(n), ...extra },
    (e) => events.push(e),
  )
  return { result, events, spent }
}

/** Usage rows are written without waiting; give them a moment to land. */
async function usageRows(expected: number) {
  for (let i = 0; i < 50; i++) {
    const rows = await prisma.aiUsage.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } })
    if (rows.length >= expected) return rows
    await new Promise((r) => setTimeout(r, 100))
  }
  return prisma.aiUsage.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } })
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `brain-gw-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'brain' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'brain-on-gateway', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${schema}"."keep_me" (id serial PRIMARY KEY, label text)`)
}, 60_000)

beforeEach(async () => {
  ledger = memorySpendLedger()
  setSpendLedgerForTests(ledger)
  await prisma.aiUsage.deleteMany({ where: { projectId } })
  // Every turn saves its messages to this one project. Past 20, saveMessages
  // starts a summary without waiting, and that model call takes the next test's
  // scripted reply. Each test starts with no history.
  await prisma.conversationMessage.deleteMany({ where: { projectId } })
})

afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('a turn on the gateway', () => {
  it('classifies, runs tools, answers each call and bills what the model reports', async () => {
    const provider = scriptedProvider([
      classified('QUESTION'),
      scriptedMessage({
        thinking: 'Read the live state before answering.',
        toolUse: [{ id: 'toolu_read', name: 'read_backend_state', input: {} }],
        usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 16000 },
      }),
      scriptedMessage({
        toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'You have one table: keep_me.' } }],
        usage: { input_tokens: 300, output_tokens: 100, cache_read_input_tokens: 16000 },
      }),
    ])

    const { result, spent } = await turn(provider, 'what tables do I have?')

    expect(result).toMatchObject({ success: true, summary: 'You have one table: keep_me.' })
    expect(result.toolsRun).toEqual(['read_backend_state', 'finish'])
    expect(provider.calls).toHaveLength(3)

    // The classifier: one cached prompt, structured output, no thinking.
    const classify = provider.calls[0].params
    expect((classify.system as Anthropic.TextBlockParam[])[0]).toMatchObject({ text: classifierPrompt(), cache_control: { type: 'ephemeral' } })
    expect(classify.output_config?.format).toMatchObject({ type: 'json_schema' })
    expect(classify.thinking).toBeUndefined()

    // The loop: the catalog translated once with its last tool cached, the
    // stable prompt cached ahead of the turn's own context, thinking on, and
    // the conversation cached at its last block.
    const first = provider.calls[1].params
    expect(first.tools!.map((t) => (t as Anthropic.Tool).name)).toEqual(BRAIN_MODEL_TOOLS.map((t) => t.function.name))
    expect((first.tools!.at(-1) as Anthropic.Tool).cache_control).toEqual({ type: 'ephemeral' })
    const system = first.system as Anthropic.TextBlockParam[]
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(system[1].text).toMatch(/INTENT CLASSIFICATION \(advisory\): QUESTION/)
    expect(system[1].cache_control).toBeUndefined()
    expect(first.thinking).toEqual({ type: 'adaptive' })
    expect(first.output_config).toMatchObject({ effort: 'high' })
    expect(first.messages.at(-1)!.content).toEqual([
      { type: 'text', text: 'what tables do I have?', cache_control: { type: 'ephemeral' } },
    ])

    // The second step carries the first back exactly, thinking and signature
    // included, and answers its call in one user turn.
    const second = provider.calls[2].params.messages
    const assistant = second.at(-2)!
    expect(assistant.role).toBe('assistant')
    expect((assistant.content as Anthropic.ContentBlockParam[])[0]).toMatchObject({ type: 'thinking', signature: 'sig_scripted' })
    const answered = second.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    expect(answered).toHaveLength(1)
    expect(answered[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_read' })
    expect(answered[0]).not.toHaveProperty('is_error')
    expect(JSON.parse(answered[0].content as string)).toMatchObject({ ok: true })

    // Credits in cost-weighted tokens, reported as each step is spent: a cache
    // write costs 1.25 of a fresh token on Claude and a read 0.1.
    //   step 1: 1000 + 16000 × 1.25 + 200 = 21200
    //   step 2:  300 + 16000 × 0.1  + 100 =  2000
    expect(spent).toEqual([21200, 2000])
    expect(result.tokensUsed).toBe(23200)

    // Every call reserved its worst case and settled from the reported usage.
    const holds = [...ledger.holds.values()]
    expect(holds).toHaveLength(3)
    expect(holds.every((h) => h.status === 'settled')).toBe(true)

    // And every call wrote the project's usage row, named for what made it.
    const rows = await usageRows(3)
    expect(rows.map((r) => r.endpoint).sort()).toEqual(['brain-agent', 'brain-agent', 'brain-classify'])
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ endpoint: 'brain-agent', metadata: expect.objectContaining({ cacheWriteTokens: 16000 }) }),
        expect.objectContaining({ endpoint: 'brain-agent', metadata: expect.objectContaining({ cacheReadTokens: 16000 }) }),
      ]),
    )
  }, 60_000)

  it('stops a destructive call at the approval gate, answers it as an error, and returns it to queue', async () => {
    const provider = scriptedProvider([
      classified('DESTRUCTIVE'),
      scriptedMessage({ toolUse: [{ id: 'toolu_drop', name: 'drop_table', input: { tableName: 'keep_me' } }] }),
      scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'Queued for approval.' } }] }),
    ])

    const { result } = await turn(provider, 'drop the keep_me table')

    expect(await tableExists('keep_me')).toBe(true)
    expect(result.blockedCalls).toEqual([
      expect.objectContaining({ tool: 'drop_table', args: { tableName: 'keep_me' } }),
    ])
    expect(result.toolsRun).not.toContain('drop_table')
    const answered = provider.calls[2].params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    expect(answered[0]).toMatchObject({ tool_use_id: 'toolu_drop', is_error: true })
    expect(JSON.parse(answered[0].content as string)).toMatchObject({ ok: false, blocked: 'needs_human_approval' })
  }, 60_000)

  it('runs none of the calls in an answer cut off at its output limit', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({
        toolUse: [{ id: 'toolu_create', name: 'create_table', input: { tableName: 'half_written', columns: [] } }],
        stopReason: 'max_tokens',
      }),
    ])

    const { result } = await turn(provider, 'add a half_written table')

    expect(await tableExists('half_written')).toBe(false)
    expect(result).toMatchObject({ success: false, failureCode: 'MODEL_ERROR', retryable: true, toolsRun: [] })
    expect(result.summary).toMatch(/cut off at its output limit\. Nothing was modified\./)
    // It ran, so it is billed: 10 in + 5 out by the scripted default.
    expect(result.tokensUsed).toBe(15)
  }, 60_000)

  it('requires one catalog read after a mutation followed by a plain-text answer (#237)', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({
        toolUse: [{ id: 'toolu_create', name: 'create_table', input: { tableName: 'plain_text_verified', columns: [] } }],
      }),
      scriptedMessage({ text: 'The table has been created.' }),
      scriptedMessage({
        toolUse: [{ id: 'toolu_verify', name: 'read_backend_state', input: {} }],
      }),
      scriptedMessage({ text: 'The table is present in the backend state.' }),
    ])

    const { result } = await turn(provider, 'create a plain_text_verified table')

    expect(await tableExists('plain_text_verified')).toBe(true)
    expect(result).toMatchObject({ success: true, toolsRun: ['create_table', 'read_backend_state'] })

    // The original plain-text reply is retained before the verification steer,
    // so the model sees exactly the claim it must substantiate.
    const verificationMessages = provider.calls[3].params.messages
    expect(verificationMessages.at(-2)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'The table has been created.' }],
    })
    expect(verificationMessages.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('read_backend_state') }],
    })
  }, 60_000)

  it('does not replay a mutation while plain-text completion is awaiting verification (#237)', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({
        toolUse: [{ id: 'toolu_create', name: 'create_table', input: { tableName: 'first_mutation', columns: [] } }],
      }),
      scriptedMessage({ text: 'The first table has been created.' }),
      scriptedMessage({
        toolUse: [{ id: 'toolu_replay', name: 'create_table', input: { tableName: 'must_not_replay', columns: [] } }],
      }),
    ])

    const { result } = await turn(provider, 'create a first_mutation table')

    expect(await tableExists('first_mutation')).toBe(true)
    expect(await tableExists('must_not_replay')).toBe(false)
    expect(result).toMatchObject({
      success: false,
      failureCode: 'UNVERIFIED',
      retryable: false,
      toolsRun: ['create_table'],
      applied: ['Creating table first_mutation'],
    })
    expect(result.summary).toMatch(/could not verify/i)
  }, 60_000)

  it('reports an applied-but-unverified outcome after one ignored verification steer (#237)', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({
        toolUse: [{ id: 'toolu_create', name: 'create_table', input: { tableName: 'unverified_once', columns: [] } }],
      }),
      scriptedMessage({ text: 'The table has been created.' }),
      scriptedMessage({ text: 'Everything is complete.' }),
    ])

    const { result } = await turn(provider, 'create an unverified_once table')

    expect(await tableExists('unverified_once')).toBe(true)
    expect(provider.calls).toHaveLength(4)
    expect(result).toMatchObject({
      success: false,
      failureCode: 'UNVERIFIED',
      retryable: false,
      toolsRun: ['create_table'],
    })
    expect(result.summary).toMatch(/could not verify/i)
  }, 60_000)

  it('does not retry a failed verification read after a plain-text mutation exit (#237)', async () => {
    const proofMock = collectProof as jest.MockedFunction<typeof collectProof>
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({
        toolUse: [{ id: 'toolu_create', name: 'create_table', input: { tableName: 'failed_read_once', columns: [] } }],
      }),
      scriptedMessage({ text: 'The table has been created.' }),
      () => {
        // The mutation has run and the plain-text exit has steered the model.
        // Fail the catalog read that the next tool call dispatches, not the
        // proof lookup used while initializing the turn.
        proofMock.mockRejectedValueOnce(new Error('catalog unavailable'))
        return scriptedMessage({
          toolUse: [{ id: 'toolu_verify_first', name: 'read_backend_state', input: {} }],
        })
      },
      scriptedMessage({
        toolUse: [{ id: 'toolu_verify_again', name: 'read_backend_state', input: {} }],
      }),
    ])

    try {
      const { result } = await turn(provider, 'create a failed_read_once table')

      expect(await tableExists('failed_read_once')).toBe(true)
      expect(result).toMatchObject({
        success: false,
        failureCode: 'UNVERIFIED',
        retryable: false,
        toolsRun: ['create_table', 'read_backend_state'],
        applied: ['Creating table failed_read_once'],
      })
      expect(provider.calls).toHaveLength(5)
    } finally {
      proofMock.mockClear()
    }
  }, 60_000)

  it('does not dispatch a batched mutation after the requested verification read (#237)', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({
        toolUse: [{ id: 'toolu_create', name: 'create_table', input: { tableName: 'verified_before_replay', columns: [] } }],
      }),
      scriptedMessage({ text: 'The table has been created.' }),
      scriptedMessage({
        toolUse: [
          { id: 'toolu_verify', name: 'read_backend_state', input: {} },
          { id: 'toolu_replay', name: 'create_table', input: { tableName: 'batched_replay', columns: [] } },
        ],
      }),
    ])

    const { result } = await turn(provider, 'create a verified_before_replay table')

    expect(await tableExists('verified_before_replay')).toBe(true)
    expect(await tableExists('batched_replay')).toBe(false)
    expect(result).toMatchObject({
      success: false,
      failureCode: 'TOOL_REFUSED',
      retryable: false,
      toolsRun: ['create_table', 'read_backend_state'],
    })
  }, 60_000)

  it('cancels a model call that reaches the verification reserve and still verifies', async () => {
    const provider = scriptedProvider([
      classified('QUESTION'),
      // A step that never answers on its own: only the brain's deadline ends it.
      (_params, opts) =>
        new Promise<Anthropic.Message>((_, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const e = new Error('The operation was aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }),
    ])

    // agent.ts holds back 15s (VERIFY_RESERVE_MS) for verification. The 8s on
    // top is room to load memory and classify, so the cancel, not the check
    // between steps, is what stops this turn.
    const { result } = await turn(provider, 'what tables do I have?', { deadlineAt: Date.now() + 15_000 + 8_000 })

    expect(provider.calls).toHaveLength(2)
    expect(result).toMatchObject({ success: false, budgetStopped: true, verified: true })
    expect(result.failureCode).toBeUndefined()
    expect(result.summary).toMatch(/ran out of time budget before changing anything/)
    // A cancelled call may still have run: its reservation is kept as unknown
    // spend, and nobody is charged for it.
    const holds = [...ledger.holds.values()]
    expect(holds.map((h) => h.status)).toEqual(['settled', 'unknown'])
    expect(result.tokensUsed).toBe(0)
  }, 60_000)

  it('stops on the first call when the provider cannot serve, and says why', async () => {
    const provider = scriptedProvider([
      new AiError('quota_exhausted', 'Your credit balance is too low', { consumption: 'none' }),
    ])

    const { result } = await turn(provider, 'add a posts table')

    expect(result).toMatchObject({ success: false, failureCode: 'AI_UNAVAILABLE', retryable: false, toolsRun: [] })
    expect(result.summary).toMatch(/out of quota or credit\. Nothing was modified\./)
    // Not a clarifying question about a perfectly clear message.
    expect(result.summary).not.toMatch(/Just so I get this right/)
    expect([...ledger.holds.values()].map((h) => h.status)).toEqual(['released'])
  }, 60_000)
})
