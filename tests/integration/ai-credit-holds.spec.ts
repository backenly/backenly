/**
 * AI credit holds on a real Postgres. Each customer-paid call holds its worst
 * case before it is sent, keeps counting at what it used until its turn is
 * charged, and only then stops counting, so usage is never uncounted.
 *
 * Two things are stubbed, both commercial and neither the subject here:
 *   - the credit cap, because the OSS edition these tests run as is unlimited;
 *   - the charge, because OSS records none. The stand-in writes the real
 *     account_ai_usage row the way Cloud's recordAiConsumption does, and can be
 *     made to fail.
 * The hold rows, the lock, the race and every query are real.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'

let cap: number | null = 10
let chargeFails = false
jest.mock('@/lib/entitlements/policy', () => {
  const actual = jest.requireActual('@/lib/entitlements/policy')
  const { prisma: db } = jest.requireActual('@/lib/db/prisma')
  return {
    ...actual,
    aiCreditCap: jest.fn(async () => cap),
    chargeAiCredits: jest.fn(async (billingAccountId: string, tokens: number) => {
      if (chargeFails) throw new Error('ledger unavailable')
      const date = actual.thisMonth()
      await db.accountAiUsage.upsert({
        where: { billingAccountId_date: { billingAccountId, date } },
        update: { tokenCount: { increment: tokens } },
        create: { billingAccountId, date, tokenCount: tokens },
      })
    }),
  }
})

import { generate, setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setCustomerSpendHook, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { createTokenScope, runInTokenScope, type TokenScope } from '@/lib/ai/token-meter'
import { closeCreditTurn, creditHoldHook } from '@/lib/entitlements/credit-holds'
import { thisMonth } from '@/lib/entitlements/policy'

const account = `holds-${crypto.randomBytes(6).toString('hex')}`
const month = thisMonth()

/** Reserve inside a turn's scope, the way a metered route's calls do. */
const reserveIn = (scope: TokenScope | null, maxTokens: number) => {
  const go = () =>
    creditHoldHook.reserve({ purpose: 'brain.agent', model: 'test', maxUsd: 0, maxTokens, expiresInMs: 300_000, billingAccountId: account })
  return scope ? runInTokenScope(scope, go) : go()
}
const ran = (id: string, tokens: number) => creditHoldHook.settle(id, { chargeUsd: 0.01, tokens, outcome: 'ran' })
const hold = (id: string) => prisma.aiCreditHold.findUniqueOrThrow({ where: { id } })
const charged = async () =>
  (await prisma.accountAiUsage.findUnique({ where: { billingAccountId_date: { billingAccountId: account, date: month } } }))?.tokenCount ?? 0

beforeEach(async () => {
  cap = 10 // 10 credits = 10,000 tokens
  chargeFails = false
  await prisma.aiCreditHold.deleteMany({ where: { billingAccountId: account } })
  await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: account } })
})

afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
  setCustomerSpendHook(undefined)
})

afterAll(async () => {
  await prisma.aiCreditHold.deleteMany({ where: { billingAccountId: account } })
  await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: account } })
})

describe('AI credit holds', () => {
  it('holds a call that fits and refuses one that does not, unsent', async () => {
    const a = await reserveIn(createTokenScope(), 6_000)
    expect((await hold(a.id)).status).toBe('reserved')
    await expect(reserveIn(createTokenScope(), 6_000)).rejects.toMatchObject({ kind: 'credits_exhausted', consumption: 'none' })
  })

  it('lets exactly one of two racing calls take the last credits', async () => {
    const results = await Promise.allSettled([reserveIn(createTokenScope(), 6_000), reserveIn(createTokenScope(), 6_000)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await prisma.aiCreditHold.count({ where: { billingAccountId: account } })).toBe(1)
  })

  it('keeps a finished call counted until its turn is charged, so no second call slips into the gap', async () => {
    // The review's case: 10 credits, a 6-credit call finishes, and before its
    // turn is charged another 6-credit call asks.
    const turnA = createTokenScope()
    const a = await reserveIn(turnA, 6_000)
    await ran(a.id, 5_000)
    expect(await hold(a.id)).toMatchObject({ status: 'used', usedTokens: 5_000 })
    await expect(reserveIn(createTokenScope(), 6_000)).rejects.toMatchObject({ kind: 'credits_exhausted' })

    // Charged, then closed: the usage moves from the hold to the charged total.
    await closeCreditTurn(account, turnA, 5_000)
    expect(await charged()).toBe(5_000)
    expect((await hold(a.id)).status).toBe('charged')
    await expect(reserveIn(createTokenScope(), 6_000)).rejects.toMatchObject({ kind: 'credits_exhausted' })
    await expect(reserveIn(createTokenScope(), 5_000)).resolves.toMatchObject({ id: expect.any(String) })
  })

  it('releases a turn that is charged nothing, and charges nothing', async () => {
    const turn = createTokenScope()
    const a = await reserveIn(turn, 6_000)
    await ran(a.id, 4_000)
    await closeCreditTurn(account, turn, 0)
    expect((await hold(a.id)).status).toBe('released')
    expect(await charged()).toBe(0)
  })

  it('ignores a settlement that arrives after its turn closed', async () => {
    const turn = createTokenScope()
    const a = await reserveIn(turn, 6_000)
    await ran(a.id, 3_000)
    await closeCreditTurn(account, turn, 3_000)
    await ran(a.id, 9_999)
    await creditHoldHook.settle(a.id, { chargeUsd: 0, tokens: 0, outcome: 'none' })
    expect(await hold(a.id)).toMatchObject({ status: 'charged', usedTokens: 3_000 })
  })

  it('expires each hold on its own, so a busy account never keeps a stranded one alive', async () => {
    // A crash left a hold; a later call is live.
    await prisma.aiCreditHold.create({
      data: { billingAccountId: account, month, tokens: 9_000, status: 'reserved', turnScoped: true, expiresAt: new Date(Date.now() - 1_000) },
    })
    await expect(reserveIn(createTokenScope(), 6_000)).resolves.toMatchObject({ id: expect.any(String) })
    // The live hold counts; the stranded one does not.
    await expect(reserveIn(createTokenScope(), 6_000)).rejects.toMatchObject({ kind: 'credits_exhausted' })
  })

  it('stops counting a used hold whose turn never closed once it expires', async () => {
    const a = await reserveIn(createTokenScope(), 6_000)
    await ran(a.id, 6_000)
    await prisma.aiCreditHold.update({ where: { id: a.id }, data: { expiresAt: new Date(Date.now() - 1_000) } })
    await expect(reserveIn(createTokenScope(), 6_000)).resolves.toMatchObject({ id: expect.any(String) })
  })

  it.each(['none', 'unknown'] as const)('releases a call whose outcome is %s, and the customer is charged nothing', async (outcome) => {
    const turn = createTokenScope()
    const a = await reserveIn(turn, 6_000)
    await creditHoldHook.settle(a.id, { chargeUsd: 0, tokens: 0, outcome })
    expect((await hold(a.id)).status).toBe('released')
    await closeCreditTurn(account, turn, 0)
    expect(await charged()).toBe(0)
  })

  it('releases a call made outside any turn when it settles, since nothing will charge it', async () => {
    const a = await reserveIn(null, 6_000)
    await ran(a.id, 6_000)
    expect((await hold(a.id)).status).toBe('released')
  })

  it('keeps the holds counted when the charge fails, so a billing fault never frees credits', async () => {
    const turn = createTokenScope()
    const a = await reserveIn(turn, 6_000)
    await ran(a.id, 6_000)
    chargeFails = true
    await closeCreditTurn(account, turn, 6_000)
    expect((await hold(a.id)).status).toBe('used')
    await expect(reserveIn(createTokenScope(), 6_000)).rejects.toMatchObject({ kind: 'credits_exhausted' })
  })

  it('holds nothing where there is nothing to enforce', async () => {
    cap = null
    await expect(reserveIn(createTokenScope(), 1_000_000)).resolves.toEqual({ id: 'none' })
    expect(await prisma.aiCreditHold.count({ where: { billingAccountId: account } })).toBe(0)
  })

  it('is the gateway’s default for customer-paid calls: held in flight, used after, charged at the turn’s end', async () => {
    setSpendLedgerForTests(memorySpendLedger())
    const turn = createTokenScope()
    const provider = scriptedProvider([
      async () => {
        expect(await prisma.aiCreditHold.findFirstOrThrow({ where: { billingAccountId: account } })).toMatchObject({ status: 'reserved' })
        return scriptedMessage({ text: 'ok', usage: { input_tokens: 10, output_tokens: 5 } })
      },
    ])
    setProviderForTests(provider)
    await runInTokenScope(turn, () =>
      generate({ purpose: 'brain.answer', messages: [{ role: 'user', content: 'hi' }], billing: { billingAccountId: account } }),
    )
    expect(turn.holds).toHaveLength(1)
    expect(await hold(turn.holds[0])).toMatchObject({ status: 'used', usedTokens: 15 })
    await closeCreditTurn(account, turn, turn.tokens)
    expect(await charged()).toBe(turn.tokens)
    expect((await hold(turn.holds[0])).status).toBe('charged')
  })

  it('never holds or charges customer credits for autonomy, which the platform pays for', async () => {
    // Autonomous healing is included in every plan: an investigation runs on
    // the deployment's own budget even when it names the customer's account.
    cap = 0
    setSpendLedgerForTests(memorySpendLedger())
    const turn = createTokenScope()
    setProviderForTests(scriptedProvider([scriptedMessage({ text: 'ok', usage: { input_tokens: 10, output_tokens: 5 } })]))
    await runInTokenScope(turn, () =>
      generate({ purpose: 'autonomy.investigate', messages: [{ role: 'user', content: 'why' }], billing: { billingAccountId: account } }),
    )
    expect(turn.holds).toHaveLength(0)
    expect(await prisma.aiCreditHold.count({ where: { billingAccountId: account } })).toBe(0)
    expect(await charged()).toBe(0)
  })

  it('refuses a customer-paid call before it is sent when its worst case does not fit', async () => {
    cap = 1 // 1,000 tokens, less than brain.answer's output ceiling
    setSpendLedgerForTests(memorySpendLedger())
    const provider = scriptedProvider([scriptedMessage({ text: 'never sent' })])
    setProviderForTests(provider)
    await expect(
      generate({ purpose: 'brain.answer', messages: [{ role: 'user', content: 'hi' }], billing: { billingAccountId: account } }),
    ).rejects.toMatchObject({ kind: 'credits_exhausted' })
    expect(provider.calls).toHaveLength(0)
  })
})

describe('a turn that names who pays', () => {
  // A route that charges a turn names its account on the meter, so a model
  // call deep inside a tool is gated and charged without passing `billing`
  // itself. Before, such a call held nothing and was charged by nobody.

  it('holds a call that names no account against the account its turn names', async () => {
    cap = 100 // room for functions.generate's worst case
    setSpendLedgerForTests(memorySpendLedger())
    const turn = createTokenScope({ billingAccountId: account })
    setProviderForTests(scriptedProvider([scriptedMessage({ text: 'ok', usage: { input_tokens: 0, output_tokens: 40 } })]))
    await runInTokenScope(turn, () => generate({ purpose: 'functions.generate', messages: [{ role: 'user', content: 'write it' }] }))
    expect(turn.holds).toHaveLength(1)
    expect(await hold(turn.holds[0])).toMatchObject({ billingAccountId: account, status: 'used', usedTokens: 40 })
    expect(turn.tokens).toBe(40)
  })

  it('refuses such a call, unsent, when the turn’s account has no credits left', async () => {
    cap = 0
    setSpendLedgerForTests(memorySpendLedger())
    const provider = scriptedProvider([scriptedMessage({ text: 'never sent' })])
    setProviderForTests(provider)
    const turn = createTokenScope({ billingAccountId: account })
    await expect(
      runInTokenScope(turn, () => generate({ purpose: 'functions.generate', messages: [{ role: 'user', content: 'write it' }] })),
    ).rejects.toMatchObject({ kind: 'credits_exhausted' })
    expect(provider.calls).toHaveLength(0)
  })

  it('never counts a platform-paid call toward the turn’s charge', async () => {
    cap = 0
    setSpendLedgerForTests(memorySpendLedger())
    const turn = createTokenScope({ billingAccountId: account })
    setProviderForTests(scriptedProvider([scriptedMessage({ text: 'ok', usage: { input_tokens: 10, output_tokens: 5 } })]))
    await runInTokenScope(turn, () => generate({ purpose: 'autonomy.investigate', messages: [{ role: 'user', content: 'why' }] }))
    expect(turn.holds).toHaveLength(0)
    expect(turn.tokens).toBe(0)
    expect(await prisma.aiCreditHold.count({ where: { billingAccountId: account } })).toBe(0)
  })

  it('holds nothing for a call made after the turn ended, as background healing is', async () => {
    cap = 0
    setSpendLedgerForTests(memorySpendLedger())
    const provider = scriptedProvider([scriptedMessage({ text: 'ok', usage: { input_tokens: 0, output_tokens: 5 } })])
    setProviderForTests(provider)
    const turn = createTokenScope({ billingAccountId: account })
    let later: Promise<unknown> | undefined
    await runInTokenScope(turn, async () => {
      // Set going inside the turn, run after it: the reconciler's self-heal shape.
      later = new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
        generate({ purpose: 'functions.generate', messages: [{ role: 'user', content: 'fix it' }] }),
      )
    })
    await later
    expect(provider.calls).toHaveLength(1)
    expect(turn.holds).toHaveLength(0)
    expect(await prisma.aiCreditHold.count({ where: { billingAccountId: account } })).toBe(0)
  })
})
