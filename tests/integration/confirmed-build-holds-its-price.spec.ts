/**
 * A confirmed build holds its price before it runs (production QA 2026-11-09,
 * report 98: "514 of 200" AI credits on Free, which is sold as "Hard caps,
 * never billed").
 *
 * A plan's run is charged when it ends: the architect's tokens, which the
 * proposal deferred so that proposing stays free, plus a fixed price per step.
 * Every model call a turn makes is held against the account's credits before
 * it is sent, but that price never was. So "go ahead" with fewer credits left
 * than the build costs ran the whole build and charged past the cap.
 *
 * Real: the brain, the executor, the workspace tables, the hold rows and their
 * lock, and backend_chat's run (executeRun) with its charge. Stubbed: the
 * credit cap and the charge's ledger write (commercial, and OSS has neither;
 * the stand-in writes account_ai_usage the way Cloud does), the post-build fix
 * loop (it needs a live runtime), and the call log.
 */

let cap: number | null = 10
jest.mock('@/lib/entitlements/policy', () => {
  const actual = jest.requireActual('@/lib/entitlements/policy')
  const { prisma: db } = jest.requireActual('@/lib/db/prisma')
  return {
    ...actual,
    aiCreditCap: jest.fn(async () => cap),
    chargeAiCredits: jest.fn(async (billingAccountId: string, tokens: number) => {
      const date = actual.thisMonth()
      await db.accountAiUsage.upsert({
        where: { billingAccountId_date: { billingAccountId, date } },
        update: { tokenCount: { increment: tokens } },
        create: { billingAccountId, date, tokenCount: tokens },
      })
    }),
  }
})
jest.mock('@/lib/ai/agentic-fix-loop', () => ({ runAgenticFixLoop: jest.fn() }))
jest.mock('@/lib/ai/blueprints', () => ({ ...jest.requireActual('@/lib/ai/blueprints'), getBlueprintForPrompt: jest.fn() }))
jest.mock('@/lib/mcp/guard', () => ({ ...jest.requireActual('@/lib/mcp/guard'), recordMcpCall: jest.fn() }))

import { prisma } from '@/lib/db/prisma'
import { generate, setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { createTokenScope, runInTokenScope } from '@/lib/ai/token-meter'
import { runAgenticFixLoop } from '@/lib/ai/agentic-fix-loop'
import { getBlueprintForPrompt } from '@/lib/ai/blueprints'
import type { Blueprint, BlueprintStep } from '@/lib/ai/blueprints/types'
import { loadPendingPlan, loadResumeQueue, savePendingPlan, saveResumeQueue } from '@/lib/ai/blueprints/store'
import { loadLoopResume, saveLoopResume } from '@/lib/ai/brain/loop-resume'
import { thisMonth } from '@/lib/entitlements/policy'
import { executeRun } from '@/lib/mcp/chat-turn'
import { classified, setUpBrainProject } from '../helpers/brain-harness'

const fixLoop = runAgenticFixLoop as jest.MockedFunction<typeof runAgenticFixLoop>
const architect = getBlueprintForPrompt as jest.MockedFunction<typeof getBlueprintForPrompt>

const brain = setUpBrainProject({ name: 'confirmed-build-price' })
const month = thisMonth()

const match = { domain: 'price-test', confidence: 0.85, matchedOn: 'llm-architect' }
const plan = (steps: BlueprintStep[]): Blueprint => ({ domain: 'price-test', title: 'Price test', summary: 'A plan.', steps })
const notes: BlueprintStep = { label: 'Create notes', tool: 'create_table', args: { tableName: 'notes', columns: [{ name: 'title', type: 'text' }] } }
/** The architect's tokens a proposal deferred to the run: 50 credits. */
const ARCHITECT = 50_000
/** A create_table step's price (STEP_TOKEN_COST in lib/ai/brain/agent.ts). */
const CREATE_TABLE = 900

/** The project has no organization, so its owner's account pays. */
const account = () => brain.ownerId
const charged = async () =>
  (await prisma.accountAiUsage.findUnique({ where: { billingAccountId_date: { billingAccountId: account(), date: month } } }))?.tokenCount ?? 0
/** Credits already charged this month, as earlier turns leave them. */
const alreadySpent = (tokens: number) => prisma.accountAiUsage.create({ data: { billingAccountId: account(), date: month, tokenCount: tokens } })
const stillCounting = () =>
  prisma.aiCreditHold.count({ where: { billingAccountId: account(), status: { in: ['reserved', 'used'] } } })

/** One backend_chat run, as the route starts it. */
const say = (message: string, intent = 'CONFIRM') => {
  setProviderForTests(scriptedProvider([classified(intent)]))
  return executeRun(null, {
    caller: { keyId: 'test-key', projectId: brain.projectId, userId: brain.ownerId },
    message,
    creditAccount: account(),
    startedAt: Date.now(),
  })
}

beforeEach(async () => {
  cap = 10
  fixLoop.mockReset()
  fixLoop.mockRejectedValue(new Error('no live runtime in tests'))
  architect.mockReset()
  await prisma.aiCreditHold.deleteMany({ where: { billingAccountId: account() } })
  await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: account() } })
})

afterAll(async () => {
  await prisma.aiCreditHold.deleteMany({ where: { billingAccountId: account() } })
  await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: account() } })
})

describe('a confirmed build', () => {
  it('does not run when its price is more than the credits left, and charges nothing', async () => {
    await alreadySpent(2_000) // 8 of 10 credits left; the build costs 51
    await savePendingPlan(brain.projectId, plan([notes]), match, ARCHITECT)

    const { body } = await say('go ahead')

    expect(await brain.tableExists('notes')).toBe(false)
    expect(await charged()).toBe(2_000)
    expect(body).toMatchObject({ ok: false, code: 'AI_CREDITS_EXHAUSTED', retryable: false })
    expect(body.summary).toContain('Nothing was built: this plan needs up to 51 AI credits, and this account has 8 left this month.')
    // Kept, so "go ahead" runs it once there are credits for it.
    expect(await loadPendingPlan(brain.projectId)).not.toBeNull()
    expect(await stillCounting()).toBe(0)
  }, 60_000)

  it('runs when its price fits, and is charged that price', async () => {
    cap = 100
    await alreadySpent(2_000)
    await savePendingPlan(brain.projectId, plan([notes]), match, ARCHITECT)

    const { body } = await say('go ahead')

    expect(await brain.tableExists('notes')).toBe(true)
    expect(body).toMatchObject({ ok: true })
    expect(await charged()).toBe(2_000 + ARCHITECT + CREATE_TABLE)
    expect(await stillCounting()).toBe(0)
  }, 60_000)

  it('keeps the last credits for itself while it runs: its own model calls go on, another turn’s are refused', async () => {
    cap = 53
    await alreadySpent(2_100) // 50,900 tokens left: exactly this build's price
    await savePendingPlan(brain.projectId, plan([notes]), match, ARCHITECT)
    const call = () => generate({ purpose: 'brain.answer', messages: [{ role: 'user', content: 'hi' }], billing: { projectId: brain.projectId } })
    const seen: Record<string, string> = {}
    fixLoop.mockImplementationOnce(async () => {
      // The post-build check runs inside the build, and its model calls are part of what the build's price pays for.
      setProviderForTests(scriptedProvider([scriptedMessage({ text: 'ok' }), scriptedMessage({ text: 'ok' })]))
      seen.own = await call().then(() => 'sent', (e) => e.kind)
      seen.other = await runInTokenScope(createTokenScope(), call).then(() => 'sent', (e) => e.kind)
      throw new Error('no live runtime in tests')
    })

    const { body } = await say('go ahead')

    expect(seen).toEqual({ own: 'sent', other: 'credits_exhausted' })
    expect(body).toMatchObject({ ok: true })
    expect(await charged()).toBe(53_000)
    expect(await stillCounting()).toBe(0)
  }, 60_000)

  it('holds a resumed run’s price the same way, and keeps what is left to run', async () => {
    await alreadySpent(9_000) // 1 credit left; the two steps cost 1,800 tokens
    const tags: BlueprintStep = { ...notes, label: 'Create tags', args: { tableName: 'tags', columns: [{ name: 'name', type: 'text' }] } }
    await saveResumeQueue(brain.projectId, 'price-test', [notes, tags], 'Two steps did not start before the time ran out.')

    const { body } = await say('continue')

    expect(await brain.tableExists('notes')).toBe(false)
    expect(await charged()).toBe(9_000)
    expect(body).toMatchObject({ ok: false, code: 'AI_CREDITS_EXHAUSTED' })
    expect(body.summary).toContain('Nothing was built: the remaining steps need up to 2 AI credits, and this account has 1 left this month.')
    expect(await loadResumeQueue(brain.projectId)).not.toBeNull()
  }, 60_000)

  it('keeps the resume point when a "continue" designs the request again and its price cannot be held', async () => {
    await alreadySpent(2_000) // 8 of 10 credits left; the plan costs 51
    await saveLoopResume(brain.projectId, 'a notes app', [], 'step_budget', true)
    architect.mockResolvedValueOnce({ blueprint: plan([notes]), match, architectTokens: ARCHITECT })

    const { body } = await say('continue')

    expect(await brain.tableExists('notes')).toBe(false)
    expect(await charged()).toBe(2_000)
    expect(body).toMatchObject({ ok: false, code: 'AI_CREDITS_EXHAUSTED' })
    // Nothing ran, so "continue" designs it again once there are credits for it.
    expect(await loadLoopResume(brain.projectId)).toMatchObject({ request: 'a notes app', architectFailed: true })
  }, 60_000)
})

describe('the proposal', () => {
  it('says what running it costs, where credits are counted', async () => {
    architect.mockResolvedValueOnce({ blueprint: plan([notes]), match, architectTokens: ARCHITECT })

    const { body } = await say('a notes app', 'BUILD')

    expect(body.summary).toContain('Running it uses up to 51 AI credits.\nReply "go ahead" to run this')
    // Proposing is free: the architect's tokens wait for "go ahead".
    expect(await charged()).toBe(0)
  }, 60_000)

  it('says nothing about credits where none are counted', async () => {
    cap = null
    architect.mockResolvedValueOnce({ blueprint: plan([notes]), match, architectTokens: ARCHITECT })

    const { body } = await say('a notes app', 'BUILD')

    expect(body.summary).toContain('Reply "go ahead" to run this')
    expect(body.summary).not.toContain('AI credit')
  }, 60_000)
})
