/**
 * A QUESTION turn is offered no tool that changes the backend.
 *
 * "Do NOT mutate anything" in the turn's hint was all that stood between a
 * question and create_table, drop_table or set_rls, because a question was
 * offered every tool in the catalog (#241). It is now offered the reads and the
 * three tools that end a turn, the way a CONFIRM turn is offered everything but
 * propose_plan, and a call a model sends anyway that is neither, such as
 * get_readiness asked to fix or an unoffered create_table, is refused before
 * it runs.
 *
 * Real database: the project, its workspace schema, the conversation a turn
 * saves, and the JWT secret and table a refused call must not create. Only the
 * model is scripted, as in brain-on-gateway.spec.ts, and spend reservations go
 * to the gateway's in-memory ledger for the reason given there.
 */

import crypto from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/db/prisma'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider, type ScriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { BRAIN_MODEL_TOOLS, isReadOnlyTool } from '@/lib/ai/brain/tools'
import { isMutationCall, runBrain } from '@/lib/ai/brain/agent'

let ownerId: string
let projectId: string
let schema: string

const classified = (intent: string) =>
  scriptedMessage({ text: JSON.stringify({ intent, confidence: 0.9, reasoning: 'scripted' }) })

async function turn(provider: ScriptedProvider, message: string) {
  setProviderForTests(provider)
  return runBrain({ projectId, userId: ownerId, message }, () => {})
}

/** The names of the tools one model call was sent. */
function offered(provider: ScriptedProvider, step: number): string[] {
  return provider.calls[step].params.tools!.map((t) => (t as Anthropic.Tool).name)
}

/** What the model was told each call returned, from the step that answered them. */
function answers(provider: ScriptedProvider, step: number) {
  const blocks = provider.calls[step].params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
  return Object.fromEntries(blocks.map((b) => [b.tool_use_id, { ...JSON.parse(b.content as string), isError: !!b.is_error }]))
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    schema,
    name,
  )
  return rows[0].n > 0
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `brain-question-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'brain' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'brain-question-tools', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."notes" (id serial PRIMARY KEY, body text)`)
}, 60_000)

beforeEach(async () => {
  setSpendLedgerForTests(memorySpendLedger())
  // Each test starts with no history: past 20 saved messages a summary starts
  // without waiting, and its model call would take a scripted reply.
  await prisma.conversationMessage.deleteMany({ where: { projectId } })
})

afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.aiUsage.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('the tools a turn is offered', () => {
  it('offers a question the reads and the tools that end a turn, and still answers it', async () => {
    const provider = scriptedProvider([
      classified('QUESTION'),
      scriptedMessage({ toolUse: [{ id: 'toolu_read', name: 'read_backend_state', input: {} }] }),
      scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'You have one table: notes.' } }] }),
    ])

    const result = await turn(provider, 'what tables do I have?')

    const tools = offered(provider, 1)
    expect(tools.filter((name) => isMutationCall(name, {}))).toEqual([])
    expect(tools.filter((name) => !isReadOnlyTool(name) && !['finish', 'ask_user', 'answer_question'].includes(name))).toEqual([])
    expect(tools).toEqual(expect.arrayContaining(['read_backend_state', 'get_table_schema', 'run_query', 'finish', 'ask_user', 'answer_question']))
    for (const name of ['create_table', 'drop_table', 'set_rls', 'propose_plan', 'run_test']) expect(tools).not.toContain(name)
    // Every step of the turn is sent the same list, so its cached prefix holds.
    expect(offered(provider, 2)).toEqual(tools)

    // A plain question still reads the state and finishes with the answer.
    expect(result).toMatchObject({
      success: true,
      summary: 'You have one table: notes.',
      toolsRun: ['read_backend_state', 'finish'],
      applied: [],
    })
    expect(provider.calls).toHaveLength(3)
  }, 60_000)

  it('still offers the whole catalog to a request for a change', async () => {
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'The notes table needs nothing.' } }] }),
    ])

    await turn(provider, 'tidy up the notes table')

    expect(offered(provider, 1)).toEqual(BRAIN_MODEL_TOOLS.map((t) => t.function.name))
  }, 60_000)

  it('refuses a question\'s call that would change something, still runs the plain read, and finishes', async () => {
    const provider = scriptedProvider([
      classified('QUESTION'),
      // get_readiness is offered, though not to fix. create_table and
      // apply_proposal are not offered at all, and apply_proposal is a control
      // tool isMutationCall does not count. A model can send all three anyway.
      scriptedMessage({
        toolUse: [
          { id: 'toolu_fix', name: 'get_readiness', input: { autoFix: true } },
          { id: 'toolu_create', name: 'create_table', input: { tableName: 'from_a_question', columns: [{ name: 'label', type: 'text' }] } },
          { id: 'toolu_apply', name: 'apply_proposal', input: {} },
        ],
      }),
      scriptedMessage({ toolUse: [{ id: 'toolu_read', name: 'get_readiness', input: {} }] }),
      scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'Not ready yet: the project has no JWT secret.' } }] }),
    ])

    const result = await turn(provider, 'is my backend ready to deploy?')

    const refused = answers(provider, 2)
    for (const id of ['toolu_fix', 'toolu_create', 'toolu_apply']) {
      expect(refused[id]).toMatchObject({ ok: false, blocked: 'read_only_turn', isError: true })
      expect(refused[id].summary).toMatch(/NOT run/)
      expect(refused[id].summary).toMatch(/what would need to change/)
    }
    // None ran: no JWT secret was generated and no table was created.
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { jwtSecret: true } })
    expect(project.jwtSecret).toBeNull()
    expect(await tableExists('from_a_question')).toBe(false)

    // The plain readiness read still runs on the same turn, and the turn finishes.
    expect(answers(provider, 3).toolu_read).toMatchObject({ ok: true, isError: false })
    expect(result).toMatchObject({
      success: true,
      summary: 'Not ready yet: the project has no JWT secret.',
      toolsRun: ['get_readiness', 'finish'],
      applied: [],
    })
    expect(result.refused).toBeUndefined()
    expect(result.blockedCalls).toBeUndefined()
    expect(provider.calls).toHaveLength(4)
  }, 120_000)
})
