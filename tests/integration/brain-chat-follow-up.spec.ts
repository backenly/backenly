/**
 * A CHAT answer reads the conversation it follows (#239).
 *
 * A CHAT turn is answered by answer_question, which sent the model the
 * answerer prompt, the project summary and the current message alone. The turn
 * loads the recent conversation and the classifier reads it, but the answer
 * never saw it, so a follow-up could not be answered:
 *
 *   user:       Which RLS templates fit a messages table and a likes table?
 *   assistant:  For messages use participants; for likes use owner_read_write.
 *   user:       why the first one?
 *
 * reached the model as "why the first one?" with nothing saying what the first
 * one was. The answer now carries the recent turns, clipped the way the
 * classifier clips them: the last four, 600 characters each.
 *
 * Real database: the project and the conversation log the turn loads its
 * history from, written through the brain's own saveTurn. Only the model is
 * scripted, so each test reads exactly what the answer call was sent.
 */

import crypto from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/db/prisma'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider, type ScriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { answererPrompt } from '@/lib/ai/brain/prompts'
import { saveTurn } from '@/lib/ai/brain/memory'
import { runBrain } from '@/lib/ai/brain/agent'

let ownerId: string
let projectId: string
let schema: string

const QUESTION = 'Which RLS templates fit a messages table and a likes table?'
const ANSWER = 'For messages use participants; for likes use owner_read_write.'

const classified = (intent: string) =>
  scriptedMessage({ text: JSON.stringify({ intent, confidence: 0.9, reasoning: 'scripted' }) })

/** A CHAT turn on `message`, answered with `answer`. */
async function chatTurn(message: string, answer: string) {
  const provider = scriptedProvider([classified('CHAT'), scriptedMessage({ text: answer })])
  setProviderForTests(provider)
  const result = await runBrain({ projectId, userId: ownerId, message }, () => {})
  return { result, provider }
}

/** The call answer_question made: the one sent the answerer's prompt. */
function answerCall(provider: ScriptedProvider): Anthropic.MessageCreateParamsNonStreaming {
  const calls = provider.calls.filter(
    (c) => (c.params.system as Anthropic.TextBlockParam[] | undefined)?.[0]?.text === answererPrompt(),
  )
  expect(calls).toHaveLength(1)
  return calls[0].params
}

/** Usage rows are written without waiting; let them land before the next test clears them. */
async function usageSettled(expected: number) {
  for (let i = 0; i < 50; i++) {
    if ((await prisma.aiUsage.count({ where: { projectId } })) >= expected) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `brain-chat-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'brain chat' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'brain-chat-follow-up', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  // The brain reads the workspace while it builds a turn's context.
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
}, 60_000)

beforeEach(async () => {
  setSpendLedgerForTests(memorySpendLedger())
  await prisma.aiUsage.deleteMany({ where: { projectId } })
  await prisma.conversationMessage.deleteMany({ where: { projectId } })
})

afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('a CHAT answer is written with the conversation it follows', () => {
  it('sends the earlier turns ahead of the follow-up, so "the first one" has a referent', async () => {
    await saveTurn(projectId, QUESTION, ANSWER)

    const { result, provider } = await chatTurn('why the first one?', 'Because a message belongs to both people in the conversation.')
    await usageSettled(2)

    expect(result).toMatchObject({ success: true, summary: 'Because a message belongs to both people in the conversation.' })
    expect(answerCall(provider).messages).toEqual([
      { role: 'user', content: QUESTION },
      { role: 'assistant', content: ANSWER },
      { role: 'user', content: 'why the first one?' },
    ])
  }, 60_000)

  it('clips the history the way the classifier does: the last four turns, 600 characters each', async () => {
    const long = 'Use participants because a message has two parties. '.repeat(20)
    await saveTurn(projectId, 'What is RLS?', 'Row-level security decides which rows a caller may see.')
    await saveTurn(projectId, QUESTION, long)
    await saveTurn(projectId, 'And for comments?', 'owner_read_write, like likes.')

    const { provider } = await chatTurn('why the first one?', 'Because both people in a conversation read its messages.')
    await usageSettled(2)

    const messages = answerCall(provider).messages
    expect(messages).toEqual([
      { role: 'user', content: QUESTION },
      { role: 'assistant', content: `${long.slice(0, 600)}…` },
      { role: 'user', content: 'And for comments?' },
      { role: 'assistant', content: 'owner_read_write, like likes.' },
      { role: 'user', content: 'why the first one?' },
    ])
    // The window the classifier read for this turn, exactly.
    expect(messages).toEqual(provider.calls[0].params.messages)
  }, 60_000)

  it('sends a key pasted earlier as the history keeps it, redacted', async () => {
    // Split, so the public tree's credential scan does not read it as a real key.
    const key = 'sk' + '-ant-api03-' + 'Zq8Xw3Lm9Pk2'.repeat(4)
    await saveTurn(projectId, `Is this Anthropic key safe to use in a function? ${key}`, 'Store it with set_env_var rather than in code.')

    const { provider } = await chatTurn('why not in code?', 'Because code is read by everyone who can read the project.')
    await usageSettled(2)

    const sent = JSON.stringify(answerCall(provider).messages)
    expect(sent).not.toContain(key)
    expect(sent).toContain('[REDACTED]')
  }, 60_000)

  it('still answers a first question, which has no history, from the message alone', async () => {
    const { result, provider } = await chatTurn('what is Backenly?', 'An autonomous backend platform.')
    await usageSettled(2)

    expect(result).toMatchObject({ success: true, summary: 'An autonomous backend platform.' })
    expect(answerCall(provider).messages).toEqual([{ role: 'user', content: 'what is Backenly?' }])
  }, 60_000)
})
