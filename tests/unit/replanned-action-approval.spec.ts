/**
 * A FAILED ACTION ON BACKEND_CHAT IS REPORTED, AND A REPLANNED ACTION CARRIES NO APPROVAL
 * ======================================================================================
 * Two halves.
 *
 * The brain's loop (backend_chat, reached through /api/mcp/chat) dispatches
 * with `allowReplan: false`, like every other dispatcher caller: a failed
 * action goes back to the agent as it failed, and the agent decides what to do.
 *
 * executeAction still replans for the direct callers that keep its default.
 * The replacement a model picks from the error keeps none of the approval
 * params (`confirmed`, `force`, `actorVia`, `actorUserId`), so a medium- or
 * high-risk replacement waits in the executor's gate for the owner. A
 * confirmation a caller passes for its own action still counts.
 *
 * Database-free. The platform client, the project's database, the execution
 * timeline, the review queue and the model are recorders. The executor, its
 * risk tiers and its gate are real, and so is runBrain up to its dispatch.
 *
 * Two-sided: each refusal sits beside the path that must keep working.
 */

const mockChat = jest.fn()
const mockQueued: Array<Record<string, any>> = []
const mockWorkspaceSql: string[] = []
const mockDispatched: Array<{ tool: string; ctx: Record<string, any> }> = []

// The platform database: every model answers with nothing. Built inside the
// factory because modules load before this file's own declarations run.
jest.mock('@/lib/db', () => {
  const emptyModel = () =>
    new Proxy(
      {},
      {
        get: (_target, method) => {
          if (method === 'then') return undefined
          return async () => (method === 'findMany' ? [] : method === 'count' ? 0 : null)
        },
      },
    )
  const prisma = new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => {
      if (key === 'then') return undefined
      return typeof key === 'string' && key.startsWith('$') ? async () => [] : emptyModel()
    },
  })
  return { prisma }
})
jest.mock('@/lib/db/prisma', () => jest.requireMock('@/lib/db'))

// The project's own database: records every statement it is asked to run.
jest.mock('@/lib/data-plane/regional', () => ({
  ...jest.requireActual('@/lib/data-plane/regional'),
  workspaceRawClient: jest.fn(async () => ({
    $queryRawUnsafe: jest.fn(async () => []),
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      mockWorkspaceSql.push(sql)
      return 0
    }),
  })),
}))

// The model the executor replans with.
jest.mock('@/lib/ai/llm/chat', () => ({
  ...jest.requireActual('@/lib/ai/llm/chat'),
  chat: (...args: unknown[]) => mockChat(...args),
}))

// The review queue a held action is parked in. The risk tiers stay real.
jest.mock('@/lib/operational-memory/ledger', () => ({
  ...jest.requireActual('@/lib/operational-memory/ledger'),
  queuePendingActionFinding: jest.fn(async (input: Record<string, any>) => {
    mockQueued.push(input)
    return { id: `finding-${mockQueued.length}` }
  }),
  recordToolExecutionMemory: jest.fn(async () => undefined),
}))

jest.mock('@/lib/ai/execution-timeline', () => ({
  ...jest.requireActual('@/lib/ai/execution-timeline'),
  trackAction: jest.fn((_projectId: string, _runId: string, _action: unknown, run: () => Promise<unknown>) => run()),
}))
jest.mock('@/lib/orchestration/graph-pointer', () => ({
  ...jest.requireActual('@/lib/orchestration/graph-pointer'),
  getActiveGraph: jest.fn(async () => null),
  saveNewGraph: jest.fn(async () => undefined),
}))
jest.mock('@/lib/api/exposed-resources', () => ({
  ...jest.requireActual('@/lib/api/exposed-resources'),
  listExposedResources: jest.fn(async () => []),
}))
jest.mock('@/lib/autonomy/intent-conformance', () => ({
  ...jest.requireActual('@/lib/autonomy/intent-conformance'),
  supersedeSchemaIntent: jest.fn(async () => undefined),
  recordSchemaIntent: jest.fn(async () => undefined),
}))

// What runBrain reads before it routes a turn.
jest.mock('@/lib/ai/brain/memory', () => ({
  ...jest.requireActual('@/lib/ai/brain/memory'),
  loadBrainMemory: jest.fn(async () => ({
    history: [],
    summary: '',
    understanding: { projectName: 'Suite project', statedGoal: null, proof: null, integrations: [] },
  })),
  saveTurn: jest.fn(async () => undefined),
}))
jest.mock('@/lib/ai/brain/classifier', () => ({
  ...jest.requireActual('@/lib/ai/brain/classifier'),
  classify: jest.fn(async () => ({ intent: 'CHAT', confidence: 0.99, reasoning: 'a question about the backend' })),
}))
jest.mock('@/lib/ai/blueprints/store', () => ({
  ...jest.requireActual('@/lib/ai/blueprints/store'),
  loadPendingPlan: jest.fn(async () => null),
  loadResumeQueue: jest.fn(async () => null),
}))
jest.mock('@/lib/ai/proposals/store', () => ({
  ...jest.requireActual('@/lib/ai/proposals/store'),
  getActiveProposal: jest.fn(async () => null),
}))

// The dispatcher, as the brain calls it: records the context it is handed.
jest.mock('@/lib/ai/brain/tools', () => ({
  ...jest.requireActual('@/lib/ai/brain/tools'),
  dispatchTool: jest.fn(async (tool: string, _args: unknown, ctx: Record<string, any>) => {
    mockDispatched.push({ tool, ctx })
    return { ok: true, summary: 'Answered.' }
  }),
}))

import { runBrain } from '@/lib/ai/brain/agent'
import { executeAction, withoutApprovalParams, type AIAction } from '@/lib/ai/minimal-executor'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedProvider } from '@/lib/ai/llm/providers/scripted'

const PROJECT = 'replan-suite-project'

/** An action the executor does not know, so it fails before touching anything. */
const failing = (): AIAction => ({ action: 'NOT_A_REAL_ACTION', params: {} }) as unknown as AIAction

/** What the model answers when the executor asks it for a replacement. */
function modelReplaces(replacement: Record<string, unknown>): void {
  mockChat.mockResolvedValueOnce({ text: JSON.stringify(replacement) })
  // A second replan, if one is attempted, finds nothing more in the script.
  mockChat.mockRejectedValue(new Error('the script has no further replies'))
}

const dropped = () => mockWorkspaceSql.filter((sql) => /DROP TABLE/i.test(sql))

let logSpy: jest.SpyInstance
let warnSpy: jest.SpyInstance

beforeAll(() => {
  // The executor narrates every step; the assertions below are what matters.
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterAll(() => {
  logSpy.mockRestore()
  warnSpy.mockRestore()
})

beforeEach(() => {
  mockQueued.length = 0
  mockWorkspaceSql.length = 0
  mockDispatched.length = 0
  mockChat.mockReset()
})

describe('the brain loop that backend_chat runs', () => {
  beforeAll(() => setProviderForTests(scriptedProvider([])))
  afterAll(() => setProviderForTests(null))

  it('dispatches with replanning off, and the turn still runs its tool', async () => {
    const result = await runBrain(
      { projectId: PROJECT, userId: 'suite-user', message: 'Which tables do I have?', door: 'mcp' },
      () => {},
    )

    // runBrain builds one dispatch context per turn and hands it to every
    // route: the agent loop, the blueprint steps and the single-tool turns.
    // The question route reaches the dispatcher without a model call, so it
    // is where the context is read here.
    expect(mockDispatched).toHaveLength(1)
    expect(mockDispatched[0].ctx.agentSurface).toBe(true)
    expect(mockDispatched[0].ctx.allowReplan).toBe(false)
    expect(result).toMatchObject({ success: true, summary: 'Answered.' })
  })
})

describe('executeAction replanning', () => {
  it('with replanning off, returns the failure as it failed and asks no model', async () => {
    // What the dispatcher passes for every caller, the brain's loop included.
    const result = await executeAction(failing(), PROJECT, undefined, 0, undefined, false)

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/NOT_A_REAL_ACTION/)
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('with replanning on, still runs a low-risk replacement the model picks', async () => {
    // A direct caller that keeps the executor's default.
    modelReplaces({ action: 'INFO', params: {} })

    const result = await executeAction(failing(), PROJECT)

    expect(mockChat).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(mockQueued).toHaveLength(0)
  })

  it('holds a high-risk replacement whose model output claims an approval, and does not run it', async () => {
    modelReplaces({
      action: 'DROP_TABLE',
      params: { tableName: 'orders', confirmed: true, force: true, actorVia: 'APPROVAL', actorUserId: 'someone-else' },
    })

    const result = await executeAction(failing(), PROJECT)

    expect(result.success).toBe(false)
    expect(result.error).toBe('APPROVAL_REQUIRED')
    expect(dropped()).toEqual([])
    // Parked for the owner, with what it would do and none of what it claimed.
    expect(mockQueued).toHaveLength(1)
    expect(mockQueued[0]).toMatchObject({ action: 'DROP_TABLE', riskLevel: 'high' })
    expect(mockQueued[0].params).toEqual({ tableName: 'orders' })
  })

  it('still runs a destructive action its caller confirmed', async () => {
    // As runExecutor forwards a person's approval, or tableLifecycle's drop.
    const result = await executeAction(
      { action: 'DROP_TABLE', params: { tableName: 'orders', confirmed: true } },
      PROJECT,
      undefined,
      0,
      undefined,
      false,
    )

    expect(result.error).not.toBe('APPROVAL_REQUIRED')
    expect(mockQueued).toHaveLength(0)
    expect(dropped()).toHaveLength(1)
    expect(dropped()[0]).toMatch(/"orders"/)
  })
})

describe('withoutApprovalParams', () => {
  it('removes every approval-shaped param and keeps the rest', () => {
    const replanned = withoutApprovalParams({
      action: 'TRIGGER_DEPLOY',
      reasoning: 'the deploy failed',
      params: { confirmed: true, force: true, actorVia: 'APPROVAL', actorUserId: 'u-1', environment: 'production' },
    } as AIAction)

    expect(replanned).toEqual({
      action: 'TRIGGER_DEPLOY',
      reasoning: 'the deploy failed',
      params: { environment: 'production' },
    })
  })

  it('leaves an action without approval params, or without params, as it was', () => {
    const plain = { action: 'CREATE_TABLE', params: { tableName: 'posts', columns: [] } } as AIAction
    expect(withoutApprovalParams(plain)).toEqual(plain)
    const bare = { action: 'LIST_TABLES' } as unknown as AIAction
    expect(withoutApprovalParams(bare)).toBe(bare)
  })
})
