/**
 * The dashboard assistant is free to the person asking and paid by the
 * platform, so its answers are budgeted each day: per person, per project and
 * for the whole platform (app/api/projects/[id]/assistant/route.ts).
 *
 * Without the budget, any signed-in account, free ones included, could ask 20
 * questions a minute on every project it creates, each one a platform-paid
 * model call, and spend the platform's monthly AI budget that autonomy and
 * support answers share.
 *
 * Real: the route and the rate-limit counters (the in-memory store a single
 * process uses). Stood in: the session check, the model, and the project's
 * grounding.
 */

import '@/tests/helpers/real-web-standard'

let mockUserId = 'user-a'
let mockProjectId = 'project-a'
let mockStoreDown = false
let mockAiFrozen = false

jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: unknown, handler: (v: unknown) => unknown) =>
    handler({ projectId: mockProjectId, userId: mockUserId, project: { id: mockProjectId, name: 'budgeted' } }),
}))
jest.mock('@/lib/middleware/rateLimiter', () => ({
  enforceAiChatRateLimit: jest.fn(async () => ({ allowed: true, remaining: 19, resetAt: Date.now() + 60_000 })),
  getRateLimitHeaders: () => ({}),
}))
jest.mock('@/lib/ai/llm', () => ({
  AiError: class AiError extends Error {
    userMessage = 'model error'
  },
  aiAvailability: () => ({ available: true }),
}))
jest.mock('@/lib/ai/llm/chat', () => ({
  chat: jest.fn(async (opts: { onText?: (t: string) => void }) => {
    opts.onText?.('answer')
  }),
}))
jest.mock('@/lib/ai/brain/prompts', () => ({ assistantPrompt: () => 'system' }))
jest.mock('@/lib/services/connect-manifest', () => ({
  buildConnectManifest: async () => {
    throw new Error('no grounding in this test')
  },
}))
jest.mock('@/lib/services/public-url', () => ({ resolvePublicBaseUrl: () => 'http://localhost:3000' }))
jest.mock('@/lib/mcp/agent-connection', () => ({ agentConnectionFor: async () => null }))
jest.mock('@/lib/platform-controls', () => ({
  assertAiAllowed: jest.fn(async () =>
    mockAiFrozen ? { ok: false, reason: 'AI execution is currently frozen by the platform operator.', status: 503 } : { ok: true },
  ),
}))
jest.mock('@/lib/security/auth-rate-limit', () => {
  const actual = jest.requireActual('@/lib/security/auth-rate-limit')
  return {
    ...actual,
    consume: jest.fn((...args: [string, number, number]) =>
      mockStoreDown
        ? Promise.resolve({ allowed: false, outcome: 'store_unavailable', remaining: 0, retryAfter: 60, resetAt: Date.now() + 60_000 })
        : actual.consume(...args),
    ),
  }
})

import { chat } from '@/lib/ai/llm/chat'
import { consume, reset } from '@/lib/security/auth-rate-limit'
import { ASSISTANT_DAILY_ANSWERS, POST } from '@/app/api/projects/[id]/assistant/route'

const DAY_MS = 24 * 60 * 60 * 1000
const chatMock = chat as jest.MockedFunction<typeof chat>
let run = 0

async function ask(): Promise<{ status: number; text: string; retryAfter: string | null }> {
  const req = {
    url: `http://localhost:3000/api/projects/${mockProjectId}/assistant`,
    headers: new Headers(),
    json: async () => ({ messages: [{ role: 'user', content: 'How do I add a column?' }] }),
  }
  const res: any = await POST(req as any)
  return { status: res.status, text: await res.text(), retryAfter: res.headers.get('Retry-After') }
}

beforeEach(async () => {
  run++
  mockUserId = `user-${run}`
  mockProjectId = `project-${run}`
  mockStoreDown = false
  mockAiFrozen = false
  chatMock.mockClear()
  await reset('assistant:platform')
})

it('answers a person up to their daily budget, then refuses without calling the model', async () => {
  for (let i = 0; i < ASSISTANT_DAILY_ANSWERS.user; i++) {
    expect((await ask()).status).toBe(200)
  }
  const refused = await ask()

  expect(refused.status).toBe(429)
  expect(JSON.parse(refused.text).error).toBe('The assistant has answered as many questions as it can for today. It answers again tomorrow.')
  expect(Number(refused.retryAfter)).toBeGreaterThan(0)
  expect(chatMock).toHaveBeenCalledTimes(ASSISTANT_DAILY_ANSWERS.user)
})

it('caps one project however many people ask on it', async () => {
  const project = mockProjectId
  for (let i = 0; i < ASSISTANT_DAILY_ANSWERS.project; i++) {
    mockUserId = `user-${run}-${i}`
    expect((await ask()).status).toBe(200)
  }
  mockUserId = `user-${run}-one-more`
  mockProjectId = project

  expect((await ask()).status).toBe(429)
  expect(chatMock).toHaveBeenCalledTimes(ASSISTANT_DAILY_ANSWERS.project)
})

it('caps the whole platform, across every person and project', async () => {
  for (let i = 0; i < ASSISTANT_DAILY_ANSWERS.platform; i++) {
    await consume('assistant:platform', ASSISTANT_DAILY_ANSWERS.platform, DAY_MS)
  }

  expect((await ask()).status).toBe(429)
  expect(chatMock).not.toHaveBeenCalled()
})

it('refuses rather than answering uncounted when the counter store is down', async () => {
  mockStoreDown = true

  const refused = await ask()

  expect(refused.status).toBe(503)
  expect(JSON.parse(refused.text).error).toBe('The assistant is not available right now. Try again in a moment.')
  expect(chatMock).not.toHaveBeenCalled()
})

it('stops when the operator freezes AI, spending none of the budget', async () => {
  mockAiFrozen = true

  expect((await ask()).status).toBe(503)
  expect(chatMock).not.toHaveBeenCalled()

  mockAiFrozen = false
  for (let i = 0; i < ASSISTANT_DAILY_ANSWERS.user; i++) {
    expect((await ask()).status).toBe(200)
  }
  expect((await ask()).status).toBe(429)
})
