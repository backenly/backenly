/**
 * FUNCTION SELF-HEAL IS BACKENLY'S OWN WORK, AND THE PLATFORM PAYS FOR IT
 * =======================================================================
 * When a function Backenly wrote fails, the self-heal asks the model for a fix
 * (lib/services/ai-functions/executor.ts): straight after a failed run, and in
 * the observer's pass over functions left in error. That is healing a backend,
 * like the autonomy investigator's work, and lib/ai/token-meter.ts says what
 * follows: healing is never billed to a customer's credits, and must not be
 * refused for them.
 *
 * Its model calls were customer-paid by default (purpose functions.generate),
 * so that held only while no metered request was open where the heal ran. A
 * heal running inside one, such as a direct MCP tool call, which meters the
 * project, held the account's credits, added its tokens to that call's charge,
 * and was refused once the credits were used up, leaving the function in
 * error. Its spend was never counted against the platform's own budget
 * (production QA re-test, 2026-11-16, #98).
 *
 * A scripted provider stands in for the model. The gateway and its spend
 * rules, the fixers, the function runner and the database are real. The
 * customer's credit hold is a recording stand-in, through the seam
 * lib/ai/llm/spend.ts provides for it.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { setProviderForTests } from '@/lib/ai/llm'
import { AiError } from '@/lib/ai/llm/errors'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setCustomerSpendHook, setSpendLedgerForTests, type CustomerSpendHook } from '@/lib/ai/llm/spend'
import { createTokenScope, runInTokenScope, type TokenScope } from '@/lib/ai/token-meter'
import { autoFixRouteModuleFunction, healErroredAiFunctions } from '@/lib/services/ai-functions/executor'
import { generateFixedFunctionCode } from '@/lib/services/ai-functions/generator'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

// A route module that passes validation and throws on every run, and its fix.
const BROKEN_MODULE = `import { NextResponse } from 'next/server'
export async function POST(req: Request) {
  throw new Error('relation "orders" does not exist')
}`
const FIXED_MODULE = `import { NextResponse } from 'next/server'
export async function POST(req: Request) {
  return NextResponse.json({ ok: true })
}`

// A sandbox body calling a method ctx.db does not have, and its fix.
const BROKEN_BODY = `const rows = await ctx.db.find('orders')\nreturn rows`
const FIXED_BODY = `const rows = await ctx.db.query('orders')\nreturn rows`

const USAGE = { input_tokens: 1200, output_tokens: 300 }

let ownerId = ''
let projectId = ''
let ledger: ReturnType<typeof memorySpendLedger>
let customerHolds: Array<{ projectId?: string; billingAccountId?: string }>

/** Records every hold the gateway asks of the customer's credits, and grants it. */
const creditsLeft: CustomerSpendHook = {
  async reserve(input) {
    customerHolds.push({ projectId: input.projectId, billingAccountId: input.billingAccountId })
    return { id: `hold-${customerHolds.length}` }
  },
  async settle() {},
}

/** Records every hold asked of the customer's credits, and refuses it, as the credit hold does at the cap. */
const creditsUsedUp: CustomerSpendHook = {
  async reserve(input) {
    customerHolds.push({ projectId: input.projectId, billingAccountId: input.billingAccountId })
    throw new AiError('credits_exhausted', 'This account has used all its AI credits this month, so this call was not sent.', {
      consumption: 'none',
    })
  },
  async settle() {},
}

/** Runs `fn` under the meter a direct MCP tool call opens around its work (app/api/mcp/tool/route.ts). */
async function inMeteredToolCall<T>(fn: () => Promise<T>): Promise<{ result: T; meter: TokenScope }> {
  const meter = createTokenScope({ projectId })
  const result = await runInTokenScope(meter, fn)
  return { result, meter }
}

/** The spend scopes each model call was booked under: the platform's own work also counts against its budget. */
const bookedUnder = () => [...ledger.holds.values()].map((h) => h.scopes)

beforeAll(() => {
  assertSafeTestDatabase()
})

beforeEach(async () => {
  ledger = memorySpendLedger()
  setSpendLedgerForTests(ledger)
  customerHolds = []
  ownerId = (
    await prisma.user.create({
      data: { email: `self-heal-pay-${randomUUID()}@test.invalid`, name: 'Self-heal payment test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `self-heal-pay-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id
})

afterEach(async () => {
  setProviderForTests(null)
  setCustomerSpendHook(undefined)
  setSpendLedgerForTests(null)
  await prisma.aiFunctionLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('a self-heal is paid for by the platform', () => {
  it("heals a route module inside a metered tool call without holding the customer's credits or adding to the call's charge", async () => {
    const provider = scriptedProvider([scriptedMessage({ text: FIXED_MODULE, usage: USAGE })])
    setProviderForTests(provider)
    setCustomerSpendHook(creditsLeft)
    const fn = await prisma.aiFunction.create({
      data: {
        projectId,
        name: 'export-orders',
        description: 'Export the orders',
        generatedCode: BROKEN_MODULE,
        triggerType: 'http',
        triggerTable: 'POST /fn/export-orders',
        status: 'error',
        lastError: 'relation "orders" does not exist',
      },
    })

    const { result: healed, meter } = await inMeteredToolCall(() =>
      autoFixRouteModuleFunction(fn.id, projectId, 'relation "orders" does not exist', BROKEN_MODULE, fn.description, fn.triggerTable),
    )

    expect(healed).toBe(true)
    expect(provider.calls).toHaveLength(1)
    expect(await prisma.aiFunction.findUniqueOrThrow({ where: { id: fn.id } })).toMatchObject({ status: 'active', generatedCode: FIXED_MODULE })
    expect(customerHolds).toEqual([])
    expect(meter.tokens).toBe(0)
    expect(bookedUnder()).toEqual([['total', 'platform']])
  }, 60_000)

  it("heals a function left in error when the customer's credits are used up", async () => {
    const provider = scriptedProvider([scriptedMessage({ text: FIXED_BODY, usage: USAGE })])
    setProviderForTests(provider)
    setCustomerSpendHook(creditsUsedUp)
    const fn = await prisma.aiFunction.create({
      data: {
        projectId,
        name: 'tag-new-order',
        description: 'Tag each new order',
        generatedCode: BROKEN_BODY,
        triggerType: 'on_db_insert',
        triggerTable: 'orders',
        status: 'error',
        lastError: 'TypeError: ctx.db.find is not a function',
      },
    })

    // The observer's pass over functions left in error, as a tool call's
    // schema change can start it while that call is still running.
    const { result, meter } = await inMeteredToolCall(() => healErroredAiFunctions(projectId))

    expect(result).toMatchObject({ scanned: 1, regenerated: 1, failed: 0 })
    expect(await prisma.aiFunction.findUniqueOrThrow({ where: { id: fn.id } })).toMatchObject({ status: 'active', generatedCode: FIXED_BODY })
    expect(customerHolds).toEqual([])
    expect(meter.tokens).toBe(0)
    expect(bookedUnder()).toEqual([['total', 'platform']])
  }, 60_000)
})

describe('a fix the customer asks for is still theirs', () => {
  it('the repair behind the fix action and create_function holds and charges their credits as before', async () => {
    setProviderForTests(scriptedProvider([scriptedMessage({ text: FIXED_BODY, usage: USAGE })]))
    setCustomerSpendHook(creditsLeft)

    const { result: code, meter } = await inMeteredToolCall(() =>
      generateFixedFunctionCode(BROKEN_BODY, 'TypeError: ctx.db.find is not a function', 'Tag each new order', 'on_db_insert', 'orders', projectId),
    )

    expect(code).toBe(FIXED_BODY)
    expect(customerHolds).toEqual([{ projectId, billingAccountId: undefined }])
    expect(meter.tokens).toBeGreaterThan(0)
    expect(bookedUnder()).toEqual([['total']])
  }, 60_000)
})
