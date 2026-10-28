/**
 * Function management tells an agent the truth about which function it acted
 * on (medium findings FN-07, FN-08, FN-09, FN-10, FN-13 and FN-15).
 *
 * FN-07: delete_schedule matched a substring, case-insensitively, and deleted
 *        whichever cron job came first, while the approval card showed only
 *        the substring. Names now match exactly.
 * FN-08: an agent's create of a name that existed answered success with the
 *        existing function's id; a second function on an event that already
 *        had one answered "skipped duplicate" although the runtime runs both.
 * FN-09: names were normalised three ways, so a function created as
 *        send_welcome_email was NOT_FOUND as send-welcome-email and deploy_code
 *        under either form made a duplicate that fired too.
 * FN-10: an HTTP create over an existing signup hook turned it into a manual
 *        endpoint and reported a clean creation.
 * FN-13: set_active without `active` switched the function OFF.
 * FN-15: the Stripe guard refused any description with "payment" or
 *        "checkout", and told the agent to paste a secret key in the chat.
 *
 * Real function rows throughout. Only the LLM code generator is stubbed (CI
 * has no model provider); every refusal here happens before it would run.
 */
const mockGenerateFunctionCode = jest.fn(async () => ({ name: 'generated_fn', code: 'return { ok: true }' }))

jest.mock('@/lib/services/ai-functions/generator', () => ({
  ...jest.requireActual('@/lib/services/ai-functions/generator'),
  generateFunctionCode: (...args: unknown[]) => (mockGenerateFunctionCode as any)(...args),
  generateFixedFunctionCode: async () => null,
}))

import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { TOOL_TO_ACTION } from '@/lib/ai/brain/tools'
import { deployFunctionCode, getFunction } from '@/lib/services/ai-functions/agent-actions'
import { executeGenerateFunction } from '@/lib/ai/function-generator'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

// The scratch database holds many projects, so access is decided by the cloud
// resolver, as the other suites that call agent-actions do.
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

let ownerId: string
let projectId: string

const act = (action: string, params: Record<string, unknown>) =>
  executeAction({ action, params } as any, projectId, undefined, 0, undefined, false)
const viaTool = (tool: string, args: Record<string, unknown>) =>
  executeAction(TOOL_TO_ACTION[tool](args), projectId, undefined, 0, undefined, false)

async function seedFunction(name: string, triggerType: string, triggerTable: string | null = null, status = 'active'): Promise<string> {
  return (
    await prisma.aiFunction.create({
      data: { projectId, name, description: `${name} for the suite`, generatedCode: 'return null', triggerType, triggerTable, status },
      select: { id: true },
    })
  ).id
}

const fnNames = async () => (await prisma.aiFunction.findMany({ where: { projectId }, select: { name: true } })).map((f) => f.name).sort()

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  ownerId = (
    await prisma.user.create({
      data: {
        email: `fn-contract-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Functions Contract Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (await prisma.project.create({ data: { name: 'fn-contract', userId: ownerId }, select: { id: true } })).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "workspace_${projectId}"."orders" (id serial PRIMARY KEY, total numeric)`)
}, 60_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('FN-07: delete_schedule deletes exactly the job it names', () => {
  it('a substring deletes nothing and lists the jobs; the exact name deletes only that job', async () => {
    await seedFunction('weekly_sales_report', 'cron')
    await seedFunction('daily_inventory_report', 'cron')
    const vague = await act('DELETE_CRON_JOB', { name: 'report', confirmed: true })
    expect(vague.success).toBe(false)
    expect(vague.message).toContain('weekly_sales_report')
    expect(vague.message).toContain('daily_inventory_report')
    expect(await fnNames()).toEqual(expect.arrayContaining(['daily_inventory_report', 'weekly_sales_report']))

    const exact = await act('DELETE_CRON_JOB', { name: 'weekly_sales_report', confirmed: true })
    expect(exact.success).toBe(true)
    const left = await fnNames()
    expect(left).toContain('daily_inventory_report')
    expect(left).not.toContain('weekly_sales_report')
  }, 60_000)
})

describe('FN-08: create says what it did', () => {
  it("an agent's create of a taken name is refused before any model call", async () => {
    await seedFunction('send_receipt', 'on_db_insert', 'orders')
    mockGenerateFunctionCode.mockClear()
    const out = await viaTool('generate_function', { name: 'send_receipt', trigger: 'on_insert', table: 'orders', description: 'email a receipt' })
    expect(out.success).toBe(false)
    expect(out.error).toBe('ALREADY_EXISTS')
    expect(mockGenerateFunctionCode).not.toHaveBeenCalled()
  }, 60_000)

  it('an internal create of a taken name is an honest no-op (control for auto-wiring)', async () => {
    const out = await act('CREATE_AI_FUNCTION', { name: 'send_receipt', triggerType: 'on_db_insert', triggerTable: 'orders', description: 'email a receipt' })
    expect(out.success).toBe(true)
    expect((out.data as any).existed).toBe(true)
    expect(out.message).toContain('left unchanged')
  }, 60_000)

  it('a second function on the same event is created, and the overlap is named', async () => {
    const out = await viaTool('generate_function', { name: 'notify_slack', trigger: 'on_insert', table: 'orders', description: 'post the order to Slack' })
    expect(out.success).toBe(true)
    expect((out.data as any).alsoOnThisEvent).toEqual(['send_receipt'])
    expect(await fnNames()).toEqual(expect.arrayContaining(['notify_slack', 'send_receipt']))
  }, 60_000)
})

describe('FN-09: every form of a name finds the function', () => {
  it('deploy_code under the snake name replaces it; get and set_active find it by its kebab form', async () => {
    const id = await seedFunction('send_welcome_email', 'on_signup')
    const deployed = await deployFunctionCode(
      { userId: ownerId, projectId },
      { name: 'send_welcome_email', trigger: 'on_signup', code: 'return { sent: true }' },
    )
    expect(deployed.ok).toBe(true)
    expect((deployed.data as any)).toMatchObject({ functionId: id, created: false, name: 'send_welcome_email' })
    expect((await fnNames()).filter((n) => n.includes('welcome'))).toEqual(['send_welcome_email'])

    const got = await getFunction({ userId: ownerId, projectId }, { name: 'send-welcome-email' })
    expect(got.ok).toBe(true)
    const off = await act('TOGGLE_AI_FUNCTION', { name: 'send-welcome-email', active: false })
    expect(off.success).toBe(true)
    expect((await prisma.aiFunction.findUnique({ where: { id }, select: { status: true } }))?.status).toBe('inactive')
  }, 60_000)
})

describe('FN-10: an HTTP create never converts or silently overwrites', () => {
  it('an existing signup hook is not turned into an endpoint, by any caller', async () => {
    const id = await seedFunction('resend-welcome', 'on_signup')
    const out = await executeGenerateFunction({ functionName: 'resend-welcome', description: 'resend the welcome email', method: 'POST' }, projectId)
    expect(out.success).toBe(false)
    expect(out.error).toBe('ALREADY_EXISTS')
    expect((await prisma.aiFunction.findUnique({ where: { id }, select: { triggerType: true } }))?.triggerType).toBe('on_signup')
  }, 60_000)

  it("an agent's HTTP create of a taken route name is refused", async () => {
    await seedFunction('order-stats', 'manual', 'GET /api/v1/x/fn/order-stats')
    const out = await viaTool('generate_function', { name: 'order-stats', trigger: 'http', description: 'order stats', method: 'GET' })
    expect(out.success).toBe(false)
    expect(out.error).toBe('ALREADY_EXISTS')
  }, 60_000)
})

describe('FN-13: set_active needs to be told which way', () => {
  it('without active it is refused and the function stays on; "false" as a string still works', async () => {
    const id = await seedFunction('daily_digest', 'manual')
    expect(TOOL_TO_ACTION.toggle_ai_function({ name: 'daily_digest' }).params.active).toBeUndefined()
    const out = await viaTool('toggle_ai_function', { name: 'daily_digest' })
    expect(out.success).toBe(false)
    expect((await prisma.aiFunction.findUnique({ where: { id }, select: { status: true } }))?.status).toBe('active')

    const off = await viaTool('toggle_ai_function', { name: 'daily_digest', active: 'false' })
    expect(off.success).toBe(true)
    expect((await prisma.aiFunction.findUnique({ where: { id }, select: { status: true } }))?.status).toBe('inactive')
  }, 60_000)
})

describe('FN-15: only a function that calls Stripe needs Stripe', () => {
  it('a payments description with no Stripe in it is created', async () => {
    const out = await act('CREATE_AI_FUNCTION', {
      name: 'add_to_balance', triggerType: 'on_db_insert', triggerTable: 'orders',
      description: 'when a payment row is inserted, add its amount to the account balance',
    })
    expect(out.success).toBe(true)
    expect(await fnNames()).toContain('add_to_balance')
  }, 60_000)

  it('a description that calls Stripe, with no key stored, points at the connect call, not the chat', async () => {
    const out = await act('CREATE_AI_FUNCTION', {
      name: 'refund_order', triggerType: 'manual', description: 'refund the order through Stripe',
    })
    expect(out.success).toBe(false)
    expect(out.error).toBe('INTEGRATION_NOT_CONNECTED')
    expect(out.message).toContain('integrations { "action": "connect"')
    expect(out.message).not.toContain('in the chat')
  }, 60_000)
})
