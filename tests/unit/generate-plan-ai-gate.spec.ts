/**
 * The backend change plan is written through the AI gateway (lib/ai/llm), so
 * its route asks the gateway whether AI is available, not whether an OpenAI
 * key happens to be set. A deployment that runs Claude on Amazon Bedrock may
 * have no OpenAI key at all, and the old gate refused every plan there.
 *
 * Authentication, the ownership check and the plan generator are stand-ins
 * (the generator would call a model and read the database); the gate is real.
 */

// Before next/server: NextRequest extends whichever Request is global when it loads.
import '../helpers/next-request-polyfill'
import { NextRequest } from 'next/server'

jest.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: jest.fn(async () => ({ authenticated: true, userId: 'u1' })),
}))
jest.mock('@/lib/edition/guard', () => ({
  canAccessProject: jest.fn(async () => true),
}))
const mockGenerate = jest.fn(async (_prompt: string, _projectId: string) => ({ id: 'plan-1', changes: [] }))
jest.mock('@/lib/services/aiWorkspace', () => ({
  generateBackendChangePlan: (prompt: string, projectId: string) => mockGenerate(prompt, projectId),
}))

import { POST } from '@/app/api/ai-workspace/generate-plan/route'

const AI_ENV = ['AI_PROVIDER', 'BEDROCK_REGION', 'AWS_REGION', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const
const saved: Partial<Record<(typeof AI_ENV)[number], string>> = {}
let errorLog: jest.SpyInstance

beforeEach(() => {
  for (const k of AI_ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  mockGenerate.mockClear()
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  for (const k of AI_ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  // Not jest.restoreAllMocks(): in Jest 29 it also drops the module mocks' implementations.
  errorLog.mockRestore()
})

const askForPlan = () =>
  POST(
    new NextRequest('http://localhost/api/ai-workspace/generate-plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a todo app', projectId: 'p1' }),
    }),
  )

describe('the plan route’s AI gate', () => {
  it('plans with Claude on Bedrock when no OpenAI key is set', async () => {
    process.env.AI_PROVIDER = 'bedrock'
    process.env.BEDROCK_REGION = 'ap-south-1'

    const res = await askForPlan()

    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith('a todo app', 'p1')
  })

  it('plans with the Claude API too', async () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    expect((await askForPlan()).status).toBe(200)
  })

  it('refuses with 503, before anything is generated, when no provider is configured', async () => {
    const res = await askForPlan()

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'AI plan generation is temporarily unavailable. Please try again later.' })
    expect(mockGenerate).not.toHaveBeenCalled()
    // The reason goes to the log, for the operator.
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('[generate-plan]'), expect.stringMatching(/No AI provider is configured/))
  })

  it('refuses a provider chosen but not configured', async () => {
    process.env.AI_PROVIDER = 'bedrock'
    process.env.OPENAI_API_KEY = 'k'
    expect((await askForPlan()).status).toBe(503)
    expect(mockGenerate).not.toHaveBeenCalled()
  })
})
