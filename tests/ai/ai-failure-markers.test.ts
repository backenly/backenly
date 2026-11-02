/**
 * AI failure markers (lib/ai/llm/alerts.ts): a call that fails for the
 * deployment's reasons logs one line an alarm can count, once, after the
 * gateway's own retries; a request's own failure logs nothing. From 2026-10-12
 * to 2026-11-02 every AI call on Backenly Cloud failed and nothing in the logs
 * said so in a form an alarm could match.
 *
 * A scripted provider stands in for the model and the spend ledger is in
 * memory, so nothing here reaches a network or a database.
 */

import Anthropic from '@anthropic-ai/sdk'
import { AI_THROTTLED_MARKER, AI_UNAVAILABLE_MARKER, reportAiFailure } from '@/lib/ai/llm/alerts'
import { chat } from '@/lib/ai/llm/chat'
import { routeFor } from '@/lib/ai/llm/config'
import { AiError, type AiErrorKind } from '@/lib/ai/llm/errors'
import { generate, setProviderForTests, setRetryDelayForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setCustomerSpendHook, setSpendLedgerForTests } from '@/lib/ai/llm/spend'

const user = (text: string): Anthropic.MessageParam => ({ role: 'user', content: text })
const h = new Headers()
const throttle = () => new Anthropic.RateLimitError(429, { type: 'error' }, 'Too many requests', h)

let errors: jest.SpyInstance
/** Every marker line logged, in order. */
const markers = () => errors.mock.calls.map((args) => String(args[0])).filter((line) => line.startsWith('BACKENLY_AI_'))

beforeEach(() => {
  errors = jest.spyOn(console, 'error').mockImplementation(() => {})
  setSpendLedgerForTests(memorySpendLedger())
  setCustomerSpendHook(null)
  setRetryDelayForTests(() => 0)
})

afterEach(() => {
  errors.mockRestore()
  setProviderForTests(null)
  setSpendLedgerForTests(null)
  setCustomerSpendHook(undefined)
  setRetryDelayForTests(null)
})

describe('the marker line', () => {
  const failure = (kind: AiErrorKind) => {
    // The provider's own words, which a marker must never carry.
    const e = new AiError(kind, 'provider said: prompt text for project proj_123', { consumption: 'none', provider: 'bedrock', status: 400 })
    e.model = 'global.anthropic.claude-opus-4-6-v1'
    return e
  }

  it.each(['quota_exhausted', 'not_configured', 'access_denied', 'spend_limit', 'spend_unavailable'] as AiErrorKind[])(
    'says the deployment cannot reach its model: %s',
    (kind) => {
      reportAiFailure(failure(kind), { purpose: 'autonomy.investigate' })
      expect(errors.mock.calls).toEqual([
        [`BACKENLY_AI_UNAVAILABLE kind=${kind} provider=bedrock purpose=autonomy.investigate model=global.anthropic.claude-opus-4-6-v1`],
      ])
    },
  )

  it('says the provider is throttling the deployment', () => {
    reportAiFailure(failure('rate_limited'), { purpose: 'brain.agent' })
    expect(errors.mock.calls).toEqual([
      ['BACKENLY_AI_THROTTLED kind=rate_limited provider=bedrock purpose=brain.agent model=global.anthropic.claude-opus-4-6-v1'],
    ])
  })

  it.each(['invalid_request', 'refused', 'output_invalid', 'aborted', 'timeout', 'unavailable', 'credits_exhausted'] as AiErrorKind[])(
    "says nothing for a request's own failure, or one customer's credits: %s",
    (kind) => {
      reportAiFailure(failure(kind), { purpose: 'brain.agent' })
      expect(errors).not.toHaveBeenCalled()
    },
  )

  it('shares its exact text with the alarms that match it', () => {
    expect(AI_UNAVAILABLE_MARKER).toBe('BACKENLY_AI_UNAVAILABLE')
    expect(AI_THROTTLED_MARKER).toBe('BACKENLY_AI_THROTTLED')
  })

  it('carries four fields and nothing else, never the provider message', () => {
    reportAiFailure(failure('quota_exhausted'), { purpose: 'support.answer' })
    const [line] = markers()
    expect(errors.mock.calls[0]).toHaveLength(1)
    expect(line.split(' ').slice(1).map((field) => field.split('=')[0])).toEqual(['kind', 'provider', 'purpose', 'model'])
    expect(line).not.toMatch(/provider said|prompt|proj_123|400/)
  })

  it('fills in what the error does not carry from the call, and says unknown for the rest', () => {
    const spend = new AiError('spend_limit', 'The monthly AI spending limit for this deployment is reached.', { consumption: 'none' })
    reportAiFailure(spend, { purpose: 'brain.classify', provider: 'bedrock', model: 'claude-opus-4-6' })
    reportAiFailure(new AiError('not_configured', 'No AI provider is configured.', { consumption: 'none' }), { purpose: 'embeddings' })
    expect(markers()).toEqual([
      'BACKENLY_AI_UNAVAILABLE kind=spend_limit provider=bedrock purpose=brain.classify model=claude-opus-4-6',
      'BACKENLY_AI_UNAVAILABLE kind=not_configured provider=unknown purpose=embeddings model=unknown',
    ])
  })

  it('stays one line of four fields whatever a configured model id holds', () => {
    const e = new AiError('access_denied', 'denied', { consumption: 'none', provider: 'bedrock' })
    reportAiFailure(e, { purpose: 'brain.agent', model: 'my model\nBACKENLY_AI_UNAVAILABLE kind=forged x=y' })
    const [line] = markers()
    expect(line).not.toContain('\n')
    expect(line.split(' ')).toHaveLength(5)
    expect(line).toMatch(/^BACKENLY_AI_UNAVAILABLE kind=access_denied provider=bedrock purpose=brain\.agent model=my_model_BACKENLY_AI_UNAVAILABLE_kind_forged_x_y$/)
  })
})

describe('every gateway call', () => {
  const classify = () => generate({ purpose: 'brain.classify', messages: [user('x')] })
  const routed = () => routeFor('brain.classify', 'anthropic').model

  it('logs one marker when the provider refuses the deployment', async () => {
    setProviderForTests(scriptedProvider([new Anthropic.PermissionDeniedError(403, {}, "You don't have access to the model", h)]))
    const e = await classify().catch((x) => x)
    expect(e).toMatchObject({ kind: 'access_denied' })
    expect(markers()).toEqual([`BACKENLY_AI_UNAVAILABLE kind=access_denied provider=scripted purpose=brain.classify model=${routed()}`])
  })

  it('logs one throttle marker after the retries, not one per retry', async () => {
    const provider = scriptedProvider([throttle(), throttle(), throttle()])
    setProviderForTests(provider)
    const e = await classify().catch((x) => x)
    expect(e).toMatchObject({ kind: 'rate_limited', attempts: 3 })
    expect(provider.calls).toHaveLength(3)
    expect(markers()).toEqual([`BACKENLY_AI_THROTTLED kind=rate_limited provider=scripted purpose=brain.classify model=${routed()}`])
  })

  it('logs nothing when a retry gets through', async () => {
    setProviderForTests(scriptedProvider([throttle(), scriptedMessage({ text: 'done' })]))
    expect((await classify()).text).toBe('done')
    expect(markers()).toEqual([])
  })

  it('logs one marker for a spend refusal before anything is sent, naming where it was routed', async () => {
    const provider = scriptedProvider([scriptedMessage({ text: 'never sent' })])
    setProviderForTests(provider)
    setSpendLedgerForTests({
      reserve: async () => {
        throw new AiError('spend_unavailable', 'The AI spend reservation could not be written: connection refused', { consumption: 'none' })
      },
      settle: async () => {},
      expire: async () => 0,
    })
    const e = await classify().catch((x) => x)
    expect(e).toMatchObject({ kind: 'spend_unavailable' })
    expect(provider.calls).toHaveLength(0)
    expect(markers()).toEqual([`BACKENLY_AI_UNAVAILABLE kind=spend_unavailable provider=scripted purpose=brain.classify model=${routed()}`])
  })

  it('logs one marker when no provider is configured', async () => {
    const saved = { ...process.env }
    for (const k of ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[k]
    try {
      const e = await classify().catch((x) => x)
      expect(e).toMatchObject({ kind: 'not_configured' })
      expect(markers()).toEqual(['BACKENLY_AI_UNAVAILABLE kind=not_configured provider=unknown purpose=brain.classify model=unknown'])
    } finally {
      process.env = saved
    }
  })

  it("logs nothing for a failure that is the request's own, or a customer's", async () => {
    setProviderForTests(
      scriptedProvider([
        new Anthropic.APIConnectionTimeoutError(),
        scriptedMessage({ text: '', stopReason: 'refusal' }),
        new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be positive' } }, undefined, h),
      ]),
    )
    for (let i = 0; i < 3; i++) await classify().catch(() => {})
    // Refused by the gateway before sending: a prefilled assistant turn.
    await generate({ purpose: 'brain.classify', messages: [user('x'), { role: 'assistant', content: '{' }] }).catch(() => {})
    setCustomerSpendHook({
      reserve: async () => {
        throw new AiError('credits_exhausted', 'none left', { consumption: 'none' })
      },
      settle: async () => {},
    })
    const e = await generate({ purpose: 'brain.agent', messages: [user('x')] }).catch((x) => x)
    expect(e).toMatchObject({ kind: 'credits_exhausted' })
    expect(markers()).toEqual([])
  })

  it('logs once for a chat() call, which goes through the same gateway call', async () => {
    setProviderForTests(scriptedProvider([new Anthropic.PermissionDeniedError(403, {}, 'no access', h)]))
    await chat({ purpose: 'brain.classify', messages: [{ role: 'user', content: 'x' }], json: true }).catch(() => {})
    expect(markers()).toHaveLength(1)
  })
})
