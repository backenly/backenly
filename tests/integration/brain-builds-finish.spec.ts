/**
 * A build asked of backend_chat runs to the end, or names the call that carries
 * it on.
 *
 * A coding agent that asked backend_chat for an e-commerce backend came back
 * with two tables of a dozen. The loop spent its 90 s wall clock on one table
 * per model call, after first proposing a plan that built nothing, and followed
 * every table with a generate_api that changes nothing; it then stopped with
 * "say continue" in its prose and was reported `ok: true, partial: true`. On a
 * protected production every table a plan asked for was refused, leaving a
 * resume queue "continue" could only refuse again. A resumed plan refused the
 * tables its first run made, so "continue" never finished, and a design that
 * outlasted its call was started again on every retry.
 *
 * Real brain, dispatcher, executor and database; only the model is scripted.
 * Mocked: the architect (a model call with its own validation) and the
 * post-build fix loop (it signs users up against a live runtime).
 */
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})
jest.mock('@/lib/ai/blueprints', () => {
  const actual = jest.requireActual<typeof import('@/lib/ai/blueprints')>('@/lib/ai/blueprints')
  return { ...actual, getBlueprintForPrompt: jest.fn(actual.getBlueprintForPrompt) }
})
jest.mock('@/lib/ai/blueprints/architect', () => ({ architectBackend: jest.fn(async () => null) }))
jest.mock('@/lib/ai/agentic-fix-loop', () => ({ runAgenticFixLoop: jest.fn() }))

import { prisma } from '@/lib/db/prisma'
import { scriptedMessage } from '@/lib/ai/llm/providers/scripted'
import { getBlueprintForPrompt } from '@/lib/ai/blueprints'
import { architectBackend } from '@/lib/ai/blueprints/architect'
import { designInProgress, loadResumeQueue, markDesigning, savePendingPlan, saveResumeQueue } from '@/lib/ai/blueprints/store'
import type { BlueprintStep } from '@/lib/ai/blueprints/types'
import { runAgenticFixLoop, type FixLoopResult } from '@/lib/ai/agentic-fix-loop'
import { loadLoopResume, saveLoopResume } from '@/lib/ai/brain/loop-resume'
import { forgetProtection } from '@/lib/branches/protection'
import { classified, finished, setUpBrainProject, systemOf, toolCall } from '../helpers/brain-harness'

const blueprints = getBlueprintForPrompt as jest.MockedFunction<typeof getBlueprintForPrompt>
const designer = architectBackend as jest.MockedFunction<typeof architectBackend>
const fixLoop = runAgenticFixLoop as jest.MockedFunction<typeof runAgenticFixLoop>

const built = setUpBrainProject({ name: 'builds-finish-built', tables: ['keep_me'] })
const fresh = setUpBrainProject({ name: 'builds-finish-fresh' })

const CONTINUE = { tool: 'backend_chat', arguments: { message: 'continue' } }
const GO_AHEAD = { tool: 'backend_chat', arguments: { message: 'go ahead' } }
/** The door every brain turn arrives through in production: it is what the protection gate keys on. */
const MCP = { door: 'mcp' as const }
const APP = 'A recipe app where home cooks share recipes, follow each other and rate the dishes they cooked.'

const createStep = (table: string): BlueprintStep => ({
  label: `Create ${table}`,
  tool: 'create_table',
  args: { tableName: table, columns: [{ name: 'title', type: 'text' }] },
})
const createNotes = (table: string) =>
  toolCall('create_table', { tableName: table, columns: [{ name: 'title', type: 'text' }] }, `toolu_${table}`)

const verified: FixLoopResult = {
  passed: true,
  rounds: 1,
  reason: 'passed',
  appliedFixes: 0,
  summary: 'done',
  finalCheckSnapshot: {
    projectId: 'p', passed: true, checksRun: 0, checksSkipped: 0, verdict: 'passed',
    checks: [], executedAt: '2026-01-01T00:00:00.000Z',
  },
} as unknown as FixLoopResult

async function tablesOf(schema: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1`,
    schema,
  )
  return rows.map((r) => r.table_name)
}

beforeEach(() => {
  blueprints.mockClear()
  designer.mockReset()
  designer.mockImplementation(async () => null)
  fixLoop.mockReset()
  fixLoop.mockResolvedValue(verified)
})
afterEach(() => jest.restoreAllMocks())

describe('the loop is told to build a request whole, in a few responses', () => {
  it('builds without proposing a plan, several calls per response, and nothing after create_table', async () => {
    const { provider } = await built.turn([classified('BUILD'), finished('Done.')], 'build an online store')
    const system = systemOf(provider, 1)

    expect(system).toContain('Build it now, without proposing a plan first')
    expect(system).toContain('Put independent changes in the SAME response as parallel tool calls')
    expect(system).toContain('Do not follow it with generate_api')
    expect(system).not.toContain('call propose_plan FIRST')
    expect(system).not.toContain('one logical change per call')
  }, 60_000)

  it('a resumed build is carried out several calls at a time, from the state it is handed', async () => {
    await saveLoopResume(built.projectId, 'build the store', ['Creating table products'], 'time_budget')

    const { provider } = await built.turn([classified('CONFIRM'), finished('Done.')], 'continue')

    expect(systemOf(provider, 1)).toContain('several calls per response in dependency order')
    expect(systemOf(provider, 1)).not.toContain('one by one')
    // The live state is in its context already: a read to start with spent a step.
    const sent = JSON.stringify(provider.calls[1].params.messages)
    expect(sent).toContain('The live backend state is given to you above')
    expect(sent).not.toContain('Read the live backend state')
  }, 60_000)

  it('creates every table of one response, parents first, in a single model step', async () => {
    const { result, provider } = await built.turn(
      [
        classified('BUILD'),
        scriptedMessage({
          toolUse: [
            { id: 'toolu_categories', name: 'create_table', input: { tableName: 'categories', columns: [{ name: 'name', type: 'text' }] } },
            { id: 'toolu_products', name: 'create_table', input: { tableName: 'products', columns: [{ name: 'name', type: 'text' }, { name: 'category_id', type: 'uuid', fkTo: 'categories' }] } },
            { id: 'toolu_reviews', name: 'create_table', input: { tableName: 'reviews', columns: [{ name: 'rating', type: 'int' }, { name: 'product_id', type: 'uuid', fkTo: 'products' }] } },
          ],
        }),
        toolCall('read_backend_state', {}, 'toolu_read'),
        finished('Built the store.'),
      ],
      'build an online store with categories, products and reviews',
    )

    expect(result).toMatchObject({ success: true })
    expect(result.applied).toHaveLength(3)
    for (const table of ['categories', 'products', 'reviews']) expect(await built.tableExists(table)).toBe(true)
    // The classifier, ONE building step, the verification read and finish.
    expect(provider.calls).toHaveLength(4)
    expect(result.next).toBeUndefined()
  }, 60_000)
})

describe('a build that stops early names the call that carries it on', () => {
  it('a stop at the wall clock, after changes, returns next: continue with the resume point saved', async () => {
    const deadlineAt = Date.now() + 60_000
    // The answer after the first table comes back past the deadline: none of its calls run.
    const pastTheDeadline = () => {
      jest.spyOn(Date, 'now').mockReturnValue(deadlineAt + 3_600_000)
      return createNotes('too_late')
    }

    const { result } = await built.turn([classified('BUILD'), createNotes('landed_in_time'), pastTheDeadline], 'build the store', { deadlineAt })

    expect(result).toMatchObject({ budgetStopped: true, verified: true, next: CONTINUE })
    expect(result.next!.why).toContain('not finished')
    expect(await built.tableExists('landed_in_time')).toBe(true)
    expect(await built.tableExists('too_late')).toBe(false)
    expect((await loadLoopResume(built.projectId))!.applied).toHaveLength(1)
  }, 60_000)

  it('a stop at the step budget returns next: continue', async () => {
    const reads = Array.from({ length: 12 }, (_, i) => toolCall('read_backend_state', {}, `toolu_read_${i}`))
    const { result } = await built.turn([classified('MODIFY'), ...reads], 'tidy up the schema')

    expect(result).toMatchObject({ success: false, failureCode: 'STEP_BUDGET_EXHAUSTED', next: CONTINUE })
    expect(await loadLoopResume(built.projectId)).not.toBeNull()
  }, 60_000)

  it('a turn that finished names no next call', async () => {
    const { result } = await built.turn(
      [classified('BUILD'), createNotes('finished_table'), toolCall('read_backend_state', {}, 'toolu_read'), finished('Done.')],
      'add a table',
    )
    expect(result.success).toBe(true)
    expect(result.next).toBeUndefined()
  }, 60_000)
})

describe('a plan run again finishes', () => {
  it('counts a table an earlier run made as done, so "continue" converges', async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${built.schema}"."notes" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text)`)
    await saveResumeQueue(built.projectId, 'turns-test', [createStep('notes'), createStep('tags')], 'second pass')

    const { result } = await built.turn([classified('CONFIRM')], 'continue')

    expect(result.success).toBe(true)
    expect(result.summary).toContain('**Backend built.** 2 steps applied.')
    // Only the table that was missing ran, and only it is billed.
    expect(result.toolsRun).toEqual(['create_table'])
    expect(await built.tableExists('tags')).toBe(true)
    expect(await loadResumeQueue(built.projectId)).toBeNull()
    expect(result.next).toBeUndefined()
  }, 60_000)

  it('still names next: continue when a step failed while others moved the plan on', async () => {
    const broken: BlueprintStep = { label: 'Unknown', tool: 'no_such_tool', args: {} }
    await saveResumeQueue(built.projectId, 'turns-test', [createStep('tags'), broken], 'second pass')

    const { result } = await built.turn([classified('CONFIRM')], 'continue')

    expect(result.success).toBe(false)
    expect(result.next).toMatchObject(CONTINUE)
    expect((await loadResumeQueue(built.projectId))!.steps).toEqual([broken])
  }, 60_000)

  it('stops offering "continue" for steps that failed again the same way, so an agent cannot loop on them', async () => {
    const broken: BlueprintStep = { label: 'Unknown', tool: 'no_such_tool', args: {} }
    await saveResumeQueue(built.projectId, 'turns-test', [broken], 'second pass')

    const { result } = await built.turn([classified('CONFIRM')], 'continue')

    expect(result.success).toBe(false)
    expect(result.next).toBeUndefined()
    expect(result.summary).toContain('failed again on a second pass')
    expect(result.summary).not.toContain('Reply "continue"')
    expect(await loadResumeQueue(built.projectId)).toBeNull()
  }, 60_000)

  it('a resumed loop turn that changed nothing is not offered another "continue"', async () => {
    await saveLoopResume(built.projectId, 'build the store', ['Creating table products'], 'time_budget')

    const { result } = await built.turn([classified('CONFIRM')], 'continue', { deadlineAt: Date.now() + 5_000 })

    expect(result).toMatchObject({ budgetStopped: true, applied: [] })
    expect(result.next).toBeUndefined()
  }, 60_000)
})

describe('on a protected production', () => {
  const edition = process.env.BACKENLY_EDITION
  beforeAll(async () => {
    process.env.BACKENLY_EDITION = 'cloud'
    await prisma.project.updateMany({ where: { id: { in: [built.projectId, fresh.projectId] } }, data: { protectedProduction: true } })
    forgetProtection()
  })
  afterAll(async () => {
    if (edition === undefined) delete process.env.BACKENLY_EDITION
    else process.env.BACKENLY_EDITION = edition
    await prisma.project.updateMany({ where: { id: { in: [built.projectId, fresh.projectId] } }, data: { protectedProduction: false } })
    forgetProtection()
  })

  it('a build of a new project says how its schema reaches production, and designs and runs nothing', async () => {
    const { result, provider } = await fresh.turn([classified('BUILD')], 'Build an e-commerce store backend.', MCP)

    expect(provider.calls).toHaveLength(1)
    expect(blueprints).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, failureCode: 'BRANCH_REQUIRED', retryable: false, applied: [] })
    expect(result.next).toMatchObject({ tool: 'branch', arguments: { action: 'create' } })
    expect(result.summary).toContain('apply_migration { "sql"')
    expect(result.summary).toContain('branch { "action": "merge"')
    // A curated design, found without a model call, is offered as a start.
    expect(result.summary).toMatch(/A data model to start from: .*products.*orders/)
    expect(await tablesOf(fresh.schema)).toEqual([])
  }, 60_000)

  it('a plan saved before production was protected is not run into the gate', async () => {
    // Run, every table step of it would be refused, and every step on those tables would fail after it.
    await savePendingPlan(
      fresh.projectId,
      {
        domain: 'turns-test', title: 'Notes', summary: 'Notes.',
        steps: [createStep('notes'), { label: 'Generate REST API for notes', tool: 'generate_api', args: { tableName: 'notes' } }],
      },
      { domain: 'turns-test', confidence: 0.85, matchedOn: 'llm-architect' },
      0,
    )

    const { result } = await fresh.turn([classified('CONFIRM')], 'go ahead', MCP)

    expect(result.failureCode).toBe('BRANCH_REQUIRED')
    expect(result.summary).toContain('A data model to start from: notes')
    expect(await tablesOf(fresh.schema)).toEqual([])
  }, 60_000)

  it('the loop is told up front which calls are refused here', async () => {
    const { provider } = await built.turn([classified('MODIFY'), finished('Done.')], 'add a comments table', MCP)
    expect(systemOf(provider, 1)).toContain('PRODUCTION IS PROTECTED on this project: create_table, add_column')
  }, 60_000)
})

describe('a design still running', () => {
  it('a build that arrives meanwhile says it is still designing, and starts no second design', async () => {
    await markDesigning(fresh.projectId)

    const { result } = await fresh.turn([classified('BUILD')], APP)

    expect(blueprints).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: true, inProgress: 'designing', next: GO_AHEAD })
    expect(result.next!.afterMs).toBe(60_000)
  }, 60_000)

  it('a "go ahead" before the plan exists waits for it, rather than saying nothing is waiting', async () => {
    await markDesigning(fresh.projectId)

    const { result } = await fresh.turn([classified('CONFIRM')], 'go ahead')

    expect(blueprints).not.toHaveBeenCalled()
    expect(result).toMatchObject({ inProgress: 'designing', next: GO_AHEAD })
    expect(result.summary).not.toContain('nothing waiting')
  }, 60_000)

  it('is marked while the architect runs, cleared after, and announced as the design phase', async () => {
    let during: boolean | null = null
    designer.mockImplementation(async (_prompt, projectId) => {
      during = await designInProgress(projectId)
      return null
    })
    const announced: string[] = []

    await getBlueprintForPrompt(APP, fresh.projectId, () => announced.push('design'))

    expect(during).toBe(true)
    expect(announced).toEqual(['design'])
    expect(await designInProgress(fresh.projectId)).toBe(false)
  }, 60_000)

  it('a curated design runs no architect, so it is never marked', async () => {
    const announced: string[] = []
    await getBlueprintForPrompt('Build an e-commerce store backend.', fresh.projectId, () => announced.push('design'))
    expect(designer).not.toHaveBeenCalled()
    expect(announced).toEqual([])
  }, 60_000)
})
