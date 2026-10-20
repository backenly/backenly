/**
 * BrainResult.iterations is the number of model calls the agent loop got an
 * answer to (#226).
 *
 * The loop counted with its own `iter++`, which every exit but running out of
 * steps skips, so a turn the model answered at once reported 0 iterations and a
 * tool step and a reply reported 1. /api/mcp/chat returns the number to agents.
 *
 * Real database: the project, its workspace schema and the conversation each
 * turn reads and writes. Only the model is scripted, and spend reservations go
 * to the gateway's in-memory ledger, as in brain-on-gateway.spec.ts.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { AiError, setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider, type ScriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { runBrain } from '@/lib/ai/brain/agent'

let ownerId: string
let projectId: string
let schema: string

const classified = (intent: string) =>
  scriptedMessage({ text: JSON.stringify({ intent, confidence: 0.9, reasoning: 'scripted' }) })

const readState = (id: string) =>
  scriptedMessage({ toolUse: [{ id, name: 'read_backend_state', input: {} }] })

async function turn(provider: ScriptedProvider, message: string) {
  setProviderForTests(provider)
  return runBrain({ projectId, userId: ownerId, message }, () => {})
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `brain-iter-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'brain' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'brain-iterations', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${schema}"."keep_me" (id serial PRIMARY KEY, label text)`)
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

describe('iterations counts the model calls of the agent loop', () => {
  it('is 1 when the model answers at once', async () => {
    const provider = scriptedProvider([classified('QUESTION'), scriptedMessage({ text: 'You have one table: keep_me.' })])

    const result = await turn(provider, 'what tables do I have?')

    // The classifier, then one step of the loop.
    expect(provider.calls).toHaveLength(2)
    expect(result).toMatchObject({ success: true, iterations: 1, toolsRun: [] })
  }, 60_000)

  it('is 2 for a tool call and then a reply', async () => {
    const provider = scriptedProvider([
      classified('QUESTION'),
      readState('toolu_read'),
      scriptedMessage({ text: 'You have one table: keep_me.' }),
    ])

    const result = await turn(provider, 'what tables do I have?')

    expect(provider.calls).toHaveLength(3)
    expect(result).toMatchObject({ success: true, iterations: 2, toolsRun: ['read_backend_state'] })
  }, 60_000)

  it('is 12 when the step budget runs out', async () => {
    const provider = scriptedProvider([
      classified('QUESTION'),
      ...Array.from({ length: 12 }, (_, i) => readState(`toolu_read_${i}`)),
    ])

    const result = await turn(provider, 'what tables do I have?')

    expect(provider.calls).toHaveLength(13)
    expect(result).toMatchObject({ success: false, failureCode: 'STEP_BUDGET_EXHAUSTED', iterations: 12 })
  }, 60_000)

  it('does not count a call that failed', async () => {
    const provider = scriptedProvider([
      classified('QUESTION'),
      readState('toolu_read'),
      new AiError('quota_exhausted', 'Your credit balance is too low', { consumption: 'none' }),
    ])

    const result = await turn(provider, 'what tables do I have?')

    expect(provider.calls).toHaveLength(3)
    expect(result).toMatchObject({ success: false, failureCode: 'AI_UNAVAILABLE', iterations: 1 })
  }, 60_000)
})
