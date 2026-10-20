/**
 * Every model call of a brain turn is recorded as Backenly's own spend,
 * including the calls that only route the turn (#230): the classifier on every
 * turn, then the answer on a CHAT turn or the clarifying question on an
 * UNCLEAR one. Each call is reserved against the deployment's monthly limits,
 * settled from the usage it reports, and written to the project's usage log
 * under the name of what made it.
 *
 * Real database: the project, its workspace schema, its conversation log and
 * the usage rows. Only the model is scripted, each call with usage of its own,
 * so every row can be matched to the call it records. Spend reservations go to
 * the gateway's in-memory ledger, as in tests/integration/brain-on-gateway.spec.ts.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider, type ScriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests, type MemorySpendLedger } from '@/lib/ai/llm/spend'
import { runBrain } from '@/lib/ai/brain/agent'

let ownerId: string
let projectId: string
let schema: string
let ledger: MemorySpendLedger

const classified = (intent: string, usage: { input_tokens: number; output_tokens: number }) =>
  scriptedMessage({ text: JSON.stringify({ intent, confidence: 0.9, reasoning: 'scripted' }), usage })

async function turn(provider: ScriptedProvider, message: string) {
  setProviderForTests(provider)
  const spent: number[] = []
  const result = await runBrain({ projectId, userId: ownerId, message, onTokens: (n) => spent.push(n) }, () => {})
  return { result, spent }
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

/** Each row as the call it records: what made it and the tokens it reported, by name. */
async function recordedCalls(expected: number) {
  return (await usageRows(expected))
    .map((r) => ({ endpoint: r.endpoint, promptTokens: r.promptTokens, completionTokens: r.completionTokens }))
    .sort((a, b) => String(a.endpoint).localeCompare(String(b.endpoint)))
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `brain-spend-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'brain' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'brain-classify-clarify-spend', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  // Something is built, so an UNCLEAR turn asks its question rather than
  // handing the message to the architect as a fresh project's description.
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${schema}"."keep_me" (id serial PRIMARY KEY, label text)`)
}, 60_000)

beforeEach(async () => {
  ledger = memorySpendLedger()
  setSpendLedgerForTests(ledger)
  await prisma.aiUsage.deleteMany({ where: { projectId } })
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

describe('the calls that route a turn are recorded like every other', () => {
  it('records the classifier and the answer of a CHAT turn, one reservation and one usage row each', async () => {
    const provider = scriptedProvider([
      classified('CHAT', { input_tokens: 120, output_tokens: 30 }),
      scriptedMessage({
        text: 'Row-level security decides which rows each request may read or change.',
        usage: { input_tokens: 400, output_tokens: 90 },
      }),
    ])

    const { result, spent } = await turn(provider, 'what is row-level security?')

    expect(result).toMatchObject({ success: true, toolsRun: ['answer_question'] })
    expect(provider.calls).toHaveLength(2)
    // Each call reserved its worst case before it was sent and settled from
    // the usage it reported.
    expect([...ledger.holds.values()].map((h) => h.status)).toEqual(['settled', 'settled'])
    expect(await recordedCalls(2)).toEqual([
      { endpoint: 'brain-answer', promptTokens: 400, completionTokens: 90 },
      { endpoint: 'brain-classify', promptTokens: 120, completionTokens: 30 },
    ])
    // Recording is not billing: the turn still charges no AI credits for
    // either call.
    expect(result.tokensUsed).toBe(0)
    expect(spent).toEqual([])
  }, 60_000)

  it('records the classifier and the clarifying question of an UNCLEAR turn, one reservation and one usage row each', async () => {
    const provider = scriptedProvider([
      classified('UNCLEAR', { input_tokens: 150, output_tokens: 40 }),
      scriptedMessage({
        text: JSON.stringify({ question: 'What would you like to improve first?', options: ['Speed', 'Security', 'The schema'] }),
        usage: { input_tokens: 300, output_tokens: 60 },
      }),
    ])

    const { result, spent } = await turn(provider, 'make it better')

    expect(result).toMatchObject({ needsUser: true, toolsRun: ['ask_user'] })
    expect(result.summary).toMatch(/^What would you like to improve first\?/)
    expect(provider.calls).toHaveLength(2)
    expect([...ledger.holds.values()].map((h) => h.status)).toEqual(['settled', 'settled'])
    expect(await recordedCalls(2)).toEqual([
      { endpoint: 'brain-clarify', promptTokens: 300, completionTokens: 60 },
      { endpoint: 'brain-classify', promptTokens: 150, completionTokens: 40 },
    ])
    expect(result.tokensUsed).toBe(0)
    expect(spent).toEqual([])
  }, 60_000)
})
