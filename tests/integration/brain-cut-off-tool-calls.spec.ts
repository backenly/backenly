/**
 * A tool call the model did not finish, or whose arguments are not an object,
 * runs nothing and goes back to the model naming the tool (#236). One cut off
 * because the turn filled the context window runs nothing and ends the turn.
 *
 * Cut off, a call carries whatever its stream had parsed: the SDK's partial
 * JSON parser reads `{"tableName": "messa` as `{}`, and disable_realtime with
 * no tableName means every table. The loop ran none of an answer cut off at
 * the output ceiling but ended the turn there, so the model never learned that
 * its call was too long; it ran a call cut off by the context window as parsed,
 * and a call whose arguments were not an object as `{}`.
 *
 * Real database: the project, its workspace schema, the tables a cut-off call
 * must leave untouched and the conversation. Only the model is scripted, and
 * spend reservations go to the gateway's in-memory ledger, as in
 * brain-on-gateway.spec.ts.
 */

import crypto from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { prisma } from '@/lib/db/prisma'
import { setProviderForTests } from '@/lib/ai/llm'
import { fromOpenAI } from '@/lib/ai/llm/providers/openai'
import { scriptedMessage, scriptedProvider, type ScriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { runBrain, type BrainEvent } from '@/lib/ai/brain/agent'

let ownerId: string
let projectId: string
let schema: string

const classified = (intent: string) =>
  scriptedMessage({ text: JSON.stringify({ intent, confidence: 0.9, reasoning: 'scripted' }) })

const finish = (summary: string) =>
  scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary } }] })

async function columnsOf(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
    schema,
    table,
  )
  return rows.map((r) => r.column_name)
}

async function turn(provider: ScriptedProvider, message: string) {
  setProviderForTests(provider)
  const events: BrainEvent[] = []
  const result = await runBrain({ projectId, userId: ownerId, message }, (e) => events.push(e))
  return { result, events }
}

/** What the model was told about each call of its previous answer, as the request at `index` sent it. */
function answersIn(provider: ScriptedProvider, index: number) {
  const turnBlocks = provider.calls[index].params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
  return turnBlocks.map((b) => ({ ...b, payload: JSON.parse(b.content as string) }))
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `brain-cut-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'brain' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'brain-cut-off-tool-calls', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
}, 60_000)

beforeEach(async () => {
  setSpendLedgerForTests(memorySpendLedger())
  // Past 20 saved messages a turn starts a summary without waiting, and that
  // model call would take the next test's scripted reply.
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

describe('a call cut off at the output limit', () => {
  it('is not run, is answered naming its tool, and the call sent again runs', async () => {
    const cutOff = scriptedMessage({
      thinking: 'One table with a body column.',
      // Streamed as `{"tableName": "messages", "columns": [{"name": "bo`
      // when the ceiling was reached: a column with no name or type.
      toolUse: [{ id: 'toolu_cut', name: 'create_table', input: { tableName: 'messages', columns: [{}] } }],
      stopReason: 'max_tokens',
    })
    const provider = scriptedProvider([
      classified('MODIFY'),
      cutOff,
      scriptedMessage({
        toolUse: [{ id: 'toolu_again', name: 'create_table', input: { tableName: 'messages', columns: [{ name: 'body', type: 'text' }] } }],
      }),
      scriptedMessage({ toolUse: [{ id: 'toolu_verify', name: 'read_backend_state', input: {} }] }),
      finish('Created messages with a body column.'),
    ])

    const { result } = await turn(provider, 'add a messages table with a body')

    // The next request carries the cut-off answer back as it came, and answers
    // its call as an error that names the tool and says it did not run.
    const next = provider.calls[2].params.messages
    expect(next.at(-2)).toEqual({ role: 'assistant', content: cutOff.content })
    expect(answersIn(provider, 2)).toEqual([
      expect.objectContaining({
        tool_use_id: 'toolu_cut',
        is_error: true,
        payload: { ok: false, summary: expect.stringMatching(/^`create_table` was NOT run: your answer was cut off at the output limit/) },
      }),
    ])

    // Only the call sent again ran, with the arguments it was sent with.
    expect(result).toMatchObject({ success: true, toolsRun: ['create_table', 'read_backend_state', 'finish'] })
    expect(await columnsOf('messages')).toContain('body')
  }, 60_000)

  it('runs none of the calls in the answer, finished ones included', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({
        toolUse: [
          { id: 'toolu_whole', name: 'create_table', input: { tableName: 'posts', columns: [{ name: 'title', type: 'text' }] } },
          { id: 'toolu_cut', name: 'create_table', input: { tableName: 'comments', columns: [{}] } },
        ],
        stopReason: 'max_tokens',
      }),
      scriptedMessage({ text: 'Neither table was created; I will send them one at a time.' }),
    ])

    const { result } = await turn(provider, 'add posts and comments tables')

    expect(await columnsOf('posts')).toEqual([])
    expect(await columnsOf('comments')).toEqual([])
    expect(result.toolsRun).toEqual([])
    expect(answersIn(provider, 2).map((a) => [a.tool_use_id, a.is_error, a.payload.ok])).toEqual([
      ['toolu_whole', true, false],
      ['toolu_cut', true, false],
    ])
    // Both steps ran, so both are billed: 10 in + 5 out each by the scripted default.
    expect(result.tokensUsed).toBe(30)
  }, 60_000)

  it('never reaches the approval gate', async () => {
    const provider = scriptedProvider([
      classified('DESTRUCTIVE'),
      // Streamed as `{"tableName": "messa`: the parser keeps no half-written
      // string, so the call reads as disable_realtime on every table.
      scriptedMessage({ toolUse: [{ id: 'toolu_cut', name: 'disable_realtime', input: {} }], stopReason: 'max_tokens' }),
      scriptedMessage({ toolUse: [{ id: 'toolu_again', name: 'disable_realtime', input: { tableName: 'messages' } }] }),
      finish('Disabling realtime on messages is waiting for approval.'),
    ])

    const { result, events } = await turn(provider, 'stop streaming the messages table')

    expect(answersIn(provider, 2)).toEqual([
      expect.objectContaining({
        tool_use_id: 'toolu_cut',
        is_error: true,
        payload: { ok: false, summary: expect.stringMatching(/^`disable_realtime` was NOT run: your answer was cut off/) },
      }),
    ])
    // Only the call sent again is held for a person, and only it was described.
    expect(result.blockedCalls).toEqual([
      expect.objectContaining({ tool: 'disable_realtime', args: { tableName: 'messages' } }),
    ])
    expect(events.filter((e) => e.type === 'danger')).toEqual([
      expect.objectContaining({ tool: 'disable_realtime', target: 'realtime on `messages` (live subscribers disconnect)' }),
    ])
    expect(result.toolsRun).not.toContain('disable_realtime')
  }, 60_000)
})

describe('a call cut off by a full context window', () => {
  it('runs nothing, reaches no approval and ends the turn', async () => {
    const provider = scriptedProvider([
      classified('DESTRUCTIVE'),
      // The same half-written `{"tableName": "messa`, cut off this time because
      // the turn filled the model's context window.
      scriptedMessage({
        toolUse: [{ id: 'toolu_cut', name: 'disable_realtime', input: {} }],
        stopReason: 'model_context_window_exceeded',
      }),
    ])

    const { result, events } = await turn(provider, 'stop streaming the messages table')

    // The classifier and the cut-off answer: nothing went back to the model.
    expect(provider.calls).toHaveLength(2)
    expect(result).toMatchObject({ success: false, failureCode: 'MODEL_ERROR', retryable: true, toolsRun: [] })
    expect(result.summary).toMatch(/filled its context window\. Nothing was modified\./)
    expect(result.blockedCalls).toBeUndefined()
    expect(events.filter((e) => e.type === 'danger')).toEqual([])
  }, 60_000)
})

describe('a call whose arguments are not an object', () => {
  /** OpenAI's answer, as its adapter hands it to the gateway: the arguments are a string the adapter parses. */
  const fromOpenAiCall = (id: string, name: string, args: string) =>
    fromOpenAI({
      id: 'chatcmpl_scripted',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4.1',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: { role: 'assistant', content: null, refusal: null, tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as OpenAI.Chat.ChatCompletion)

  it('is not run as {}, and is answered naming its tool', async () => {
    const provider = scriptedProvider([
      classified('DESTRUCTIVE'),
      // A model that encodes its arguments twice: they parse to a string.
      () => fromOpenAiCall('call_twice', 'disable_realtime', JSON.stringify(JSON.stringify({ tableName: 'messages' }))),
      scriptedMessage({ toolUse: [{ id: 'toolu_again', name: 'disable_realtime', input: { tableName: 'messages' } }] }),
      finish('Disabling realtime on messages is waiting for approval.'),
    ])

    const { result, events } = await turn(provider, 'stop streaming the messages table')

    expect(answersIn(provider, 2)).toEqual([
      expect.objectContaining({
        tool_use_id: 'call_twice',
        is_error: true,
        payload: { ok: false, summary: expect.stringMatching(/^`disable_realtime` was NOT run: its arguments were not a JSON object/) },
      }),
    ])
    expect(result.blockedCalls).toEqual([
      expect.objectContaining({ tool: 'disable_realtime', args: { tableName: 'messages' } }),
    ])
    expect(events.filter((e) => e.type === 'danger')).toEqual([
      expect.objectContaining({ tool: 'disable_realtime', target: 'realtime on `messages` (live subscribers disconnect)' }),
    ])
  }, 60_000)
})
