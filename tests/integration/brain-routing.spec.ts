/**
 * Where runBrain sends a turn, and every way the agent loop can end (#246).
 *
 * The routes are decided in one function, and until now only some of them were
 * tested, each in a spec of its own. This one runs the rest on the shared
 * harness (tests/helpers/brain-harness.ts): the real brain, dispatcher and
 * executor over the real test database, with only the model scripted. What a
 * route did is read back from the turn's result, the model calls it made and
 * the tables and stored plans it left.
 *
 * Every route and ending has one test in this file; the first block below is
 * the plain ones (CHAT, UNCLEAR, QUESTION, DESTRUCTIVE, the loop's endings).
 * These specs go deeper on their own part:
 *   CHAT, UNCLEAR billing and history     brain-classify-clarify-spend, brain-chat-follow-up
 *   QUESTION tool surface                 brain-question-tools
 *   unread state, lost plan               brain-unread-state
 *   approval gate, data migrations        brain-approval-targets, brain-data-migration-approval
 *   cut-off answers                       brain-cut-off-tool-calls
 *   step budget, iterations               brain-iterations
 *   verification steering, budget stop    brain-on-gateway, brain-loop-edges
 *   continue after a stopped loop turn    brain-continue-resume
 *
 * Mocked, and called through to the real function unless a test says otherwise:
 *   getBlueprintForPrompt   the architect is a model call with its own validation;
 *                           a test hands it the blueprint or question it returns.
 *   runAgenticFixLoop       the post-build check signs up users against a live
 *                           runtime, which a test run does not start.
 */

import type { Blueprint } from '@/lib/ai/blueprints/types'
import { getBlueprintForPrompt } from '@/lib/ai/blueprints'
import { loadPendingPlan, loadResumeQueue, savePendingPlan, saveResumeQueue } from '@/lib/ai/blueprints/store'
import { saveTurn } from '@/lib/ai/brain/memory'
import { setProviderForTests } from '@/lib/ai/llm'
import {
  classified,
  clarification,
  finished,
  providerRefusal,
  systemOf,
  toolCall,
  toolNamesOf,
  setUpBrainProject,
} from '../helpers/brain-harness'
import { AiError } from '@/lib/ai/llm'
import { scriptedMessage } from '@/lib/ai/llm/providers/scripted'
import { runBrain } from '@/lib/ai/brain/agent'

jest.mock('@/lib/ai/blueprints', () => {
  const actual = jest.requireActual<typeof import('@/lib/ai/blueprints')>('@/lib/ai/blueprints')
  return { ...actual, getBlueprintForPrompt: jest.fn(actual.getBlueprintForPrompt) }
})

jest.mock('@/lib/ai/minimal-executor', () => require('../helpers/brain-executor-recorder').recordingExecutor())

jest.mock('@/lib/ai/agentic-fix-loop', () => ({
  runAgenticFixLoop: jest.fn().mockRejectedValue(new Error('no live runtime in tests')),
}))

const architect = getBlueprintForPrompt as jest.MockedFunction<typeof getBlueprintForPrompt>

/** A one-table plan: small enough to run for real, with a table to look for afterwards. */
const planOf = (table: string): Blueprint => ({
  domain: 'routing-test',
  title: 'Routing test backend',
  summary: 'One table.',
  steps: [{
    label: `Create ${table}`,
    tool: 'create_table',
    args: { tableName: table, columns: [{ name: 'title', type: 'text' }] },
  }],
})
const matchOf = { domain: 'routing-test', confidence: 0.85, matchedOn: 'llm-architect' }

/** Long, and not a table spec, so a lost plan is designed again on a project with nothing built. */
const ORIGINAL_REQUEST =
  'A recipe sharing app where home cooks post recipes with photos, ingredients and steps, follow each ' +
  'other, save favourites into collections, and leave ratings and comments on what they cooked, with a ' +
  'feed of new recipes from the people they follow.'

const fresh = setUpBrainProject({ name: 'brain-routing-fresh' })
const built = setUpBrainProject({ name: 'brain-routing-built', tables: ['keep_me'] })

const realArchitect = jest.requireActual<typeof import('@/lib/ai/blueprints')>('@/lib/ai/blueprints').getBlueprintForPrompt

beforeEach(() => {
  // A value a failed test left queued must not answer the next test's call.
  architect.mockReset()
  architect.mockImplementation(realArchitect)
})

describe('the plain routes and endings', () => {
  it('CHAT: answers from one model call, runs no tool of the backend, and changes nothing', async () => {
    const { result, provider, executorCalls } = await built.turn([classified('CHAT'), scriptedMessage({ text: 'RLS limits which rows a caller can read.' })], 'explain RLS')

    expect(provider.calls).toHaveLength(2)
    expect(executorCalls).toEqual([])
    expect(result).toMatchObject({ success: true, toolsRun: ['answer_question'], classification: { intent: 'CHAT' } })
    expect(result.summary).toContain('RLS limits which rows')
    expect(await built.tableExists('keep_me')).toBe(true)
  }, 60_000)

  it('UNCLEAR: asks one question and builds nothing', async () => {
    const { result } = await built.turn([classified('UNCLEAR'), clarification('Which table do you mean?', ['keep_me'])], 'fix it')

    expect(result).toMatchObject({ needsUser: true, toolsRun: ['ask_user'], classification: { intent: 'UNCLEAR' } })
    expect(result.summary).toContain('Which table do you mean?')
  }, 60_000)

  it('QUESTION: reads the state and finishes with the answer, offered reads only', async () => {
    const { result, provider } = await built.turn(
      [classified('QUESTION'), toolCall('read_backend_state'), finished('You have one table: keep_me.')],
      'what tables do I have?',
    )

    expect(result).toMatchObject({ success: true, summary: 'You have one table: keep_me.', toolsRun: ['read_backend_state', 'finish'], iterations: 2 })
    expect(toolNamesOf(provider, 1)).not.toContain('create_table')
  }, 60_000)

  it('MODIFY: runs a change, verifies it, and finishes', async () => {
    const { result, executorCalls, modelCalls } = await built.turn(
      [
        classified('MODIFY'),
        toolCall('create_table', { tableName: 'plain_route', columns: [{ name: 'title', type: 'text' }] }),
        toolCall('read_backend_state'),
        finished('Created plain_route.'),
      ],
      'add a plain_route table',
    )

    expect(await built.tableExists('plain_route')).toBe(true)
    // The one change reached the executor, as one action on this project.
    expect(executorCalls).toHaveLength(1)
    expect(executorCalls[0]).toMatchObject({ projectId: built.projectId, action: { action: 'CREATE_TABLE', params: { tableName: 'plain_route' } } })
    expect(modelCalls).toHaveLength(4)
    expect(result).toMatchObject({ success: true, toolsRun: ['create_table', 'read_backend_state', 'finish'], iterations: 3 })
    expect(result.applied).toHaveLength(1)
  }, 60_000)

  it('DESTRUCTIVE: holds the call for a person, runs nothing, and finishes by saying so', async () => {
    const { result, executorCalls } = await built.turn(
      [classified('DESTRUCTIVE'), toolCall('drop_table', { tableName: 'keep_me' }), finished('The drop is queued for approval.')],
      'drop keep_me',
    )

    expect(await built.tableExists('keep_me')).toBe(true)
    // Held before the executor: it was never asked to drop anything.
    expect(executorCalls).toEqual([])
    expect(result.blockedCalls).toEqual([expect.objectContaining({ tool: 'drop_table', args: { tableName: 'keep_me' } })])
    expect(result).toMatchObject({ success: true, applied: [], toolsRun: ['finish'] })
  }, 60_000)

  it('ends by step budget: twelve model calls, no more, and says to continue', async () => {
    const reads = Array.from({ length: 12 }, (_, i) => toolCall('read_backend_state', {}, `toolu_read_${i}`))

    const { result, provider } = await built.turn([classified('QUESTION'), ...reads], 'what is there?')

    expect(provider.calls).toHaveLength(13)
    expect(result).toMatchObject({ success: false, failureCode: 'STEP_BUDGET_EXHAUSTED', iterations: 12 })
    expect(result.summary).toContain('ran out of steps')
  }, 60_000)

  it('ends by budget stop: a deadline inside the reserve stops before the loop, verified', async () => {
    const { result } = await built.turn([classified('MODIFY')], 'add a table', { deadlineAt: Date.now() + 5_000 })

    expect(result).toMatchObject({ success: false, budgetStopped: true, verified: true, iterations: 0 })
  }, 60_000)
})

describe('a turn with no model configured', () => {
  const KEYS = ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'BEDROCK_REGION'] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  })

  it('stops before classifying, changes nothing and says it is not retryable', async () => {
    setProviderForTests(null)

    const result = await runBrain({ projectId: built.projectId, userId: built.ownerId, message: 'add a posts table' }, () => {})

    expect(result).toMatchObject({
      success: false,
      iterations: 0,
      toolsRun: [],
      tokensUsed: 0,
      failureCode: 'AI_UNAVAILABLE',
      retryable: false,
      applied: [],
    })
    expect(result.summary).toContain('Nothing was modified')
  }, 60_000)
})

describe('CONFIRM with nothing to confirm', () => {
  it('answers at once from the classifier alone, without entering the agent loop', async () => {
    const { result, provider, events } = await built.turn([classified('CONFIRM')], 'yes, go ahead')

    // One model call, the classifier's. A loop would have asked for a second.
    expect(provider.calls).toHaveLength(1)
    expect(result).toMatchObject({ success: true, needsUser: true, iterations: 0, toolsRun: [], tokensUsed: 0 })
    expect(result.summary).toContain('nothing was changed')
    expect(events.at(-1)).toMatchObject({ type: 'phase', phase: 'finish' })
  }, 60_000)
})

describe('BUILD on a brand-new project', () => {
  it('proposes a curated blueprint without a model call, stores it as the pending plan, and builds nothing', async () => {
    const { result, provider } = await fresh.turn([classified('BUILD')], 'I want to build a blog')

    expect(provider.calls).toHaveLength(1)
    expect(result).toMatchObject({
      success: true,
      needsUser: true,
      iterations: 0,
      toolsRun: ['propose_plan'],
      tokensUsed: 0,
    })
    expect(result.summary).toContain('Reply "go ahead"')

    const plan = await loadPendingPlan(fresh.projectId)
    expect(plan).toMatchObject({ architectTokens: 0 })
    expect(plan!.steps.length).toBeGreaterThan(0)
    // The plan is stored, not run.
    expect(await fresh.tableExists('posts')).toBe(false)
  }, 60_000)

  it('stores the architect\'s tokens on the plan to bill them when it is run, and bills none now', async () => {
    architect.mockResolvedValueOnce({ blueprint: planOf('routing_notes'), match: matchOf, architectTokens: 4321 })

    const { result } = await fresh.turn([classified('BUILD')], ORIGINAL_REQUEST)

    expect(result).toMatchObject({ toolsRun: ['propose_plan'], needsUser: true, tokensUsed: 0 })
    expect(await loadPendingPlan(fresh.projectId)).toMatchObject({ architectTokens: 4321, blueprintDomain: 'routing-test' })
    expect(await fresh.tableExists('routing_notes')).toBe(false)
  }, 60_000)

  it('asks the architect\'s own question when the description cannot be designed, and stores no plan', async () => {
    architect.mockResolvedValueOnce({ vague: true, askUser: 'Who are the users of this app?', architectTokens: 0 })

    const { result, provider } = await fresh.turn([classified('BUILD')], 'build me a backend')

    expect(provider.calls).toHaveLength(1)
    expect(result).toMatchObject({ needsUser: true, toolsRun: ['ask_user'], classification: { intent: 'BUILD' } })
    expect(result.summary).toContain('Who are the users of this app?')
    expect(await loadPendingPlan(fresh.projectId)).toBeNull()
  }, 60_000)

  it('is also the route for APPLY_PROPOSAL', async () => {
    architect.mockResolvedValueOnce({ blueprint: planOf('routing_notes'), match: matchOf, architectTokens: 0 })

    const { result } = await fresh.turn([classified('APPLY_PROPOSAL')], 'yes, build those')

    expect(result).toMatchObject({ toolsRun: ['propose_plan'], classification: { intent: 'APPLY_PROPOSAL' } })
    expect(await loadPendingPlan(fresh.projectId)).not.toBeNull()
  }, 60_000)

  it('does not take the architect path on a built project: the agent loop runs instead', async () => {
    const { result, provider } = await built.turn([classified('BUILD'), finished('Added.')], 'add a comments table')

    expect(architect).not.toHaveBeenCalled()
    expect(provider.calls).toHaveLength(2)
    expect(result).toMatchObject({ toolsRun: ['finish'], iterations: 1 })
  }, 60_000)
})

describe('UNCLEAR on a brand-new project', () => {
  it('hands a description that reads like an app to the architect instead of asking about it', async () => {
    architect.mockResolvedValueOnce({ blueprint: planOf('routing_notes'), match: matchOf, architectTokens: 0 })

    const { result, provider } = await fresh.turn(
      [classified('UNCLEAR')],
      'Users can post recipes with photos and follow each other',
    )

    // No clarification call: the classifier's was the only one.
    expect(provider.calls).toHaveLength(1)
    expect(result).toMatchObject({ toolsRun: ['propose_plan'], classification: { intent: 'BUILD' } })
    expect(await loadPendingPlan(fresh.projectId)).not.toBeNull()
  }, 60_000)

  it('still asks when the message does not read like an app', async () => {
    const { result, provider } = await fresh.turn(
      [classified('UNCLEAR'), clarification('What would you like to build?', ['A blog', 'A store'])],
      'hmm',
    )

    expect(architect).not.toHaveBeenCalled()
    expect(provider.calls).toHaveLength(2)
    expect(result).toMatchObject({ needsUser: true, toolsRun: ['ask_user'] })
  }, 60_000)
})

describe('CONFIRM with a plan waiting', () => {
  it('runs the stored plan with no model call, clears it, and builds what it holds', async () => {
    await savePendingPlan(fresh.projectId, planOf('confirmed_notes'), matchOf, 1000)

    const { result, provider } = await fresh.turn([classified('CONFIRM')], 'go ahead')

    expect(provider.calls).toHaveLength(1)
    expect(await fresh.tableExists('confirmed_notes')).toBe(true)
    expect(await loadPendingPlan(fresh.projectId)).toBeNull()
    expect(result).toMatchObject({ success: true, toolsRun: ['create_table'], iterations: 1, verifiedInline: true })
    // The architect's tokens are billed now, on top of the step.
    expect(result.tokensUsed).toBeGreaterThan(1000)
    // The post-build check could not run here, and the summary says so rather than claiming a pass.
    expect(result.summary).toContain('could not run this time')
  }, 60_000)

  it('keeps going past a step that fails, queues it, and says what is left', async () => {
    const plan = planOf('partly_built')
    plan.steps.push({ label: 'Do something unknown', tool: 'no_such_tool', args: {} })
    await savePendingPlan(fresh.projectId, plan, matchOf, 0)

    const { result } = await fresh.turn([classified('CONFIRM')], 'go ahead')

    expect(await fresh.tableExists('partly_built')).toBe(true)
    expect(result.success).toBe(false)
    expect(result.summary).toContain('1 item need a follow-up')
    expect(await loadPendingPlan(fresh.projectId)).toBeNull()
    expect(await loadResumeQueue(fresh.projectId)).toMatchObject({ steps: [{ tool: 'no_such_tool' }] })
  }, 60_000)
})

describe('CONFIRM with only a resume queue', () => {
  it('runs the queued steps with no model call and no architect tokens, then empties the queue', async () => {
    await saveResumeQueue(fresh.projectId, 'routing-test', planOf('resumed_notes').steps, 'one step failed the first time')

    const { result, provider } = await fresh.turn([classified('CONFIRM')], 'continue')

    expect(provider.calls).toHaveLength(1)
    expect(await fresh.tableExists('resumed_notes')).toBe(true)
    expect(await loadResumeQueue(fresh.projectId)).toBeNull()
    expect(result).toMatchObject({ success: true, toolsRun: ['create_table'] })
  }, 60_000)
})

describe('CONFIRM when the plan was lost', () => {
  it('designs the original request again, on a project still empty, and runs it', async () => {
    await saveTurn(fresh.projectId, ORIGINAL_REQUEST, 'Here is the plan.\n\nReply "go ahead" to run this, or tell me what to add or remove.')
    architect.mockResolvedValueOnce({ blueprint: planOf('rearchitected_notes'), match: matchOf, architectTokens: 500 })

    const { result, provider } = await fresh.turn([classified('CONFIRM')], 'go ahead')

    expect(architect).toHaveBeenCalledWith(ORIGINAL_REQUEST, fresh.projectId)
    expect(provider.calls).toHaveLength(1)
    expect(await fresh.tableExists('rearchitected_notes')).toBe(true)
    expect(result).toMatchObject({ success: true, toolsRun: ['create_table'] })
  }, 60_000)

  it('does not offer propose_plan to the agent loop a CONFIRM falls into', async () => {
    // A built project is never re-architected, so a lost plan reaches the loop.
    await saveTurn(built.projectId, 'add a comments table', 'Here is the plan.\n\nReply "go ahead" to run this, or tell me what to add or remove.')

    const { provider } = await built.turn([classified('CONFIRM'), finished('No plan is stored.')], 'go ahead')

    expect(toolNamesOf(provider, 1)).not.toContain('propose_plan')
    expect(toolNamesOf(provider, 1)).toContain('create_table')
    expect(systemOf(provider, 1)).toContain('CONFIRMED the plan')
  }, 60_000)
})

describe('APPLY_PROPOSAL on a built project', () => {
  it('enters the agent loop with the whole catalog and a hint to build what the conversation listed', async () => {
    const { result, provider } = await built.turn(
      [classified('APPLY_PROPOSAL'), finished('Nothing was listed to build.')],
      'yes, implement those',
    )

    expect(architect).not.toHaveBeenCalled()
    expect(toolNamesOf(provider, 1)).toEqual(expect.arrayContaining(['create_table', 'propose_plan', 'finish']))
    expect(systemOf(provider, 1)).toContain('act on a list')
    expect(result).toMatchObject({ classification: { intent: 'APPLY_PROPOSAL' }, toolsRun: ['finish'] })
  }, 60_000)
})

describe('how the agent loop ends', () => {
  it('accepts a plain-text answer when nothing was changed', async () => {
    const { result } = await built.turn([classified('MODIFY'), scriptedMessage({ text: 'Nothing needs to change.' })], 'is anything broken?')

    expect(result).toMatchObject({ success: true, summary: 'Nothing needs to change.', iterations: 1, toolsRun: [], applied: [] })
    expect(result.failureCode).toBeUndefined()
  }, 60_000)

  it('ends on a question to the user as needing them, not as a failure to retry', async () => {
    const { result } = await built.turn(
      [classified('MODIFY'), toolCall('ask_user', { question: 'Which table should get the column?', options: ['keep_me'] })],
      'add a column',
    )

    expect(result).toMatchObject({ success: false, needsUser: true, failureCode: 'NEEDS_USER', retryable: false })
    expect(result.summary).toContain('Which table should get the column?')
  }, 60_000)

  it('reports a refused change as refused, applies nothing, and still finishes once it has verified', async () => {
    const { result } = await built.turn(
      [
        classified('MODIFY'),
        // keep_me exists, so creating it again is refused.
        toolCall('create_table', { tableName: 'keep_me', columns: [{ name: 'title', type: 'text' }] }),
        toolCall('read_backend_state'),
        finished('keep_me already exists, so nothing was created.'),
      ],
      'create a keep_me table',
    )

    expect(result).toMatchObject({ success: true, applied: [], toolsRun: ['create_table', 'read_backend_state', 'finish'] })
    expect(result.refused).toHaveLength(1)
    expect(result.refused![0].reason).toContain('already exists')
  }, 60_000)

  it('says what landed, with the live state, when the model is rate-limited after a change', async () => {
    const { result } = await built.turn(
      [
        classified('MODIFY'),
        toolCall('create_table', { tableName: 'landed_before_limit', columns: [{ name: 'title', type: 'text' }] }),
        ...providerRefusal('rate_limited', 429),
      ],
      'add a landed_before_limit table',
    )

    expect(await built.tableExists('landed_before_limit')).toBe(true)
    expect(result).toMatchObject({ success: false, failureCode: 'RATE_LIMITED', retryable: true })
    expect(result.applied).toHaveLength(1)
    expect(result.summary).toContain('I applied changes')
    expect(result.summary).toContain('landed_before_limit')
  }, 60_000)

  it('reports a model timeout before any change as retryable, with nothing modified', async () => {
    const { result } = await built.turn(
      [classified('MODIFY'), new AiError('timeout', 'timed out', { retryable: true, consumption: 'unknown' })],
      'add a notes table',
    )

    expect(result).toMatchObject({ success: false, failureCode: 'MODEL_TIMEOUT', retryable: true, applied: [], iterations: 0 })
    expect(result.summary).toContain('Nothing was modified')
  }, 60_000)

  it('does not run the loop at all when the classifier\'s call fails: nothing is classified', async () => {
    const { result, provider } = await built.turn(
      providerRefusal('rate_limited', 429),
      'add a notes table',
    )

    expect(provider.calls.length).toBeGreaterThanOrEqual(1)
    expect(result).toMatchObject({ success: false, failureCode: 'RATE_LIMITED', iterations: 0, toolsRun: [] })
    expect(result.classification.reasoning).toContain('not classified')
  }, 60_000)
})
