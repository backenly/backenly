/**
 * A FUNCTION'S anthropic.complete() ANSWERS AGAIN (#607)
 * =====================================================
 * ctx.integrations.anthropic.complete() sent every request to
 * claude-3-5-haiku-20241022, which the Claude API retired on 2026-02-19 and
 * answers with a 404. Every function that called it threw "Anthropic error:
 * …", the anthropic-chat function a connect wires up included, while the
 * Integrations page still showed the key as confirmed.
 *
 * Here function rows run in the real sandbox worker (executeAiFunction), with
 * the project's keys read from the real vault, and call complete() the way the
 * auto-wired chat functions do and with the options a function can now pass.
 * Anthropic and OpenAI are stubbed at fetch with the runtime's real Response.
 * The Anthropic stand-in answers a retired model with the API's 404, so a
 * helper still pinned to one fails here as it does in production.
 */
import '../helpers/real-web-standard'
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { encrypt } from '@/lib/services/encryption'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

// Visibly synthetic keys, built at runtime so no key-shaped literal sits in the repository.
const KEYS = {
  anthropic: ['sk', 'ant', 'fn607'.repeat(5)].join('-'),
  openai: ['sk', 'fn607'.repeat(5)].join('-'),
}
// As https://docs.claude.com/en/docs/about-claude/model-deprecations lists them.
const RETIRED_CLAUDE_MODELS = new Set(['claude-3-5-haiku-20241022', 'claude-3-haiku-20240307', 'claude-3-7-sonnet-20250219'])

interface Sent {
  host: string
  headers: Headers
  body: any
}
let sent: Sent[] = []
let realFetch: typeof fetch
let userId = ''
let projectId = ''

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_607' } })

/** What the Messages API answers: a 404 for a retired model, and otherwise thinking, then the answer. */
function anthropicAnswer(body: any): Response {
  if (RETIRED_CLAUDE_MODELS.has(body.model)) {
    return json(404, { type: 'error', error: { type: 'not_found_error', message: `model: ${body.model}` }, request_id: 'req_607' })
  }
  return json(200, {
    id: 'msg_607',
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [
      { type: 'thinking', thinking: '', signature: 'sig_607' },
      { type: 'text', text: `Claude says hi to ${body.messages[0].content}` },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 12, output_tokens: 34 },
  })
}

async function runFunction(name: string, code: string, data: Record<string, unknown>) {
  const fn = await prisma.aiFunction.create({
    data: { projectId, name, description: name, triggerType: 'manual', status: 'active', generatedCode: code },
  })
  return executeAiFunction(fn.id, projectId, { type: 'manual', data }, { selfHeal: false })
}

beforeAll(async () => {
  assertSafeTestDatabase()
  userId = (await prisma.user.create({
    data: { email: `ai-helpers-${crypto.randomBytes(6).toString('hex')}@example.test`, name: 'AI helpers' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'ai-helpers-current-models', userId }, select: { id: true } })).id
  for (const [integrationId, key] of Object.entries(KEYS)) {
    await prisma.projectIntegrationKey.create({
      data: { projectId, integrationId, encryptedKey: encrypt(key), maskedKey: `${key.slice(0, 6)}…`, verification: 'verified' },
    })
  }

  realFetch = global.fetch
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const host = new URL(request.url).host
    if (host !== 'api.anthropic.com' && host !== 'api.openai.com') return realFetch(input, init)
    const body = JSON.parse(await request.text())
    sent.push({ host, headers: request.headers, body })
    if (host === 'api.anthropic.com') return anthropicAnswer(body)
    return json(200, { id: 'chatcmpl-607', choices: [{ index: 0, message: { role: 'assistant', content: 'OpenAI says hi' } }] })
  }) as typeof fetch
}, 60_000)

beforeEach(() => {
  sent = []
})

afterAll(async () => {
  global.fetch = realFetch
  if (projectId) {
    await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.projectIntegrationKey.deleteMany({ where: { projectId } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId } }).catch(() => {})
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}, 60_000)

it('the anthropic-chat call, complete(prompt, maxTokens, systemPrompt), answers with a current Claude model', async () => {
  const result = await runFunction(
    'anthropic-chat',
    `
      const { prompt, systemPrompt, maxTokens } = event.data
      return { reply: await ctx.integrations.anthropic.complete(prompt, maxTokens, systemPrompt) }
    `,
    { prompt: 'the team', systemPrompt: 'Be warm.', maxTokens: 300 },
  )

  expect({ success: result.success, error: result.error }).toEqual({ success: true, error: undefined })
  expect(result.returnValue).toEqual({ reply: 'Claude says hi to the team' })
  expect(sent).toHaveLength(1)
  expect(sent[0].host).toBe('api.anthropic.com')
  expect(sent[0].headers.get('x-api-key')).toBe(KEYS.anthropic)
  expect(sent[0].body).toEqual({
    model: 'claude-haiku-5-5',
    max_tokens: 300,
    system: 'Be warm.',
    messages: [{ role: 'user', content: 'the team' }],
    output_config: { effort: 'low' },
  })
}, 60_000)

it('a function names its model and effort, and a retired model fails with what the API said', async () => {
  const chosen = await runFunction(
    'claude-opus-summary',
    `return { reply: await ctx.integrations.anthropic.complete(event.data.prompt, { model: 'claude-opus-5-5', effort: 'high' }) }`,
    { prompt: 'everyone' },
  )
  expect({ success: chosen.success, error: chosen.error }).toEqual({ success: true, error: undefined })
  expect(chosen.returnValue).toEqual({ reply: 'Claude says hi to everyone' })
  expect(sent[0].body).toEqual({
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'everyone' }],
    output_config: { effort: 'high' },
  })

  const retired = await runFunction(
    'pinned-to-a-retired-model',
    `return { reply: await ctx.integrations.anthropic.complete('hi', { model: 'claude-3-5-haiku-20241022' }) }`,
    {},
  )
  expect(retired.success).toBe(false)
  expect(retired.error).toContain('Anthropic error: model: claude-3-5-haiku-20241022 (HTTP 404)')
}, 60_000)

it("the openai-chat call's systemPrompt reaches OpenAI, with gpt-4o-mini unless the function names a model", async () => {
  const result = await runFunction(
    'openai-chat',
    `
      const { prompt, systemPrompt, maxTokens } = event.data
      const reply = await ctx.integrations.openai.complete(prompt, maxTokens, systemPrompt)
      const named = await ctx.integrations.openai.complete(prompt, { model: 'gpt-6-luna' })
      return { reply, named }
    `,
    { prompt: 'Hello', systemPrompt: 'Answer in one word.', maxTokens: 50 },
  )

  expect({ success: result.success, error: result.error }).toEqual({ success: true, error: undefined })
  expect(result.returnValue).toEqual({ reply: 'OpenAI says hi', named: 'OpenAI says hi' })
  expect(sent.map((s) => s.host)).toEqual(['api.openai.com', 'api.openai.com'])
  expect(sent[0].headers.get('authorization')).toBe(`Bearer ${KEYS.openai}`)
  expect(sent.map((s) => s.body)).toEqual([
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: 'Answer in one word.' }, { role: 'user', content: 'Hello' }],
      max_completion_tokens: 50,
    },
    { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Hello' }], max_completion_tokens: 256 },
  ])
}, 60_000)
