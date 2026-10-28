/**
 * The brain runs on the AI gateway (lib/ai/llm), end to end.
 *
 * Real database: the project, its workspace schema, the conversation log, the
 * usage rows and the tables a refused or cut-off step must leave untouched.
 * The model and endpoint-verifier outcomes are scripted; schema and RLS tools
 * use real PostgreSQL. Background reconciliation is disabled for this suite.
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
import { BRAIN_MODEL_TOOLS, isReadOnlyTool } from '@/lib/ai/brain/tools'
import { runBrain, type BrainEvent, type BrainInput } from '@/lib/ai/brain/agent'
import { collectProof } from '@/lib/ai/proof-system'
import { runEndpointTest } from '@/lib/ai/brain/verifier'

jest.mock('@/lib/ai/proof-system', () => {
  const actual = jest.requireActual<typeof import('@/lib/ai/proof-system')>('@/lib/ai/proof-system')
  return { ...actual, collectProof: jest.fn(actual.collectProof) }
})

jest.mock('@/lib/ai/brain/verifier', () => ({
  runEndpointTest: jest.fn(),
}))

const mockRunEndpointTest = jest.mocked(runEndpointTest)
let originalReconcilerFlag: string | undefined

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
  // FLAGS reads this environment variable on each kick, not at module import.
  originalReconcilerFlag = process.env.ENABLE_AUTONOMY_RECONCILER
  process.env.ENABLE_AUTONOMY_RECONCILER = 'false'
  ownerId = (await prisma.user.create({
    data: { email: `brain-gw-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'brain' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'brain-on-gateway', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${schema}"."keep_me" (id serial PRIMARY KEY, label text)`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."rls_custom_fixture" (id serial PRIMARY KEY)`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."rls_template_fixture" (id serial PRIMARY KEY)`)
}, 60_000)

beforeEach(async () => {
  mockRunEndpointTest.mockReset()
  if (!projectId || !ownerId) throw new Error('Fixture setup did not assign project and owner IDs; refusing cleanup')
  ledger = memorySpendLedger()
  setSpendLedgerForTests(ledger)
  await prisma.aiUsage.deleteMany({ where: { projectId } })
  // Every turn saves its messages to this one project. Past 20, saveMessages
  // starts a summary without waiting, and that model call takes the next test's
  // scripted reply. Each test starts with no history.
  await prisma.conversationMessage.deleteMany({ where: { projectId } })
})

afterEach(() => {
  jest.restoreAllMocks()
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  // Partial setup must never turn an undefined filter into an unscoped delete.
  // Attempt independent cleanup steps, then surface every failure to Jest.
  const failures: unknown[] = []
  const cleanup = async (operation: () => Promise<unknown>) => {
    try { await operation() } catch (error) { failures.push(error) }
  }
  if (schema) {
    if (projectId && schema === `workspace_${projectId}` && /^[a-zA-Z0-9_-]+$/.test(schema)) {
      await cleanup(() => prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`))
    } else {
      failures.push(new Error('Refusing to drop an unexpected fixture schema'))
    }
  }
  if (projectId) {
    await cleanup(() => prisma.auditLog.deleteMany({ where: { projectId } }))
    await cleanup(() => prisma.project.delete({ where: { id: projectId } }))
  }
  if (ownerId) await cleanup(() => prisma.user.delete({ where: { id: ownerId } }))
  if (failures.length) throw new AggregateError(failures, 'Brain gateway fixture cleanup failed')
}, 60_000)

// A separate hook restores the flag even if fixture setup or cleanup fails.
afterAll(() => {
  if (originalReconcilerFlag === undefined) delete process.env.ENABLE_AUTONOMY_RECONCILER
  else process.env.ENABLE_AUTONOMY_RECONCILER = originalReconcilerFlag
})

describe('a turn on the gateway', () => {
  const finish = (summary = 'Observed verification.') =>
    scriptedMessage({ toolUse: [{ id: 'done', name: 'finish', input: { summary } }] })
  const read = () => scriptedMessage({ toolUse: [{ id: 'read', name: 'read_backend_state', input: {} }] })
  const mutate = () => scriptedMessage({ toolUse: [{
    id: 'mutation', name: 'create_table',
    input: { tableName: `verify_${crypto.randomBytes(5).toString('hex')}`, columns: [{ name: 'label', type: 'text' }] },
  }] })
  const expectAppliedMutation = (provider: ScriptedProvider, nextCall: number) => {
    const answers = provider.calls[nextCall].params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    expect(JSON.parse(answers[0].content as string)).toMatchObject({ ok: true })
  }

  it.each([
    ['read_backend_state', false],
    ['read_backend_state', true],
    ['run_test', false],
    ['run_test', true],
  ] as const)('defers same-batch finish with %s (finish first: %s)', async (verificationTool, finishFirst) => {
    const probe = verificationTool === 'run_test'
      ? mockRunEndpointTest.mockResolvedValueOnce({
          ok: true, summary: 'Endpoint verified.', endpoint: '/test-endpoint',
          method: 'GET', statusCode: 200, bodyExcerpt: '[]',
        })
      : null
    const check = {
      id: 'check', name: verificationTool,
      input: verificationTool === 'run_test' ? { tableName: 'keep_me', operation: 'list' } : {},
    }
    const premature = { id: 'premature', name: 'finish', input: { summary: 'Unobserved.' } }
    const provider = scriptedProvider([
      classified('MODIFY'), mutate(),
      scriptedMessage({ toolUse: finishFirst ? [premature, check] : [check, premature] }),
      finish(),
    ])
    const { result } = await turn(provider, 'make a small table')
    expect(result).toMatchObject({ success: true, summary: 'Observed verification.' })
    expect(provider.calls).toHaveLength(4)
    expectAppliedMutation(provider, 2)
    const answers = provider.calls[3].params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    expect(answers.map((a) => a.tool_use_id)).toEqual(finishFirst ? ['premature', 'check'] : ['check', 'premature'])
    expect(JSON.parse(answers.find((a) => a.tool_use_id === 'check')!.content as string)).toMatchObject({ ok: true })
    expect(answers.find((a) => a.tool_use_id === 'premature')).toMatchObject({ is_error: true })
    expect(result.toolsRun.filter((name) => name === 'finish')).toHaveLength(1)
    expect(result.toolsRun.filter((name) => name === verificationTool)).toHaveLength(1)
    if (probe) {
      expect(probe).toHaveBeenCalledTimes(1)
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({ projectId, tableName: 'keep_me', operation: 'list' }))
      expect(JSON.parse(answers.find((a) => a.tool_use_id === 'check')!.content as string)).toMatchObject({ summary: 'Endpoint verified.' })
    }
  }, 60_000)

  it.each(['failure', 'exception'])('allows honest completion after verification %s', async (kind) => {
    const probe = mockRunEndpointTest
    if (kind === 'exception') probe.mockRejectedValueOnce(new Error('verification unavailable'))
    else probe.mockResolvedValueOnce({ ok: false, summary: 'verification unavailable', endpoint: '', method: 'GET', statusCode: null, bodyExcerpt: '' })
    const provider = scriptedProvider([
      classified('MODIFY'), mutate(), read(),
      scriptedMessage({ toolUse: [
        { id: 'check', name: 'run_test', input: { tableName: 'keep_me', operation: 'list' } },
        { id: 'premature', name: 'finish', input: { summary: 'Unobserved.' } },
      ] }),
      finish('Changes applied, verification failed.'),
    ])
    const { result } = await turn(provider, 'make a small table')
    expect(result).toMatchObject({ success: false, summary: 'Changes applied, verification failed.' })
    expect(provider.calls).toHaveLength(5)
    expectAppliedMutation(provider, 2)
    expect(probe).toHaveBeenCalledTimes(1)
    const answers = provider.calls[4].params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    expect(answers.find((a) => a.tool_use_id === 'check')).toMatchObject({ is_error: true })
  }, 60_000)

  it('does not let a passing check or a catalog read hide a check that failed', async () => {
    mockRunEndpointTest
      .mockResolvedValueOnce({ ok: false, summary: 'POST returned 400.', endpoint: '/keep_me', method: 'POST', statusCode: 400, bodyExcerpt: '' })
      .mockResolvedValueOnce({ ok: true, summary: 'GET returned 200.', endpoint: '/keep_me', method: 'GET', statusCode: 200, bodyExcerpt: '[]' })
    const provider = scriptedProvider([
      classified('MODIFY'), mutate(),
      scriptedMessage({ toolUse: [
        { id: 'create', name: 'run_test', input: { tableName: 'keep_me', operation: 'create' } },
        { id: 'list', name: 'run_test', input: { tableName: 'keep_me', operation: 'list' } },
      ] }),
      read(),
      finish('Listing works; creating a row returned 400.'),
    ])
    const { result } = await turn(provider, 'make a small table')
    expect(result).toMatchObject({ success: false, summary: 'Listing works; creating a row returned 400.' })
    expect(provider.calls).toHaveLength(5)
    expect(mockRunEndpointTest).toHaveBeenCalledTimes(2)
  }, 60_000)

  it('clears a failed check when the same check passes again', async () => {
    mockRunEndpointTest
      .mockResolvedValueOnce({ ok: false, summary: 'The request timed out.', endpoint: '/keep_me', method: 'GET', statusCode: null, bodyExcerpt: '' })
      .mockResolvedValueOnce({ ok: true, summary: 'GET returned 200.', endpoint: '/keep_me', method: 'GET', statusCode: 200, bodyExcerpt: '[]' })
    const check = (id: string) =>
      scriptedMessage({ toolUse: [{ id, name: 'run_test', input: { tableName: 'keep_me', operation: 'list' } }] })
    const provider = scriptedProvider([classified('MODIFY'), mutate(), check('first'), check('again'), finish()])
    const { result } = await turn(provider, 'make a small table')
    expect(result).toMatchObject({ success: true, summary: 'Observed verification.' })
    expect(mockRunEndpointTest).toHaveBeenCalledTimes(2)
  }, 60_000)

  it('invalidates verification after a later ordinary mutation', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'), mutate(), read(), mutate(), finish('Too early.'), read(), finish(),
    ])
    const { result } = await turn(provider, 'make two small tables')
    expect(result).toMatchObject({ success: true, summary: 'Observed verification.' })
    expect(provider.calls).toHaveLength(7)
    expectAppliedMutation(provider, 2)
    expectAppliedMutation(provider, 4)
    expect(JSON.stringify(provider.calls[5].params.messages.at(-1))).toContain('did not verify')
  }, 60_000)

  it('accepts separate-turn finish after successful verification without rechecking', async () => {
    const provider = scriptedProvider([classified('MODIFY'), mutate(), read(), finish()])
    const { result } = await turn(provider, 'make a small table')
    expect(result.success).toBe(true)
    expect(provider.calls).toHaveLength(4)
    expectAppliedMutation(provider, 2)
    expect(result.toolsRun).toEqual(['create_table', 'read_backend_state', 'finish'])
  }, 60_000)

  it('preserves successful self-verifying tools without another read', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({ toolUse: [{ id: 'rls', name: 'set_rls', input: { tableName: 'rls_custom_fixture', select: { using: 'true' } } }] }),
      finish('Policy verified by executor.'),
    ])
    const { result } = await turn(provider, 'set the rls_custom_fixture select policy')
    expect(result).toMatchObject({ success: true, summary: 'Policy verified by executor.' })
    expect(result.toolsRun).toEqual(['set_rls', 'finish'])
    expect(provider.calls).toHaveLength(3)
    const answers = provider.calls[2].params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    expect(JSON.parse(answers[0].content as string)).toMatchObject({ ok: true })
    const policies = await prisma.$queryRawUnsafe<Array<{ cmd: string }>>(
      'SELECT cmd FROM pg_policies WHERE schemaname = $1 AND tablename = $2',
      schema, 'rls_custom_fixture',
    )
    expect(policies).toEqual(expect.arrayContaining([{ cmd: 'SELECT' }]))
  }, 60_000)

  it('preserves successful add_rls self-verification without another read', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({ toolUse: [{ id: 'rls', name: 'add_rls', input: { tableName: 'rls_template_fixture', policy: 'admin_only' } }] }),
      finish('Template policy verified by executor.'),
    ])
    const { result } = await turn(provider, 'restrict rls_template_fixture to service-role access')
    expect(result).toMatchObject({ success: true, summary: 'Template policy verified by executor.' })
    expect(result.toolsRun).toEqual(['add_rls', 'finish'])
    expect(provider.calls).toHaveLength(3)
    const answers = provider.calls[2].params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ tool_use_id: 'rls' })
    expect(answers[0]).not.toHaveProperty('is_error')
    expect(JSON.parse(answers[0].content as string)).toMatchObject({ ok: true })
    const policies = await prisma.$queryRawUnsafe<Array<{ policyname: string; cmd: string }>>(
      'SELECT policyname, cmd FROM pg_policies WHERE schemaname = $1 AND tablename = $2',
      schema, 'rls_template_fixture',
    )
    expect(policies).toEqual(expect.arrayContaining([{ policyname: 'backenly_admin_only', cmd: 'ALL' }]))
  }, 60_000)

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

    // The loop: a question's share of the catalog (the reads and the tools that
    // end a turn) translated once with its last tool cached, the stable prompt
    // cached ahead of the turn's own context, thinking on, and the conversation
    // cached at its last block.
    const first = provider.calls[1].params
    expect(first.tools!.map((t) => (t as Anthropic.Tool).name)).toEqual(
      BRAIN_MODEL_TOOLS.map((t) => t.function.name)
        .filter((name) => isReadOnlyTool(name) || ['finish', 'ask_user', 'answer_question'].includes(name)),
    )
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

  it('does not present an MCP caller as dashboard page context', async () => {
    const provider = scriptedProvider([
      classified('QUESTION'),
      scriptedMessage({
        toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'No page context.' } }],
      }),
    ])

    await turn(provider, 'what can I do here?', { door: 'mcp' })

    const system = provider.calls[1].params.system as Anthropic.TextBlockParam[]
    expect(system.map((block) => block.text).join('\n')).not.toContain("USER'S CURRENT PAGE")
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

  // A cut-off answer with calls in it goes back to the model, each call
  // answered as not run (brain-cut-off-tool-calls.spec.ts). One with no call
  // has nothing to answer, so the turn stops.
  it('stops on an answer cut off at its output limit before it called anything', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({ text: 'I will add a half_written table with', stopReason: 'max_tokens' }),
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
