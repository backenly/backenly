/**
 * Spend safety around every model call (lib/ai/llm/spend.ts): reserved before
 * sending, settled three ways after, limits that concurrent calls cannot
 * overshoot, and a customer never charged for a call whose result was lost.
 * The ledger is in memory here; tests/integration/ai-spend-ledger.spec.ts runs
 * the same rules against Postgres.
 */

import Anthropic from '@anthropic-ai/sdk'
import { generate, setProviderForTests, setRetryDelayForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import {
  defaultPayer,
  memorySpendLedger,
  monthOf,
  setCustomerSpendHook,
  setSpendLedgerForTests,
  spendLimits,
  type CustomerSpendHook,
  type MemorySpendLedger,
} from '@/lib/ai/llm/spend'
import { AiError } from '@/lib/ai/llm/errors'

const user = (text: string): Anthropic.MessageParam => ({ role: 'user', content: text })
const ENV_KEYS = ['AI_TOTAL_MONTHLY_HARD_LIMIT_USD', 'AI_PLATFORM_MONTHLY_BUDGET_USD'] as const

let ledger: MemorySpendLedger
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  ledger = memorySpendLedger()
  setSpendLedgerForTests(ledger)
  setRetryDelayForTests(() => 0)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  setSpendLedgerForTests(null)
  setProviderForTests(null)
  setRetryDelayForTests(null)
  setCustomerSpendHook(null)
})

const period = (scope: 'total' | 'platform') => ledger.periods.get(`${monthOf(new Date())}:${scope}`)
const ok = () => scriptedMessage({ text: 'fine', usage: { input_tokens: 1000, output_tokens: 100 } })
// 1000 x $5/M + 100 x $25/M on Opus 4.6
const OK_COST = 0.0075

describe('who pays', () => {
  it('bills autonomy and support to the deployment and everything else to a customer', () => {
    expect(defaultPayer('autonomy.investigate')).toBe('platform')
    // A support answer is the platform helping its customer; it must never
    // spend the customer's plan credits.
    expect(defaultPayer('support.answer')).toBe('platform')
    expect(defaultPayer('brain.agent')).toBe('customer')
  })

  it('treats a mistyped limit as zero, never as unlimited', () => {
    expect(spendLimits({ AI_TOTAL_MONTHLY_HARD_LIMIT_USD: 'lots' }).totalUsd).toBe(0)
    expect(spendLimits({}).totalUsd).toBeNull()
  })
})

describe('settlement', () => {
  it('charges what the provider reported, and releases the rest of the reservation', async () => {
    setProviderForTests(scriptedProvider([ok()]))
    const r = await generate({ purpose: 'brain.classify', messages: [user('x')] })
    expect(r.costUsd).toBeCloseTo(OK_COST, 6)
    expect(period('total')).toEqual({ reserved: 0, settled: expect.closeTo(OK_COST, 6), unknown: 0 })
  })

  it('charges nothing for a request refused before inference', async () => {
    setProviderForTests(scriptedProvider([new Anthropic.PermissionDeniedError(403, {}, 'no access', new Headers())]))
    const e = await generate({ purpose: 'brain.classify', messages: [user('x')] }).catch((x) => x)
    expect(e).toMatchObject({ kind: 'access_denied', consumption: 'none' })
    expect(period('total')).toEqual({ reserved: 0, settled: 0, unknown: 0 })
  })

  it('books a lost answer at its full reservation, because a timeout is not proof nothing ran', async () => {
    setProviderForTests(scriptedProvider([new Anthropic.APIConnectionTimeoutError()]))
    await generate({ purpose: 'brain.classify', messages: [user('x')] }).catch(() => {})
    const p = period('total')!
    expect(p.reserved).toBeCloseTo(0, 9)
    expect(p.settled).toBe(0)
    const hold = [...ledger.holds.values()][0]
    expect(p.unknown).toBeCloseTo(hold.amountUsd, 9)
    expect(hold.status).toBe('unknown')
  })

  it('charges a refusal or a cut-off answer for the run it was', async () => {
    setProviderForTests(scriptedProvider([scriptedMessage({ text: '', stopReason: 'refusal', usage: { input_tokens: 1000, output_tokens: 100 } })]))
    await generate({ purpose: 'brain.classify', messages: [user('x')] }).catch(() => {})
    expect(period('total')!.settled).toBeCloseTo(OK_COST, 6)
  })

  it('reserves no more than the worst case, and at least what the call cost', async () => {
    setProviderForTests(scriptedProvider([ok()]))
    await generate({ purpose: 'brain.classify', messages: [user('x')] })
    const hold = [...ledger.holds.values()][0]
    // Output ceiling for brain.classify is 1,024 tokens: $0.0256 of output alone.
    expect(hold.amountUsd).toBeGreaterThanOrEqual(1024 * 25 / 1e6)
    expect(hold.amountUsd).toBeGreaterThan(OK_COST)
  })
})

describe('limits', () => {
  it('refuses before sending once the monthly hard limit would be passed', async () => {
    process.env.AI_TOTAL_MONTHLY_HARD_LIMIT_USD = '0.01'
    const provider = scriptedProvider([ok()])
    setProviderForTests(provider)
    const e = await generate({ purpose: 'brain.classify', messages: [user('x')] }).catch((x) => x)
    expect(e).toBeInstanceOf(AiError)
    expect(e).toMatchObject({ kind: 'spend_limit', consumption: 'none' })
    expect(provider.calls).toHaveLength(0)
  })

  it('holds concurrent calls to the limit', async () => {
    // Each reservation is the classify worst case (~$0.026); room for exactly three.
    process.env.AI_TOTAL_MONTHLY_HARD_LIMIT_USD = '0.1'
    setProviderForTests(scriptedProvider(Array.from({ length: 10 }, () => ok())))
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => generate({ purpose: 'brain.classify', messages: [user('x')] })),
    )
    const refused = results.filter((r) => r.status === 'rejected')
    expect(results.length - refused.length).toBeGreaterThan(0)
    expect(refused.length).toBeGreaterThan(0)
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toMatchObject({ kind: 'spend_limit' })
    const p = period('total')!
    expect(p.reserved + p.settled + p.unknown).toBeLessThanOrEqual(0.1)
  })

  it('stops the deployment-paid budget without touching customer calls', async () => {
    process.env.AI_PLATFORM_MONTHLY_BUDGET_USD = '0'
    setProviderForTests(scriptedProvider([ok()]))
    const e = await generate({ purpose: 'autonomy.investigate', messages: [user('x')] }).catch((x) => x)
    expect(e).toMatchObject({ kind: 'spend_limit' })
    expect((await generate({ purpose: 'brain.classify', messages: [user('x')] })).text).toBe('fine')
  })

  it('does not send when the reservation cannot be written', async () => {
    const provider = scriptedProvider([ok()])
    setProviderForTests(provider)
    setSpendLedgerForTests({
      reserve: async () => {
        throw new AiError('spend_unavailable', 'db down', { consumption: 'none' })
      },
      settle: async () => {},
      expire: async () => 0,
    })
    const e = await generate({ purpose: 'brain.classify', messages: [user('x')] }).catch((x) => x)
    expect(e).toMatchObject({ kind: 'spend_unavailable' })
    expect(provider.calls).toHaveLength(0)
  })

  it('books a reservation nobody settled as unknown once it expires', async () => {
    const hold = await ledger.reserve(
      { purpose: 'brain.agent', model: 'claude-opus-4-6', payer: 'customer', amountUsd: 0.5, expiresInMs: 1000 },
      { totalUsd: null, platformUsd: null },
      new Date(),
    )
    expect(await ledger.expire(new Date(Date.now() + 2000))).toBe(1)
    expect(ledger.holds.get(hold.id)!.status).toBe('unknown')
    expect(period('total')).toEqual({ reserved: 0, settled: 0, unknown: 0.5 })
  })
})

describe('customer billing hook', () => {
  function hook(over: Partial<CustomerSpendHook> = {}) {
    const calls: { reserve: unknown[]; settle: unknown[] } = { reserve: [], settle: [] }
    const h: CustomerSpendHook = {
      reserve: async (input) => {
        calls.reserve.push(input)
        return { id: 'cust_1' }
      },
      settle: async (id, input) => {
        calls.settle.push({ id, ...input })
      },
      ...over,
    }
    setCustomerSpendHook(h)
    return calls
  }

  it('holds the worst case against the account and charges what ran', async () => {
    const calls = hook()
    setProviderForTests(scriptedProvider([ok()]))
    await generate({ purpose: 'brain.agent', messages: [user('x')], billing: { billingAccountId: 'acct_1' } })
    expect(calls.reserve[0]).toMatchObject({ billingAccountId: 'acct_1', purpose: 'brain.agent' })
    expect(calls.settle[0]).toMatchObject({ id: 'cust_1', outcome: 'ran', chargeUsd: expect.closeTo(OK_COST, 6) })
  })

  it('never charges a customer for a lost answer', async () => {
    const calls = hook()
    setProviderForTests(scriptedProvider([new Anthropic.APIConnectionTimeoutError()]))
    await generate({ purpose: 'brain.agent', messages: [user('x')] }).catch(() => {})
    expect(calls.settle[0]).toMatchObject({ outcome: 'unknown', chargeUsd: 0 })
  })

  it('refuses before sending when the account has no credits, and releases the reservation', async () => {
    hook({
      reserve: async () => {
        throw new AiError('credits_exhausted', 'none left', { consumption: 'none' })
      },
    })
    const provider = scriptedProvider([ok()])
    setProviderForTests(provider)
    const e = await generate({ purpose: 'brain.agent', messages: [user('x')] }).catch((x) => x)
    expect(e).toMatchObject({ kind: 'credits_exhausted' })
    expect(provider.calls).toHaveLength(0)
    expect(period('total')).toEqual({ reserved: 0, settled: 0, unknown: 0 })
  })

  it('does not involve the hook in what the deployment pays for', async () => {
    const calls = hook()
    setProviderForTests(scriptedProvider([ok()]))
    await generate({ purpose: 'autonomy.investigate', messages: [user('x')] })
    expect(calls.reserve).toHaveLength(0)
    expect(period('platform')!.settled).toBeCloseTo(OK_COST, 6)
  })
})
