/**
 * A FAILED HTTP FUNCTION RUN KEEPS ITS LOG LINES (#605)
 * ====================================================
 * When a route-module (trigger "http") function threw, everything it had
 * logged was thrown away: the runner's error carried only the message, and
 * the executor stored and returned an empty list. The console's run history
 * and the agent's `logs` and `invoke` showed the error with none of the
 * console.log lines that would explain it, on exactly the runs that needed
 * them. Sandbox functions already kept theirs.
 *
 * Here HTTP functions run through the real executor (executeAiFunction), the
 * agent's invoke and logs actions, and the creation check of a generated
 * function, against real function and run rows. Only the model that writes a
 * generated function's code is stubbed, as functions-runtime-honesty does.
 */
jest.mock('@/lib/ai/llm/chat', () => {
  const actual = jest.requireActual('@/lib/ai/llm/chat')
  return {
    ...actual,
    chat: jest.fn(async () => {
      const next = (global as any).__CANNED_CODE__?.shift()
      if (typeof next !== 'string') throw new Error('test: no canned code queued for chat()')
      return { text: next, result: {} }
    }),
  }
})

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'
import { invokeFunction, listFunctionLogs } from '@/lib/services/ai-functions/agent-actions'
import { executeGenerateFunction } from '@/lib/ai/function-generator'

let ownerId = ''
let projectId = ''

// Logs, then throws: the lines are what explain the failure.
const CHARGE_ORDER = `
import { NextResponse } from 'next/server'
export async function POST(req: Request) {
  const order = await req.json()
  console.log('charging order', order.ref)
  console.warn('card declined, retrying with the backup processor')
  throw new Error('backup processor unavailable')
}
`

async function httpFunction(name: string, code: string) {
  return prisma.aiFunction.create({
    data: { projectId, name, description: name, triggerType: 'manual', status: 'active', generatedCode: code },
    select: { id: true },
  })
}

const runRecords = (functionId: string) =>
  prisma.aiFunctionLog.findMany({
    where: { functionId },
    orderBy: { createdAt: 'asc' },
    select: { success: true, error: true, logs: true, triggerType: true },
  })

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `http-fn-logs-${crypto.randomBytes(6).toString('hex')}@example.test`, name: 'HTTP function logs' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'http-function-failure-keeps-logs', userId: ownerId }, select: { id: true } })).id
}, 60_000)

afterAll(async () => {
  ;(global as any).__CANNED_CODE__ = undefined
  if (projectId) {
    await prisma.aiFunctionLog.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('a failed run is stored and returned with the lines it logged', () => {
  it('a handler that throws: the run keeps its lines, and the call returns them with the error', async () => {
    const fn = await httpFunction('charge-order', CHARGE_ORDER)
    const result = await executeAiFunction(fn.id, projectId, { type: 'manual', data: { ref: 'A-1' } }, { selfHeal: false })

    const lines = ['charging order A-1', 'card declined, retrying with the backup processor']
    expect({ success: result.success, error: result.error, logs: result.logs }).toEqual({
      success: false,
      error: 'backup processor unavailable',
      logs: lines,
    })
    expect(await runRecords(fn.id)).toEqual([{ success: false, error: 'backup processor unavailable', logs: lines, triggerType: 'manual' }])
  }, 60_000)

  it("the agent's invoke returns the lines with the failure, and its logs action reads them back", async () => {
    const actor = { userId: ownerId, projectId }
    const invoked = await invokeFunction(actor, { name: 'charge-order', event: { ref: 'A-2' } })
    expect(invoked.ok).toBe(false)
    expect((invoked.data as any).logs).toEqual(['charging order A-2', 'card declined, retrying with the backup processor'])

    const read = await listFunctionLogs(actor, { name: 'charge-order', limit: 1 })
    expect((read.data as any).runs[0]).toMatchObject({
      success: false,
      error: 'backup processor unavailable',
      logs: ['charging order A-2', 'card declined, retrying with the backup processor'],
    })
  }, 60_000)

  it('a module whose top level throws keeps what it logged while loading', async () => {
    const fn = await httpFunction(
      'tax-table',
      `import { NextResponse } from 'next/server'
       console.log('loading the tax table')
       const table = JSON.parse('{not json')
       export async function GET() { return NextResponse.json({ table }) }`,
    )
    const result = await executeAiFunction(fn.id, projectId, { type: 'manual', data: {} }, { selfHeal: false })
    expect(result.error).toMatch(/^Route module evaluation error: /)
    expect(result.logs).toEqual(['loading the tax table'])
    expect((await runRecords(fn.id))[0].logs).toEqual(['loading the tax table'])
  }, 60_000)

  it('a module that exports no handler keeps what it logged', async () => {
    const fn = await httpFunction(
      'no-handler',
      `import { NextResponse } from 'next/server'
       console.log('registering the handler')
       export async function get() { return NextResponse.json({}) }`,
    )
    const result = await executeAiFunction(fn.id, projectId, { type: 'manual', data: {} }, { selfHeal: false })
    expect(result.error).toBe('Route module exports no GET/POST/PUT/PATCH/DELETE handler')
    expect(result.logs).toEqual(['registering the handler'])
    expect((await runRecords(fn.id))[0].logs).toEqual(['registering the handler'])
  }, 60_000)

  it('a handler that runs past the time limit keeps what it logged before it', async () => {
    const fn = await httpFunction(
      'slow-warehouse',
      `import { NextResponse } from 'next/server'
       export async function GET() {
         console.log('waiting for the warehouse')
         await new Promise(() => {})
       }`,
    )
    const result = await executeAiFunction(fn.id, projectId, { type: 'manual', data: {} }, { selfHeal: false })
    expect(result.error).toBe('Route function timed out after 10s')
    expect(result.logs).toEqual(['waiting for the warehouse'])
    expect((await runRecords(fn.id))[0].logs).toEqual(['waiting for the warehouse'])
  }, 60_000)

  it('code that does not compile ran nothing, so its run has no lines', async () => {
    const fn = await httpFunction('does-not-compile', `import { NextResponse } from 'next/server'\nexport async function GET( {`)
    const result = await executeAiFunction(fn.id, projectId, { type: 'manual', data: {} }, { selfHeal: false })
    expect(result.error).toMatch(/^Route module failed to compile: /)
    expect(result.logs).toEqual([])
  }, 60_000)
})

describe("a generated function's creation check", () => {
  it('that fails is recorded with the lines the module logged before failing', async () => {
    const broken = `
import { NextResponse } from 'next/server'
export async function GET(req: Request) {
  console.log('reading the tax settings')
  throw new Error('tax_settings does not exist')
}
`
    // The generation, then the repair attempt, which gives back the same code.
    ;(global as any).__CANNED_CODE__ = [broken, broken]
    const res = await executeGenerateFunction({ name: 'tax-report', description: 'report the taxes owed', method: 'GET' }, projectId)
    expect(res.success).toBe(false)
    expect(res.message).toContain('FAILED its runtime smoke test')

    const fn = await prisma.aiFunction.findFirst({ where: { projectId, name: 'tax-report' }, select: { id: true, status: true } })
    expect(fn?.status).toBe('error')
    expect(await runRecords(fn!.id)).toEqual([
      {
        success: false,
        error: 'tax_settings does not exist',
        logs: ['Creation check (GET ?describe=1): failed', 'reading the tax settings'],
        triggerType: 'creation_check',
      },
    ])
  }, 120_000)
})
