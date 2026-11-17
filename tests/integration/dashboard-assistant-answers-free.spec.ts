/**
 * The dashboard assistant answers questions free, as the Pricing page says
 * ("The dashboard assistant answers questions free"), with no AI credits left
 * as with plenty.
 *
 * It was never charged, but its model call was customer-paid by default
 * (purpose brain.answer, with the project named). So once the account's
 * credits were used up, the credit hold refused the call, and the assistant
 * answered "This account has used its AI credits for the month." instead
 * (production QA re-test, 2026-11-16, #98). The platform now pays for it,
 * within the platform's own monthly budget, as it does for a function heal.
 *
 * Real: the route, the gateway and its spend rules, the credit hold, and the
 * account's usage row. Stood in: the model (a scripted provider that streams
 * its answer), the sign-in check, and the Cloud provider's plan
 * (`@cloud/entitlements`).
 */
let mockProjectId = ''
let mockUserId = ''
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: unknown, handler: (v: unknown) => unknown) =>
    handler({ projectId: mockProjectId, userId: mockUserId, project: { id: mockProjectId, name: 'assistant-free' } }),
}))
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return {
    ...actual,
    cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', monthlyAiCredits: 200 }),
    bonusCredits: async () => 0,
    purchasedCredits: async () => 0,
  }
})

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { AiError, setProviderForTests } from '@/lib/ai/llm'
import { chat } from '@/lib/ai/llm/chat'
import { scriptedMessage, scriptedProvider, type ScriptStep } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { thisMonth, TOKENS_PER_CREDIT } from '@/lib/entitlements/policy'
import { invalidateUsageCache } from '@/lib/entitlements/usage-cache'
import { invalidateAccountLimits } from '@/lib/usage/overage'
import { POST } from '@/app/api/projects/[id]/assistant/route'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ANSWER = 'Open Database, choose the table, then use Add column.'

let ledger: ReturnType<typeof memorySpendLedger>

/** The model's answer, streamed out as it is written, as the Claude providers do. */
const streamsTheAnswer: ScriptStep = (_params, opts) => {
  opts.onText?.(ANSWER)
  return scriptedMessage({ text: ANSWER })
}

/** The account has used every credit of its plan's 200 this month. */
async function useAllCredits(): Promise<void> {
  const tokenCount = 200 * TOKENS_PER_CREDIT
  await prisma.accountAiUsage.upsert({
    where: { billingAccountId_date: { billingAccountId: mockUserId, date: thisMonth() } },
    create: { billingAccountId: mockUserId, date: thisMonth(), tokenCount },
    update: { tokenCount },
  })
  invalidateUsageCache(mockUserId)
  invalidateAccountLimits(mockUserId)
}

/** Ask the dashboard assistant, and read its whole streamed answer. */
async function ask(question: string): Promise<string> {
  const req = new NextRequest(`http://localhost/api/projects/${mockProjectId}/assistant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
  })
  const res = await POST(req)
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  mockUserId = (await prisma.user.create({
    data: { email: `assistant-free-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'Assistant' },
    select: { id: true },
  })).id
  mockProjectId = (await prisma.project.create({ data: { name: 'assistant-free', userId: mockUserId }, select: { id: true } })).id
  await useAllCredits()
}, 60_000)

afterAll(async () => {
  process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  await prisma.aiCreditHold.deleteMany({ where: { billingAccountId: mockUserId } }).catch(() => {})
  await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: mockUserId } }).catch(() => {})
  await prisma.aiUsage.deleteMany({ where: { projectId: mockProjectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: mockProjectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: mockUserId } }).catch(() => {})
  await prisma.$disconnect()
}, 60_000)

beforeEach(() => {
  ledger = memorySpendLedger()
  setSpendLedgerForTests(ledger)
})

afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

it('answers with no AI credits left, holding none of them, within the platform budget', async () => {
  const provider = scriptedProvider([streamsTheAnswer])
  setProviderForTests(provider)

  expect(await ask('How do I add a column?')).toBe(ANSWER)
  expect(provider.calls).toHaveLength(1)
  expect(await prisma.aiCreditHold.count({ where: { billingAccountId: mockUserId } })).toBe(0)
  // Booked as the platform's own spend: it counts against the platform's budget.
  expect([...ledger.holds.values()].map((h) => h.scopes)).toEqual([['total', 'platform']])
}, 60_000)

it('CONTROL: the account has no credits left, so a call it pays for is refused', async () => {
  setProviderForTests(scriptedProvider([scriptedMessage({ text: ANSWER })]))
  const refused = await chat({
    purpose: 'brain.answer',
    messages: [{ role: 'user', content: 'How do I add a column?' }],
    billing: { projectId: mockProjectId },
  }).catch((e: unknown) => e)
  expect(refused).toBeInstanceOf(AiError)
  expect((refused as AiError).kind).toBe('credits_exhausted')
  expect((refused as AiError).userMessage).toBe('This account has used its AI credits for the month.')
}, 60_000)
