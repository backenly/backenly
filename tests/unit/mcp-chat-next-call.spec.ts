/**
 * What /api/mcp/chat tells an agent when a request did not finish in one call.
 *
 * A build the wall clock stopped came back `ok: true, partial: true` with "say
 * continue" in its prose, and agents took the two tables they had as the
 * build. The body now names the call that carries the request on (`next`), a
 * design still running answers `status: "designing"`, and a request that is
 * still going when the call answers says so with the call that collects it.
 *
 * The brain, the key, the gates and the credits are stubbed, and there is no
 * database here, so the run cannot be recorded: these are the answers a run
 * gives on that path too. tests/integration/brain-runs.spec.ts holds runs to a
 * real database.
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
jest.mock('@/lib/ai/brain/runs', () => {
  const actual = jest.requireActual('@/lib/ai/brain/runs')
  const refuse = async () => { throw new Error('no database in this suite') }
  return {
    ...actual,
    startRun: jest.fn(refuse),
    activeRun: jest.fn(async () => null),
    latestRun: jest.fn(async () => null),
  }
})
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
import { isStatusCheck, setRunLimitsForTests } from '@/lib/ai/brain/runs'

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

afterEach(() => setRunLimitsForTests(null))

describe('a build that did not finish in one turn', () => {
  it('a stop that verified what landed carries next: continue', async () => {
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

describe('a request still going when the call answers', () => {
  it('is not cut off: the answer says it is running, and it finishes after the call', async () => {
    setRunLimitsForTests({ syncWaitMs: 50 })
    let finished = false
    mockTurn = () => new Promise((resolve) => setTimeout(() => {
      finished = true
      resolve(turn({ applied: ['Creating table products'] }))
    }, 300))

    const res = await ask('build my store')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, status: 'running' })
    expect(body).not.toHaveProperty('code')
    // Unrecorded here, so the answer points at the live state rather than a run to poll.
    expect(body.next).toMatchObject({ tool: 'read_backend_state' })
    expect(finished).toBe(false)
    await new Promise((r) => setTimeout(r, 400))
    expect(finished).toBe(true)
  })
})

describe('which messages only ask after a running request', () => {
  it.each(['status', 'Status', 'check status', 'is it done?', 'progress.', 'wait'])('%s does', (m) => {
    expect(isStatusCheck(m)).toBe(true)
  })
  it.each(['continue', 'go ahead', 'build my store', 'what is the status of my orders table?'])('%s does not', (m) => {
    expect(isStatusCheck(m)).toBe(false)
  })
})
