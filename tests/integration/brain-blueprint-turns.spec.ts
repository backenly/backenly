/**
 * The deterministic blueprint turns of runBrain, whole (#246): the proposal a
 * person reads before "go ahead", the execution that follows it, and what each
 * reports.
 *
 * brain-routing.spec.ts shows which route a turn takes. This one reads what the
 * route does: how every kind of step is grouped on the proposal card, what a
 * run seeds, which step a plan may not run, how the post-build check is
 * reported, and whether the requirements the person wrote are reconciled
 * against what was planned and what was built.
 *
 * Real database: the workspace tables a plan builds and seeds, the pending-plan
 * and resume-queue rows, the conversation. Mocked: the architect (it is a
 * model call with its own validation) and the post-build fix loop (it signs up
 * users against a live runtime, which a test run does not start); each test
 * hands the loop the result it reports.
 */

import { prisma } from '@/lib/db/prisma'
import type { Blueprint, BlueprintStep } from '@/lib/ai/blueprints/types'
import { getBlueprintForPrompt } from '@/lib/ai/blueprints'
import { loadPendingPlan, loadResumeQueue, savePendingPlan } from '@/lib/ai/blueprints/store'
import { runAgenticFixLoop, type FixLoopEvent, type FixLoopResult } from '@/lib/ai/agentic-fix-loop'
import { parseVerificationFence } from '@/lib/ai/verification-evidence'
import { classified, setUpBrainProject } from '../helpers/brain-harness'

jest.mock('@/lib/ai/blueprints', () => {
  const actual = jest.requireActual<typeof import('@/lib/ai/blueprints')>('@/lib/ai/blueprints')
  return { ...actual, getBlueprintForPrompt: jest.fn(actual.getBlueprintForPrompt) }
})
jest.mock('@/lib/ai/agentic-fix-loop', () => ({ runAgenticFixLoop: jest.fn() }))

const architect = getBlueprintForPrompt as jest.MockedFunction<typeof getBlueprintForPrompt>
const fixLoop = runAgenticFixLoop as jest.MockedFunction<typeof runAgenticFixLoop>

const brain = setUpBrainProject({ name: 'brain-blueprint-turns' })

const match = { domain: 'turns-test', confidence: 0.85, matchedOn: 'llm-architect' }
const planWith = (steps: BlueprintStep[], extra: Partial<Blueprint> = {}): Blueprint => ({
  domain: 'turns-test',
  title: 'Turns test backend',
  summary: 'A backend for the turns test.',
  steps,
  ...extra,
})
const createNotes = (table = 'notes'): BlueprintStep => ({
  label: `Create ${table}`,
  tool: 'create_table',
  args: { tableName: table, columns: [{ name: 'title', type: 'text' }] },
})

type Check = { id: string; name: string; passed: boolean; skipped: boolean; skipReason?: string; error?: string; details: string[] }
const check = (name: string, o: Partial<Check> = {}): Check => ({
  id: name, name, passed: true, skipped: false, details: [`${name} evidence`], ...o,
})
const fixResult = (checks: Check[], o: Partial<FixLoopResult> = {}): FixLoopResult => ({
  passed: checks.every((c) => c.skipped || c.passed),
  rounds: 1,
  reason: 'passed',
  appliedFixes: 0,
  summary: 'done',
  finalCheckSnapshot: {
    projectId: 'p', passed: true, checksRun: checks.length, checksSkipped: 0, verdict: 'passed',
    checks, executedAt: '2026-01-01T00:00:00.000Z',
  },
  ...o,
})
const fixLoopReturns = (result: FixLoopResult, events: FixLoopEvent[] = []) =>
  fixLoop.mockImplementation(async (_p, _u, opts) => { events.forEach((e) => opts.emit(e)); return result })

const realArchitect = jest.requireActual<typeof import('@/lib/ai/blueprints')>('@/lib/ai/blueprints').getBlueprintForPrompt

beforeEach(() => {
  // A value a failed test left queued must not answer the next test's call.
  architect.mockReset()
  architect.mockImplementation(realArchitect)
  fixLoop.mockReset()
  fixLoop.mockRejectedValue(new Error('no live runtime in tests'))
})

const everyKindOfStep: BlueprintStep[] = [
  { label: 'Enable end-user auth', tool: 'enable_auth', args: {} },
  { label: 'Teams', tool: 'enable_teams', args: {} },
  createNotes('notes'),
  createNotes('tags'),
  { label: 'API', tool: 'generate_api', args: { tableName: 'notes' } },
  { label: 'RLS add', tool: 'add_rls', args: { tableName: 'notes', policy: 'owner_read_write' } },
  { label: 'RLS set', tool: 'set_rls', args: { tableName: 'tags', policy: 'public_read' } },
  { label: 'Realtime', tool: 'enable_realtime', args: { tableName: 'notes' } },
  { label: 'Trigger', tool: 'create_trigger', args: { tableName: 'notes' } },
  { label: 'Bucket', tool: 'create_bucket', args: { bucketName: 'covers' } },
  { label: 'Bucket default', tool: 'create_bucket', args: {} },
  { label: 'Function', tool: 'generate_function', args: { name: 'welcome' } },
  { label: 'Function default', tool: 'generate_function', args: {} },
  { label: 'Cron', tool: 'create_cron_job', args: { schedule: '0 3 * * *' } },
  { label: 'Cron default', tool: 'create_cron_job', args: {} },
  { label: 'Seed', tool: 'seed_rows', args: { tableName: 'notes', rows: [{ title: 'a' }] } },
  { label: 'Aggregate', tool: 'generate_aggregate_api', args: { name: 'totals' } },
  { label: 'Aggregate default', tool: 'generate_aggregate_api', args: {} },
  { label: 'Something else entirely', tool: 'add_column', args: { tableName: 'notes' } },
]

describe('the proposal card', () => {
  it('groups every kind of step by feature, lists the architect\'s notes, and runs nothing', async () => {
    architect.mockResolvedValueOnce({
      blueprint: planWith(everyKindOfStep, { warnings: ['Realtime is off for tags.'] }),
      match,
      architectTokens: 0,
    })

    const { result, events } = await brain.turn([classified('BUILD')], 'a notes app with auth, tags and a nightly job')
    const card = result.summary

    expect(card).toContain('**Turns test backend**')
    expect(card).toContain('A backend for the turns test.')
    expect(card).toContain('Enable end-user authentication (email + password)')
    expect(card).toContain('Wire up team multi-tenancy (orgs + members + invitations)')
    expect(card).toContain('Create 2 tables: notes, tags')
    expect(card).toContain('Generate REST APIs for 1 tables')
    expect(card).toContain('Apply Row-Level Security to 2 tables')
    expect(card).toContain('Enable realtime change streaming on 1 tables')
    expect(card).toContain('Add notify triggers on 1 write-paths')
    expect(card).toContain('Create storage bucket(s): covers, media')
    expect(card).toContain('Create 2 backend functions (automations): welcome, function')
    expect(card).toContain('Schedule 2 recurring jobs (0 3 * * * · )')
    expect(card).toContain('Seed demo data into 1 table: notes')
    expect(card).toContain('Aggregate stats endpoint /stats/totals')
    expect(card).toContain('Aggregate stats endpoint /stats/summary')
    expect(card).toContain('Something else entirely')
    expect(card).toContain('**Notes**')
    expect(card).toContain('Realtime is off for tags.')
    expect(card).toContain('Reply "go ahead" to run this')

    expect(events).toContainEqual(expect.objectContaining({ type: 'final', needsUser: true, data: expect.objectContaining({ kind: 'blueprint_proposal', stepCount: everyKindOfStep.length }) }))
    expect(await brain.tableExists('notes')).toBe(false)
    expect(await loadPendingPlan(brain.projectId)).toMatchObject({ steps: expect.any(Array) })
  }, 60_000)

  it('says before "go ahead" which of the person\'s own tables the plan leaves out', async () => {
    architect.mockResolvedValueOnce({ blueprint: planWith([createNotes('notes')]), match, architectTokens: 0 })
    const prompt =
      'Create these tables:\n1. notes\n- title\n- body\n2. tags\n- name\n\nWhen a note is created, send the owner a welcome email.'

    const { result } = await brain.turn([classified('BUILD')], prompt)

    expect(result.summary).toContain('**Request coverage (this plan)**')
    expect(result.summary).toContain('1 partial · 2 not covered')
    expect(result.summary).toContain('⚠️ table notes — missing column: body')
    expect(result.summary).toContain('❌ table tags')
    expect(result.summary).toContain('❌ automation')
  }, 60_000)

  it('is saved to the conversation, so the next turn reads it as the plan awaiting "go ahead"', async () => {
    architect.mockResolvedValueOnce({ blueprint: planWith([createNotes('notes')]), match, architectTokens: 0 })
    await brain.turn([classified('BUILD')], 'a notes app')

    const saved = await prisma.conversationMessage.findMany({ where: { projectId: brain.projectId }, orderBy: { createdAt: 'asc' } })
    expect(saved.map((m) => m.role)).toEqual(['user', 'ai'])
    expect(saved[1].content).toContain('Reply "go ahead"')
  }, 60_000)
})

describe('a plan\'s run', () => {
  it('builds a plan proposed in the turn before it: propose, then "go ahead", billed once', async () => {
    architect.mockResolvedValueOnce({ blueprint: planWith([createNotes('notes')]), match, architectTokens: 2000 })
    fixLoopReturns(fixResult([check('Auth flow'), check('CRUD lifecycle')]))

    const proposed = await brain.turn([classified('BUILD')], 'a notes app')
    expect(proposed.result.tokensUsed).toBe(0)

    const built = await brain.turn([classified('CONFIRM')], 'go ahead')

    expect(await brain.tableExists('notes')).toBe(true)
    expect(built.result).toMatchObject({ success: true, toolsRun: ['create_table'], verifiedInline: true })
    expect(built.result.tokensUsed).toBeGreaterThan(2000)
    expect(built.result.summary).toContain('**Backend built.** 1 steps applied.')
    expect(await loadPendingPlan(brain.projectId)).toBeNull()
    // A second "go ahead" has nothing left to run.
    const again = await brain.turn([classified('CONFIRM')], 'go ahead')
    expect(again.result).toMatchObject({ iterations: 0, toolsRun: [] })
  }, 60_000)

  it('seeds the tables it built, reporting a partial seed by its true count and a failed one as failed', async () => {
    await savePendingPlan(
      brain.projectId,
      planWith([
        createNotes('seeded'),
        { label: 'Seed seeded', tool: 'seed_rows', args: { tableName: 'seeded', rows: [{ title: 'one' }, { title: 'two' }] } },
        createNotes('half_seeded'),
        { label: 'Seed half', tool: 'seed_rows', args: { tableName: 'half_seeded', rows: [{ title: 'ok' }, { not_a_column: 'x' }] } },
        { label: 'Seed nowhere', tool: 'seed_rows', args: { tableName: 'no_such_table', rows: [{ title: 'x' }] } },
        { label: 'Seed nothing', tool: 'seed_rows', args: { tableName: 'seeded' } },
      ]),
      match,
      0,
    )

    const { result, events } = await brain.turn([classified('CONFIRM')], 'go ahead')

    const count = async (t: string) =>
      (await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${brain.schema}"."${t}"`))[0].n
    expect(await count('seeded')).toBe(2)
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_done', tool: 'seed_rows', title: 'Seeded 2 rows into seeded' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_fail', tool: 'seed_rows', title: 'Seeding no_such_table failed' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_fail', tool: 'seed_rows', title: 'Seeding seeded failed' }))
    // The half-seeded table is never reported as fully seeded.
    expect(result.success).toBe(false)
    expect(result.summary).toMatch(/steps applied\.\*\* 2 items need a follow-up/)
    const queue = await loadResumeQueue(brain.projectId)
    expect(queue!.steps.map((s) => s.label)).toEqual(expect.arrayContaining(['Seed nowhere', 'Seed nothing']))
  }, 60_000)

  it('does not run a destructive step a plan carries, and queues it as a follow-up', async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${brain.schema}"."precious" (id serial PRIMARY KEY)`)
    await savePendingPlan(
      brain.projectId,
      planWith([
        { label: 'Drop precious', tool: 'drop_table', args: { tableName: 'precious' }, destructive: true },
        createNotes('after_drop'),
      ]),
      match,
      0,
    )

    const { result, events } = await brain.turn([classified('CONFIRM')], 'go ahead')

    expect(await brain.tableExists('precious')).toBe(true)
    // The step after it still runs: one refusal does not abort the plan.
    expect(await brain.tableExists('after_drop')).toBe(true)
    expect(result.toolsRun).toEqual(['create_table'])
    expect(result.success).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_fail', tool: 'drop_table', detail: 'not run' }))
    expect(result.summary).toContain("drop_table needs a human's approval and was not run")
    expect((await loadResumeQueue(brain.projectId))!.steps[0].tool).toBe('drop_table')
  }, 60_000)

  it('keeps a step that fails again in the resume queue after "continue"', async () => {
    const plan = planWith([createNotes('second_pass'), { label: 'Unknown', tool: 'no_such_tool', args: {} }])
    await savePendingPlan(brain.projectId, plan, match, 0)
    const first = await brain.turn([classified('CONFIRM')], 'go ahead')
    expect(first.result.success).toBe(false)
    expect((await loadResumeQueue(brain.projectId))!.steps).toHaveLength(1)

    // "continue" runs the queued step again; it fails again, and stays queued.
    const second = await brain.turn([classified('CONFIRM')], 'continue')
    expect(second.result).toMatchObject({ success: false, tokensUsed: expect.any(Number) })
    expect((await loadResumeQueue(brain.projectId))!.steps).toHaveLength(1)
  }, 60_000)
})

describe('a plan step that throws', () => {
  it('is reported as a follow-up with its message, and the plan goes on', async () => {
    await savePendingPlan(
      brain.projectId,
      planWith([{ label: 'Broken step', tool: 'create_table', args: null as never }, createNotes('after_throw')]),
      match,
      0,
    )

    const { result } = await brain.turn([classified('CONFIRM')], 'go ahead')

    expect(await brain.tableExists('after_throw')).toBe(true)
    expect(result.success).toBe(false)
    expect(result.summary).toContain('Broken step')
    expect((await loadResumeQueue(brain.projectId))!.steps[0].label).toBe('Broken step')
  }, 60_000)
})

describe('stored plans that cannot be used', () => {
  const store = (key: string, value: string) =>
    prisma.projectPreference.upsert({
      where: { projectId_type_key: { projectId: brain.projectId, type: 'pending_plan', key } },
      create: { projectId: brain.projectId, type: 'pending_plan', key, value, confidence: 1 },
      update: { value },
    })

  it.each([
    ['a plan that is not JSON', 'active', 'not json'],
    ['a resume queue that is not JSON', 'resume', '{broken'],
    ['a loop resume point that is not JSON', 'loop_resume', '{broken'],
    ['a loop resume point with no request', 'loop_resume', JSON.stringify({ applied: [], reason: 'r', expiresAt: new Date(Date.now() + 60_000).toISOString() })],
    ['a plan that expired', 'active', JSON.stringify({ ...{ blueprintDomain: 'x', title: 't', match: {}, steps: [createNotes('stale')], createdAt: '2020-01-01T00:00:00Z' }, expiresAt: '2020-01-01T00:30:00Z', architectTokens: 0 })],
    ['a resume queue that expired', 'resume', JSON.stringify({ domain: 'x', reason: 'r', steps: [createNotes('stale')], createdAt: '2020-01-01T00:00:00Z', expiresAt: '2020-01-01T00:30:00Z' })],
  ])('%s is ignored: "go ahead" finds nothing waiting', async (_name, key, value) => {
    await store(key, value)

    const { result, provider } = await brain.turn([classified('CONFIRM')], 'go ahead')

    expect(provider.calls).toHaveLength(1)
    expect(result).toMatchObject({ iterations: 0, toolsRun: [] })
    expect(await brain.tableExists('stale')).toBe(false)
  }, 60_000)

  it('a plan saved before architect tokens were recorded runs, billing only its steps', async () => {
    const plan = {
      blueprintDomain: 'turns-test', title: 't', match, steps: [createNotes('legacy_plan')],
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    await store('active', JSON.stringify(plan))
    fixLoopReturns(fixResult([check('Auth flow')]))

    const { result } = await brain.turn([classified('CONFIRM')], 'go ahead')

    expect(await brain.tableExists('legacy_plan')).toBe(true)
    expect(result.success).toBe(true)
    expect(Number.isFinite(result.tokensUsed)).toBe(true)
  }, 60_000)
})

describe('the post-build check\'s report', () => {
  const run = async () => {
    await savePendingPlan(brain.projectId, planWith([createNotes('checked')]), match, 0)
    return brain.turn([classified('CONFIRM')], 'go ahead')
  }

  it('reports a pass against the live runtime, with the evidence the caller can parse', async () => {
    fixLoopReturns(fixResult([check('Auth flow'), check('CRUD lifecycle'), check('Triggers', { skipped: true, skipReason: 'no triggers' })]))

    const { result } = await run()

    expect(result.summary).toContain('**Verified against the live runtime** · 2/2 checks passed')
    const fence = parseVerificationFence(result.summary)
    expect(fence).toMatchObject({ passed: 2, total: 2 })
    expect(fence!.checks.map((c) => c.status)).toEqual(['passed', 'passed', 'skipped'])
  }, 60_000)

  it('says how many issues were repaired on the way', async () => {
    fixLoopReturns(fixResult([check('Auth flow')], { appliedFixes: 1 }))
    expect((await run()).result.summary).toContain('· 1 issue repaired automatically')
  }, 60_000)

  it('pluralises repairs', async () => {
    fixLoopReturns(fixResult([check('Auth flow')], { appliedFixes: 3 }))
    expect((await run()).result.summary).toContain('· 3 issues repaired automatically')
  }, 60_000)

  it('names the checks still failing, with their errors, and points to the findings queue', async () => {
    fixLoopReturns(fixResult([check('Auth flow'), check('RLS isolation', { passed: false, error: 'user B read user A\'s row' })], { reason: 'max_rounds' }))

    const { result } = await run()

    expect(result.summary).toContain('1/2 runtime checks passed')
    expect(result.summary).toContain('1 still failing')
    expect(result.summary).toContain("• RLS isolation — user B read user A's row")
    expect(result.summary).toContain('tracked as open findings')
    expect(parseVerificationFence(result.summary)!.checks.find((c) => c.name === 'RLS isolation')).toMatchObject({ status: 'failed' })
  }, 60_000)

  it('says the fixes were held, not re-asked, when the project is mid-incident', async () => {
    fixLoopReturns(fixResult([check('RLS isolation', { passed: false, error: 'leak' })], { reason: 'held_for_incident', summary: 'Held: an incident is open.' }))
    const { result } = await run()
    expect(result.summary).toContain('Held: an incident is open.')
    expect(result.summary).not.toContain('tracked as open findings')
  }, 60_000)

  it('says no checks applied, and does not call that a pass, when every check was skipped', async () => {
    fixLoopReturns(fixResult([check('Auth flow', { skipped: true, skipReason: 'no auth' })]))
    const { result } = await run()
    expect(result.summary).toContain('no runtime checks were applicable yet')
    expect(result.summary).not.toContain('Verified against the live runtime')
  }, 60_000)

  it('says the check could not run, and how to ask for it, when the loop fails', async () => {
    const { result } = await run()
    expect(result.summary).toContain('could not run this time')
    expect(result.summary).toContain('say "verify my backend"')
    expect(result.success).toBe(true)
  }, 60_000)

  it('does not run the check at all when no step landed', async () => {
    await savePendingPlan(brain.projectId, planWith([{ label: 'Unknown', tool: 'no_such_tool', args: {} }]), match, 0)

    await brain.turn([classified('CONFIRM')], 'go ahead')

    expect(fixLoop).not.toHaveBeenCalled()
  }, 60_000)

  it('shows the check\'s progress as the turn\'s own events', async () => {
    fixLoopReturns(fixResult([check('Auth flow')]), [
      { type: 'fix_loop_verify_start', round: 0 },
      { type: 'fix_loop_verify_done', round: 0, passed: false, failedChecks: [{ id: 'a', name: 'Auth flow' }, { id: 'b', name: 'CRUD' }], skippedChecks: [] },
      { type: 'fix_loop_fix_start', round: 1, fix: { id: 'f', action: 'x', reason: 'Auth flow was failing because of a missing policy', sourceCheckId: 'a' } },
      { type: 'fix_loop_fix_done', round: 1, fix: { id: 'f', action: 'x', sourceCheckId: 'a' }, success: true, message: 'Added the policy' },
      { type: 'fix_loop_fix_start', round: 1, fix: { id: 'g', action: 'y', reason: 'CRUD', sourceCheckId: 'b' } },
      { type: 'fix_loop_fix_done', round: 1, fix: { id: 'g', action: 'y', sourceCheckId: 'b' }, success: false, message: 'Could not repair' },
      { type: 'fix_loop_verify_start', round: 1 },
      { type: 'fix_loop_verify_done', round: 1, passed: true, failedChecks: [], skippedChecks: [] },
      { type: 'fix_loop_verify_done', round: 2, passed: false, failedChecks: [{ id: 'a', name: 'Auth flow' }], skippedChecks: [] },
    ])

    const { events } = await run()
    const titles = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_done' || e.type === 'tool_fail').map((e) => `${e.type}:${(e as { title: string }).title}`)

    expect(titles).toEqual(expect.arrayContaining([
      'tool_start:Verifying the live backend',
      'tool_done:1 runtime check failing'.replace('1 runtime check', '2 runtime checks'),
      'tool_start:Repairing: Auth flow was failing because of a missing policy',
      'tool_done:Added the policy',
      'tool_fail:Could not repair',
      'tool_start:Re-verifying (round 1)',
      'tool_done:All runtime checks passed',
      'tool_done:1 runtime check failing',
    ]))
  }, 60_000)
})

describe('the requirements a person wrote, reconciled against what was built', () => {
  const prompt =
    'Create these tables:\n1. notes\n- title\n- body\n2. tags\n- name\n\nAlso seed some demo data and add sign up.'

  it('reports the tables and columns that were not built, by name', async () => {
    // The plan builds notes with a title only, and never builds tags.
    architect.mockResolvedValueOnce({ blueprint: planWith([createNotes('notes')]), match, architectTokens: 0 })
    fixLoopReturns(fixResult([check('Auth flow')]))
    await brain.turn([classified('BUILD')], prompt)

    const { result } = await brain.turn([classified('CONFIRM')], 'go ahead')

    expect(result.summary).toContain('**Request coverage** · 0 built · 1 partial · 3 not built')
    expect(result.summary).toContain('⚠️ table notes — missing column: body')
    expect(result.summary).toContain('❌ table tags')
    expect(result.summary).toContain('❌ end-user authentication')
    expect(result.summary).toContain('❌ demo / seed data')
  }, 60_000)

  it('counts a seed that landed as built, and one that did not as missing', async () => {
    architect.mockResolvedValueOnce({
      blueprint: planWith([createNotes('notes'), { label: 'Seed notes', tool: 'seed_rows', args: { tableName: 'notes', rows: [{ title: 'a' }] } }]),
      match,
      architectTokens: 0,
    })
    fixLoopReturns(fixResult([check('Auth flow')]))
    await brain.turn([classified('BUILD')], prompt)

    const { result } = await brain.turn([classified('CONFIRM')], 'go ahead')

    expect(result.summary).toContain('**Request coverage** · 1 built · 1 partial · 2 not built')
    expect(result.summary).toContain('✅ demo / seed data — 1 rows across 1 tables')
    const seeded = (await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${brain.schema}"."notes"`))[0].n
    expect(seeded).toBe(1)
  }, 60_000)

  it('counts a seed that did not land as not built, when the person asked for demo data', async () => {
    architect.mockResolvedValueOnce({
      blueprint: planWith([createNotes('notes'), { label: 'Seed nowhere', tool: 'seed_rows', args: { tableName: 'no_such_table', rows: [{ title: 'a' }] } }]),
      match,
      architectTokens: 0,
    })
    fixLoopReturns(fixResult([check('Auth flow')]))
    await brain.turn([classified('BUILD')], prompt)

    const { result } = await brain.turn([classified('CONFIRM')], 'go ahead')

    expect(result.summary).toContain('❌ demo / seed data')
  }, 60_000)

  it('carries no coverage report when the person wrote nothing to reconcile', async () => {
    architect.mockResolvedValueOnce({ blueprint: planWith([createNotes('notes')]), match, architectTokens: 0 })
    fixLoopReturns(fixResult([check('Auth flow')]))
    await brain.turn([classified('BUILD')], 'a notes app')

    const { result } = await brain.turn([classified('CONFIRM')], 'go ahead')

    expect(result.summary).not.toContain('Request coverage')
  }, 60_000)
})

describe('the architect failing', () => {
  it('falls through to the agent loop on BUILD when it resolves nothing', async () => {
    architect.mockResolvedValueOnce(null)

    const { result, provider } = await brain.turn(
      [classified('BUILD'), { ...classified('BUILD'), content: [{ type: 'text', text: 'I need more detail.' }] } as never],
      'a notes app',
    )

    expect(provider.calls).toHaveLength(2)
    expect(result.toolsRun).toEqual([])
    expect(await loadPendingPlan(brain.projectId)).toBeNull()
  }, 60_000)

  it('falls through to a real clarification on UNCLEAR when it resolves nothing', async () => {
    architect.mockRejectedValueOnce(new Error('architect exploded'))

    const { result, provider } = await brain.turn(
      [classified('UNCLEAR'), { ...classified('UNCLEAR'), content: [{ type: 'text', text: JSON.stringify({ question: 'What should users be able to do?', options: [] }) }] } as never],
      'Users can post recipes with photos and follow each other',
    )

    expect(provider.calls).toHaveLength(2)
    expect(result).toMatchObject({ needsUser: true, toolsRun: ['ask_user'] })
    expect(result.summary).toContain('What should users be able to do?')
  }, 60_000)

  it('asks the architect\'s question when a hedged UNCLEAR description is too vague to design', async () => {
    architect.mockResolvedValueOnce({ vague: true, askUser: 'Which kind of recipes?', architectTokens: 0 })

    const { result } = await brain.turn([classified('UNCLEAR')], 'Users can post recipes with photos and follow each other')

    expect(result).toMatchObject({ needsUser: true, toolsRun: ['ask_user'], classification: { intent: 'BUILD' } })
    expect(result.summary).toContain('Which kind of recipes?')
  }, 60_000)

  it('keeps a plan that failed to save visible and still returns the proposal', async () => {
    const save = jest.spyOn(prisma.projectPreference, 'upsert').mockRejectedValueOnce(new Error('disk full'))
    architect.mockResolvedValueOnce({ blueprint: planWith([createNotes('notes')]), match, architectTokens: 0 })

    const { result } = await brain.turn([classified('BUILD')], 'a notes app')
    save.mockRestore()

    expect(result).toMatchObject({ success: true, needsUser: true, toolsRun: ['propose_plan'] })
  }, 60_000)
})

describe('the architect\'s heartbeat', () => {
  afterEach(() => jest.useRealTimers())

  it('says what it is doing at once, and again every interval while the design runs', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'Date', 'performance', 'queueMicrotask'] })
    let release!: () => void
    architect.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ blueprint: planWith([createNotes('notes')]), match, architectTokens: 0 })
    }))

    const turn = brain.turn([classified('BUILD')], 'a notes app')
    // The turn reaches the architect after real database reads.
    while (!release) await new Promise((r) => setTimeout(r, 5))
    jest.advanceTimersByTime(15_000)
    jest.advanceTimersByTime(15_000)
    release()
    const { events } = await turn

    const thinking = events.filter((e) => e.type === 'thinking').map((e) => (e as { text: string }).text)
    expect(thinking.slice(0, 3)).toEqual([
      'Designing your database schema and table relationships…',
      'Planning REST APIs and row-level security…',
      'Wiring realtime streams, automations, and storage…',
    ])
  }, 60_000)
})
