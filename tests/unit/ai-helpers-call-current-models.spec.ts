/**
 * THE AI HELPERS CALL CURRENT MODELS, AND A FUNCTION CAN NAME ITS OWN (#607)
 * =========================================================================
 * ctx.integrations.anthropic.complete() sent every request to
 * claude-3-5-haiku-20241022, which the Claude API retired on 2026-02-19 and
 * answers with a 404, so every function that called it threw, the
 * anthropic-chat function a connect wires up included. openai.complete() is
 * pinned the same way, to a model OpenAI shuts down on 2027-01-14.
 *
 * The defaults live in lib/services/ai-functions/model-defaults.ts, both
 * helpers take { model, maxTokens, system } (and effort, on Anthropic) besides
 * the positional form functions were written with, and the Anthropic helper
 * goes through the official SDK. Each provider is stubbed at fetch, answering
 * with the runtime's real Response as the SDK reads it; no provider is called.
 */
import '../helpers/real-web-standard'
import fs from 'fs'
import path from 'path'
import { AI_HELPER_DEFAULTS } from '@/lib/services/ai-functions/model-defaults'
import { buildAnthropicIntegration, buildOpenAIIntegration } from '@/lib/services/ai-functions/integration-context'
import { INTEGRATION_PROVIDERS } from '@/lib/services/ai-functions/integration-registry'

const ROOT = process.cwd()
// Visibly synthetic keys, built at runtime so no key-shaped literal sits in the repository.
const ANTHROPIC_KEY = ['sk', 'ant', 'k607'.repeat(6)].join('-')
const OPENAI_KEY = ['sk', 'k607'.repeat(6)].join('-')

interface Sent {
  url: string
  method: string
  headers: Headers
  body: any
}
let sent: Sent[] = []
const realFetch = global.fetch

/** Every request is kept in `sent` and answered with `make(body)`. */
function answerWith(make: (body: any) => Response) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = JSON.parse(await request.text())
    sent.push({ url: request.url, method: request.method, headers: request.headers, body })
    return make(body)
  }) as typeof fetch
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_607' } })

/** A Messages API reply, as Claude Haiku 5.5 sends one: thinking first, then the answer. */
const claudeReply = (content: unknown[], stopReason = 'end_turn', stopDetails: unknown = null) =>
  json(200, {
    id: 'msg_607',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: stopDetails,
    usage: { input_tokens: 12, output_tokens: 34 },
  })
const THINKING = { type: 'thinking', thinking: '', signature: 'sig_607' }

beforeEach(() => {
  sent = []
})

afterEach(() => {
  global.fetch = realFetch
})

describe('ctx.integrations.anthropic.complete()', () => {
  it('calls claude-haiku-5-5 at effort low through the Messages API, and returns the text after the thinking', async () => {
    answerWith(() => claudeReply([THINKING, { type: 'text', text: 'Paris.' }]))
    const reply = await buildAnthropicIntegration(ANTHROPIC_KEY).complete('Capital of France?')
    expect(reply).toBe('Paris.')
    expect(sent).toHaveLength(1)
    expect([sent[0].method, sent[0].url]).toEqual(['POST', 'https://api.anthropic.com/v1/messages'])
    expect(sent[0].headers.get('x-api-key')).toBe(ANTHROPIC_KEY)
    expect(sent[0].headers.get('anthropic-version')).toBe('2023-06-01')
    // Exactly this: no sampling parameter (Claude Haiku 5.5 refuses them), no thinking setting.
    expect(sent[0].body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Capital of France?' }],
      output_config: { effort: 'low' },
    })
  })

  it("sends the project's key to api.anthropic.com alone, whatever ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN this server has", async () => {
    const before = { base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN }
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.platform.invalid'
    process.env.ANTHROPIC_AUTH_TOKEN = 'platform-token-607'
    try {
      answerWith(() => claudeReply([{ type: 'text', text: 'ok' }]))
      await buildAnthropicIntegration(ANTHROPIC_KEY).complete('q')
    } finally {
      for (const [name, value] of [['ANTHROPIC_BASE_URL', before.base], ['ANTHROPIC_AUTH_TOKEN', before.token]] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    expect(sent[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(sent[0].headers.get('x-api-key')).toBe(ANTHROPIC_KEY)
    expect(sent[0].headers.get('authorization')).toBeNull()
  })

  it('takes a model, maxTokens, a system prompt and effort; a model it names keeps its own effort unless one is passed', async () => {
    answerWith(() => claudeReply([{ type: 'text', text: 'ok' }]))
    const claude = buildAnthropicIntegration(ANTHROPIC_KEY)
    await claude.complete('q', { model: 'claude-opus-5-5', maxTokens: 4000, system: 'Be brief.' })
    await claude.complete('q', { model: 'claude-opus-5-5', effort: 'high' })
    await claude.complete('q', { effort: 'medium' })
    expect(sent.map((s) => s.body)).toEqual([
      { model: 'claude-opus-5-5', max_tokens: 4000, system: 'Be brief.', messages: [{ role: 'user', content: 'q' }] },
      { model: 'claude-opus-5-5', max_tokens: 1024, messages: [{ role: 'user', content: 'q' }], output_config: { effort: 'high' } },
      { model: 'claude-haiku-5-5', max_tokens: 1024, messages: [{ role: 'user', content: 'q' }], output_config: { effort: 'medium' } },
    ])
  })

  it('still takes complete(prompt, maxTokens, systemPrompt), as generated functions call it', async () => {
    answerWith(() => claudeReply([{ type: 'text', text: 'Yes.' }]))
    expect(await buildAnthropicIntegration(ANTHROPIC_KEY).complete('Is water wet?', 200, 'Answer in one word.')).toBe('Yes.')
    expect(sent[0].body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 200,
      system: 'Answer in one word.',
      messages: [{ role: 'user', content: 'Is water wet?' }],
      output_config: { effort: 'low' },
    })
  })

  it('says what the API said when the model is retired or unknown, once, with no retry', async () => {
    answerWith((body) =>
      json(404, { type: 'error', error: { type: 'not_found_error', message: `model: ${body.model}` }, request_id: 'req_607' }),
    )
    await expect(
      buildAnthropicIntegration(ANTHROPIC_KEY).complete('q', { model: 'claude-3-5-haiku-20241022' }),
    ).rejects.toThrow('Anthropic error: model: claude-3-5-haiku-20241022 (HTTP 404)')
    expect(sent).toHaveLength(1)
  })

  it('throws when Claude declines the prompt, rather than returning an empty answer', async () => {
    answerWith(() => claudeReply([], 'refusal', { type: 'refusal', category: 'cyber', explanation: null }))
    await expect(buildAnthropicIntegration(ANTHROPIC_KEY).complete('q')).rejects.toThrow(
      'Anthropic declined this prompt (stop_reason "refusal", category "cyber").',
    )
  })

  it('throws when thinking used all of maxTokens before any reply, and returns a reply maxTokens cut short', async () => {
    answerWith(() => claudeReply([THINKING], 'max_tokens'))
    await expect(buildAnthropicIntegration(ANTHROPIC_KEY).complete('q')).rejects.toThrow(
      /^Anthropic reached maxTokens \(1024\) before writing any reply; its thinking counts toward it\./,
    )

    answerWith(() => claudeReply([THINKING, { type: 'text', text: 'The first half' }], 'max_tokens'))
    expect(await buildAnthropicIntegration(ANTHROPIC_KEY).complete('q')).toBe('The first half')
  })
})

describe('ctx.integrations.openai', () => {
  const chatReply = (content: string) => json(200, { id: 'chatcmpl-607', choices: [{ index: 0, message: { role: 'assistant', content } }] })

  it('complete() calls gpt-4o-mini with max_completion_tokens, which OpenAI takes from every chat model', async () => {
    answerWith(() => chatReply('Hi.'))
    expect(await buildOpenAIIntegration(OPENAI_KEY).complete('Hello')).toBe('Hi.')
    expect([sent[0].method, sent[0].url]).toEqual(['POST', 'https://api.openai.com/v1/chat/completions'])
    expect(sent[0].headers.get('authorization')).toBe(`Bearer ${OPENAI_KEY}`)
    expect(sent[0].body).toEqual({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }], max_completion_tokens: 256 })
  })

  it('complete() takes a model, maxTokens and a system prompt, and the positional systemPrompt now reaches OpenAI', async () => {
    answerWith(() => chatReply('ok'))
    const openai = buildOpenAIIntegration(OPENAI_KEY)
    await openai.complete('q', { model: 'gpt-6-luna', maxTokens: 900, system: 'Be brief.' })
    await openai.complete('q', 100, 'Answer in one word.')
    expect(sent.map((s) => s.body)).toEqual([
      {
        model: 'gpt-6-luna',
        messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'q' }],
        max_completion_tokens: 900,
      },
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: 'Answer in one word.' }, { role: 'user', content: 'q' }],
        max_completion_tokens: 100,
      },
    ])
  })

  it('embed() calls text-embedding-3-small', async () => {
    answerWith(() => json(200, { data: [{ embedding: [0.1, 0.2] }] }))
    expect(await buildOpenAIIntegration(OPENAI_KEY).embed('hello')).toEqual([0.1, 0.2])
    expect(sent[0].body).toEqual({ model: 'text-embedding-3-small', input: 'hello' })
  })
})

describe('the defaults live in one place', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

  it('the helpers and the code generator\'s docs name no model of their own', () => {
    for (const rel of ['lib/services/ai-functions/integration-context.ts', 'lib/services/ai-functions/integration-registry.ts']) {
      expect({ rel, models: read(rel).match(/['"`](claude-|gpt-|text-embedding-)[\w.-]*/g) ?? [] }).toEqual({ rel, models: [] })
    }
  })

  it('the code generator\'s method docs and the agent docs name the defaults', () => {
    const anthropic = AI_HELPER_DEFAULTS.anthropic.complete
    const openai = AI_HELPER_DEFAULTS.openai
    const signature = (provider: string, method: string) =>
      INTEGRATION_PROVIDERS[provider].methods.find((m) => m.name === method)!.signature
    expect(signature('anthropic', 'complete')).toContain(`${anthropic.model} at effort ${anthropic.effort}`)
    expect(signature('openai', 'complete')).toContain(openai.complete.model)
    expect(signature('openai', 'embed')).toContain(openai.embed.model)

    const anthropicDoc = read('public/docs/agents/anthropic.md')
    expect(anthropicDoc).toContain(`\`complete\` calls \`${anthropic.model}\` at effort \`${anthropic.effort}\`, with a \`maxTokens\` of ${anthropic.maxTokens},`)
    const openaiDoc = read('public/docs/agents/openai.md')
    expect(openaiDoc).toContain(`\`complete\` calls \`${openai.complete.model}\`, with a \`maxTokens\` of ${openai.complete.maxTokens},`)
    expect(openaiDoc).toContain(`(${openai.embed.model})`)
  })

  it('the default Claude model is not one the Claude API has retired', () => {
    // https://docs.claude.com/en/docs/about-claude/model-deprecations
    const RETIRED = [
      'claude-3-5-haiku-20241022', 'claude-3-5-haiku-latest', 'claude-3-haiku-20240307', 'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620', 'claude-3-opus-20240229', 'claude-3-sonnet-20240229',
      'claude-2.1', 'claude-2.0', 'claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-opus-4-1-20250805',
    ]
    expect(RETIRED).not.toContain(AI_HELPER_DEFAULTS.anthropic.complete.model)
  })
})
