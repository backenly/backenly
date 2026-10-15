/**
 * Model spend on the MCP tool route is gated and charged wherever it happens
 * (medium findings FN-12, FN-19, INT-15).
 *
 * The route gated and charged only the tools on a hand-kept list
 * (MODEL_BACKED_TOOLS: answer_question, generate_function). Others reach
 * Backenly's model too: functions.schedule writes its job's code with it, and
 * integrations.connect wires functions the same way. Neither was refused when
 * the month's credits were spent, and neither was ever charged. A typed call
 * that failed could also be handed to a model that picked a different action
 * and ran it, also uncharged.
 *
 * Now the route's token scope names the project, so every customer-paid model
 * call made inside any tool holds the account's credits before it is sent and
 * is charged after. The list only gives tools that are model work from their
 * first step an early, structured 402. A typed call that fails is reported as
 * it failed.
 *
 * Through the real /api/mcp/tool route with a real MCP key, against Postgres.
 * Stubbed, all at the edges: the model provider (a scripted one, so every
 * call's token usage is exact), the credit cap and the charge (the OSS edition
 * has no cap and records no charge; the stand-in writes the real
 * account_ai_usage row as Cloud does, as ai-credit-holds.spec.ts does), the
 * deployment's own monthly USD limits (an in-memory ledger), and the live
 * provider probe for a connected key. The gateway, the credit holds, the
 * executor, the vault and every row are real.
 */

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'

let cap: number | null = 1000
jest.mock('@/lib/entitlements/policy', () => {
  const actual = jest.requireActual('@/lib/entitlements/policy')
  const { prisma: db } = jest.requireActual('@/lib/db/prisma')
  const used = async (billingAccountId: string) =>
    Number(
      (await db.accountAiUsage.findUnique({
        where: { billingAccountId_date: { billingAccountId, date: actual.thisMonth() } },
      }))?.tokenCount ?? 0,
    )
  return {
    ...actual,
    aiCreditCap: jest.fn(async () => cap),
    enforceAiCredits: jest.fn(async (billingAccountId: string) =>
      cap !== null && actual.creditsFromTokens(await used(billingAccountId)) >= cap
        ? actual.violation('SANDBOX', 'This month’s AI credits are spent.')
        : true,
    ),
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

jest.mock('@/lib/integrations/key-verification', () => {
  const actual = jest.requireActual('@/lib/integrations/key-verification')
  return {
    ...actual,
    verifyIntegrationKey: jest.fn(async () => ({
      status: 'verified',
      detail: 'Stubbed in CI: the live provider probe is the one seam this suite does not run.',
    })),
  }
})

import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { createProvisionedProject } from '@/lib/projects/provision'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider, type ScriptStep, type ScriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { thisMonth } from '@/lib/entitlements/policy'
import { creditAccountOf } from '@/lib/usage/account'
import { POST } from '@/app/api/mcp/tool/route'

const KEY = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

let ownerId: string
let projectId: string
let schema: string
let account: string

async function call(tool: string, args: Record<string, unknown>) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: (await res.json()) as any }
}

/** A model reply with exact usage: no prompt tokens, so its credit weight is its output. */
const reply = (text: string, outputTokens: number) =>
  scriptedMessage({ text, usage: { input_tokens: 0, output_tokens: outputTokens } })

function script(steps: ScriptStep[]): ScriptedProvider {
  const provider = scriptedProvider(steps)
  setProviderForTests(provider)
  return provider
}

const charged = async () =>
  Number(
    (await prisma.accountAiUsage.findUnique({
      where: { billingAccountId_date: { billingAccountId: account, date: thisMonth() } },
    }))?.tokenCount ?? 0,
  )

/** The route charges after it answers, so wait for the charge to land. */
async function chargeLands(expected: number): Promise<number> {
  const until = Date.now() + 10_000
  let now = await charged()
  while (now !== expected && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100))
    now = await charged()
  }
  return now
}

/** Give a charge that should never come the time one would take to land. */
const settle = () => new Promise((r) => setTimeout(r, 1_000))

const holds = () => prisma.aiCreditHold.findMany({ where: { billingAccountId: account }, select: { status: true } })

const CRON_BODY = [
  "const stale = await ctx.db.query('sessions', { expired: true }, { limit: 1000 })",
  "for (const s of stale) await ctx.db.delete('sessions', { id: s.id })",
  'return { deleted: stale.length }',
].join('\n')

const SANDBOX_BODY = [
  'const { prompt } = event.data || {}',
  "if (!prompt) return { error: 'prompt required' }",
  'return { reply: await ctx.integrations.openai.complete(prompt) }',
].join('\n')

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  setSpendLedgerForTests(memorySpendLedger())
  ownerId = (await prisma.user.create({
    data: { email: `spend-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'spend' },
  })).id
  const project = await createProvisionedProject({ name: 'model-spend', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: KEY.slice(0, 12), keyHash: hashApiKey(KEY), userId: ownerId, projectId,
      scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })
  const resolved = await creditAccountOf(projectId)
  if (!resolved) throw new Error('test: the project has no billing account')
  account = resolved
}, 120_000)

beforeEach(async () => {
  cap = 1000
  await prisma.aiCreditHold.deleteMany({ where: { billingAccountId: account } })
  await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: account } })
})

afterAll(async () => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
  await prisma.aiCreditHold.deleteMany({ where: { billingAccountId: account } }).catch(() => {})
  await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: account } }).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.projectIntegrationKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('FN-12: functions.schedule is model work, gated and charged', () => {
  it('is refused before anything runs when the month’s credits are spent', async () => {
    cap = 0
    const provider = script([])
    const r = await call('functions', { action: 'schedule', description: 'delete expired sessions', schedule: 'every day at 3am' })
    expect(r.status).toBe(402)
    expect(r.body).toMatchObject({ ok: false, code: 'AI_CREDITS_EXHAUSTED' })
    expect(provider.calls).toHaveLength(0)
    expect(await prisma.aiFunction.count({ where: { projectId, triggerType: 'cron' } })).toBe(0)
  }, 60_000)

  it('holds credits for each model call and is charged exactly what they used', async () => {
    const provider = script([reply(CRON_BODY, 300), reply('delete_expired_sessions', 7)])
    const r = await call('functions', { action: 'schedule', description: 'delete expired sessions', schedule: 'every day at 3am' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(provider.calls).toHaveLength(2)
    expect(await prisma.aiFunction.count({ where: { projectId, triggerType: 'cron' } })).toBe(1)
    expect(await chargeLands(307)).toBe(307)
    const rows = await holds()
    expect(rows).toHaveLength(2)
    expect(rows.every((h) => h.status === 'charged')).toBe(true)
  }, 60_000)
})

describe('FN-19, INT-15: integrations.connect wires functions with the same model', () => {
  it('with no credits left it stores the key, wires nothing, and says what it could not wire and why', async () => {
    cap = 0
    const provider = script([])
    const r = await call('integrations', {
      action: 'connect', integrationId: 'openai', apiKey: 'sk-' + crypto.randomBytes(24).toString('hex'),
    })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(provider.calls).toHaveLength(0)
    expect(r.body.data.autoWired).toEqual([])
    expect(r.body.data.notWired).toEqual([
      expect.stringContaining('`openai-chat`'),
      expect.stringContaining('`openai-embed`'),
    ])
    for (const line of r.body.data.notWired) expect(line).toMatch(/AI credits/)
    expect(r.body.summary).toContain('Not wired')
    expect(await prisma.projectIntegrationKey.count({ where: { projectId, integrationId: 'openai' } })).toBe(1)
    expect(await prisma.aiFunction.count({ where: { projectId, name: { in: ['openai-chat', 'openai-embed'] } } })).toBe(0)
    await settle()
    expect(await charged()).toBe(0)
    expect(await holds()).toHaveLength(0)
  }, 60_000)

  it('with credits, every call that wires a function is held and charged', async () => {
    const provider = script([
      reply(SANDBOX_BODY, 200), reply('openai_chat', 5),
      reply(SANDBOX_BODY, 200), reply('openai_embed', 5),
    ])
    const r = await call('integrations', {
      action: 'connect', integrationId: 'openai', apiKey: 'sk-' + crypto.randomBytes(24).toString('hex'),
    })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(provider.calls).toHaveLength(4)
    expect(r.body.data.autoWired).toHaveLength(2)
    expect(r.body.data.notWired).toEqual([])
    expect(await prisma.aiFunction.count({ where: { projectId, name: { in: ['openai-chat', 'openai-embed'] } } })).toBe(2)
    expect(await chargeLands(410)).toBe(410)
    const rows = await holds()
    expect(rows).toHaveLength(4)
    expect(rows.every((h) => h.status === 'charged')).toBe(true)
  }, 60_000)
})

describe('a typed call is never handed to a model for a different action', () => {
  it('a failed call is reported as it failed: no model is asked, nothing else runs, nothing is charged', async () => {
    // Before, the executor asked a model to "replan" the failure and ran
    // whatever action came back, here a bucket nobody asked for.
    const provider = script([reply(JSON.stringify({ action: 'CREATE_BUCKET', params: { bucketName: 'replanned-bucket' } }), 20)])
    const r = await call('storage', { action: 'list_files', bucketName: 'no-such-bucket' })
    expect(r.status).toBe(400)
    expect(r.body.ok).toBe(false)
    expect(r.body.error).toMatch(/no-such-bucket/)
    expect(provider.calls).toHaveLength(0)
    expect(await prisma.storageBucket.count({ where: { projectId, name: 'replanned-bucket' } })).toBe(0)
    await settle()
    expect(await charged()).toBe(0)
  }, 60_000)
})
