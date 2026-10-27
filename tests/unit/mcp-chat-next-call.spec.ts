/**
 * What /api/mcp/chat tells an agent when a request did not finish in one call.
 *
 * A build the wall clock stopped came back `ok: true, partial: true` with "say
 * continue" in its prose, and agents took the two tables they had as the
 * build. A design that outlasted the call came back BRAIN_TIMEOUT, "Nothing was
 * applied", retryable, so every retry started another design of the same
 * backend. The body now names the call that carries the request on (`next`),
 * and a design still running answers `status: "designing"`.
 *
 * The brain, the key, the gates and the credits are stubbed; the route is real.
 */
import '../helpers/next-request-polyfill'

let mockTurn: (emit: (e: unknown) => void) => Promise<unknown>

jest.mock('@/lib/mcp/guard', () => ({
  mcpGuard: jest.fn(async () => ({
    auth: { keyId: 'k1', projectId: 'p1', userId: 'u-agent', scope: 'mcp', readOnly: false },
  })),
  recordMcpCall: jest.fn(),
  refuseIfReadOnly: jest.fn(() => null),
}))
jest.mock('@/lib/ai/brain/agent', () => ({
  runBrain: jest.fn((_input: unknown, emit: (e: unknown) => void) => mockTurn(emit)),
}))
jest.mock('@/lib/mcp/approvals', () => ({
  createApprovalRequest: jest.fn(),
  RestoreRequestRefusedError: class RestoreRequestRefusedError extends Error {},
}))
jest.mock('@/lib/platform-controls', () => ({ assertAiAllowed: jest.fn(async () => ({ ok: true })) }))
jest.mock('@/lib/entitlements/policy', () => ({ enforceAiCredits: jest.fn(async () => true) }))
jest.mock('@/lib/entitlements/credit-holds', () => ({ closeCreditTurn: jest.fn(async () => {}) }))
jest.mock('@/lib/usage/account', () => ({ creditAccountOf: jest.fn(async () => 'account-1') }))

import { NextRequest } from 'next/server'
import { POST as chat } from '@/app/api/mcp/chat/route'
import { CONTINUE, GO_AHEAD_LATER } from '@/lib/ai/brain/next-call'

const ask = (message: string) =>
  chat(new NextRequest('https://backenly.test/api/mcp/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'mcp_live_test' },
    body: JSON.stringify({ message }),
  }))

const turn = (o: Record<string, unknown>) => ({
  success: true,
  summary: 'Done.',
  needsUser: false,
  iterations: 1,
  toolsRun: [],
  classification: { intent: 'BUILD', confidence: 0.9, reasoning: 'scripted' },
  tokensUsed: 0,
  ...o,
})

afterEach(() => jest.useRealTimers())

describe('a build that did not finish in one call', () => {
  it('a wall-clock stop that verified what landed carries next: continue', async () => {
    mockTurn = async () => turn({
      success: false,
      budgetStopped: true,
      verified: true,
      applied: ['Creating table products', 'Creating table orders'],
      next: CONTINUE,
    })

    const body = await (await ask('build my store')).json()

    expect(body).toMatchObject({ ok: true, partial: true, applied: ['Creating table products', 'Creating table orders'], next: CONTINUE })
  })

  it('a step-budget stop carries next: continue beside its code', async () => {
    mockTurn = async () => turn({
      success: false,
      failureCode: 'STEP_BUDGET_EXHAUSTED',
      retryable: false,
      applied: ['Creating table products'],
      next: CONTINUE,
    })

    const body = await (await ask('build my store')).json()

    expect(body).toMatchObject({ ok: false, code: 'STEP_BUDGET_EXHAUSTED', next: CONTINUE })
  })

  it('a turn that finished carries no next', async () => {
    mockTurn = async () => turn({ applied: ['Creating table products'] })
    const body = await (await ask('add a products table')).json()
    expect(body.ok).toBe(true)
    expect(body).not.toHaveProperty('next')
  })

  it('a design still running answers status: designing, with the call that collects it', async () => {
    mockTurn = async () => turn({ inProgress: 'designing', next: GO_AHEAD_LATER })

    const body = await (await ask('build a recipe app')).json()

    expect(body).toMatchObject({ ok: true, status: 'designing', next: GO_AHEAD_LATER })
  })

  it('protected production names the branch to build on', async () => {
    const next = { tool: 'branch', arguments: { action: 'create', name: 'build' }, why: 'protected' }
    mockTurn = async () => turn({ success: false, failureCode: 'BRANCH_REQUIRED', retryable: false, applied: [], next })

    const body = await (await ask('build my store')).json()

    expect(body).toMatchObject({ ok: false, code: 'BRANCH_REQUIRED', retryable: false, next })
  })
})

describe('the wall clock', () => {
  it('cutting a design answers that it is still designing, not that nothing was applied', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    mockTurn = (emit) => {
      emit({ type: 'phase', phase: 'route' })
      emit({ type: 'phase', phase: 'design' })
      emit({ type: 'thinking', text: 'Designing your database schema and table relationships…' })
      return new Promise(() => {})
    }

    const pending = ask('build a recipe app')
    await jest.advanceTimersByTimeAsync(90_000)
    const res = await pending
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, status: 'designing', next: GO_AHEAD_LATER })
    expect(body.summary).toContain('"go ahead"')
    expect(body.summary).toContain('would only start a second design')
    expect(body).not.toHaveProperty('code')
  })

  it('cutting a turn with nothing designed or applied is still a timeout', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    mockTurn = (emit) => {
      emit({ type: 'phase', phase: 'route' })
      return new Promise(() => {})
    }

    const pending = ask('build a recipe app')
    await jest.advanceTimersByTimeAsync(90_000)
    const res = await pending
    const body = await res.json()

    expect(res.status).toBe(504)
    expect(body).toMatchObject({ ok: false, code: 'BRAIN_TIMEOUT', retryable: true })
    expect(body).not.toHaveProperty('status')
  })
})
