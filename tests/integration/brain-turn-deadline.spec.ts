/**
 * A TURN STARTS NOTHING ONCE ITS TIME IS UP (#247)
 * ================================================
 * A backend_chat request is a run with its own time limit (lib/ai/brain/runs.ts),
 * and the brain keeps a verification reserve at the end of it. The deadline was
 * read once per agent-loop iteration and nowhere else, so the calls of a model
 * answer that came back just before the reserve still ran, and a blueprint kept
 * building, and then ran its post-build fixes, past the limit. Each turn now
 * has one clock (lib/ai/brain/turn-clock.ts):
 *   - a model answer that comes back after the reserve began has none of its
 *     calls run, and the reserve is spent verifying what landed;
 *   - a blueprint starts no step after that, the rest wait in the resume
 *     queue for "continue", and the post-build fix loop does not start.
 *
 * Real database: the project, its workspace tables, the plans and queues a
 * blueprint keeps. Only the model is scripted, and the clock: Date.now is moved.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { runBrain, type BrainEvent } from '@/lib/ai/brain/agent'
import { RUN_LIMITS } from '@/lib/ai/brain/runs'
import { clearResumeQueue, loadPendingPlan, loadResumeQueue, savePendingPlan } from '@/lib/ai/blueprints/store'

/** Spies a test made on the clock, undone after it. */
const spies: jest.SpyInstance[] = []

let ownerId: string
let projectId: string

const schemaOf = (id: string) => `workspace_${id}`
const COLUMNS = [{ name: 'label', type: 'text' }]

const classified = (intent: string) =>
  scriptedMessage({ text: JSON.stringify({ intent, confidence: 0.9, reasoning: 'scripted' }) })

const createTable = (id: string, tableName: string) => ({ id, name: 'create_table', input: { tableName, columns: COLUMNS } })

async function tableExists(name: string, id = projectId): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    schemaOf(id),
    name,
  )
  return rows[0].n > 0
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    schemaOf(projectId),
    table,
    column,
  )
  return rows[0].n > 0
}

async function newProject(name: string, withTable: boolean): Promise<string> {
  const id = (await prisma.project.create({ data: { name, userId: ownerId } })).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaOf(id)}"`)
  if (withTable) await prisma.$executeRawUnsafe(`CREATE TABLE "${schemaOf(id)}"."notes" (id serial PRIMARY KEY, body text)`)
  return id
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `brain-deadline-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'brain' },
  })).id
  projectId = await newProject('brain-turn-deadline', true)
}, 60_000)

beforeEach(async () => {
  setSpendLedgerForTests(memorySpendLedger())
  // Every turn saves its messages to its project, and past 20 a summary starts
  // without waiting and takes the next test's scripted reply.
  await prisma.conversationMessage.deleteMany({ where: { projectId } })
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaOf(projectId)}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('the agent loop', () => {
  it('runs none of the calls in a model answer that came back after the reserve began', async () => {
    const realNow = Date.now.bind(Date)
    let movedBy = 0
    spies.push(jest.spyOn(Date, 'now').mockImplementation(() => realNow() + movedBy))
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({ toolUse: [createTable('toolu_on_time', 'clock_on_time')] }),
      () => {
        // This answer took the turn past its run's whole time limit.
        movedBy += RUN_LIMITS.maxMs + 10_000
        return scriptedMessage({
          toolUse: [
            createTable('toolu_late', 'clock_late'),
            { id: 'toolu_late_column', name: 'add_column', input: { tableName: 'notes', columnName: 'late', columnType: 'text' } },
          ],
        })
      },
    ])
    setProviderForTests(provider)

    const result = await runBrain(
      { projectId, userId: ownerId, message: 'add a clock_on_time table and a clock_late table', deadlineAt: realNow() + RUN_LIMITS.maxMs },
      () => {},
    )

    expect(await tableExists('clock_on_time')).toBe(true)
    expect(await tableExists('clock_late')).toBe(false)
    expect(await columnExists('notes', 'late')).toBe(false)
    // The classifier and two steps: nothing was asked of the model after the stop.
    expect(provider.calls).toHaveLength(3)
    expect(result.budgetStopped).toBe(true)
    expect(result.toolsRun).toEqual(['create_table'])
    expect(result.applied).toEqual([expect.stringContaining('clock_on_time')])
    expect(result.summary).toMatch(/Not started, because the time ran out \(2\): [^\n]*clock_late/)
  })
})

describe('a confirmed blueprint', () => {
  it('starts no step once the time is up, queues the rest for "continue" and runs no fix loop', async () => {
    const step = (tableName: string) => ({ label: `Create ${tableName}`, tool: 'create_table', args: { tableName, columns: COLUMNS } })
    await savePendingPlan(
      projectId,
      { domain: 'custom', title: 'Three tables', summary: 'three tables', steps: [step('plan_first'), step('plan_second'), step('plan_third')] },
      { domain: 'custom', confidence: 1, matchedOn: 'test' },
      0,
    )
    const realNow = Date.now.bind(Date)
    let movedBy = 0
    spies.push(jest.spyOn(Date, 'now').mockImplementation(() => realNow() + movedBy))
    const events: BrainEvent[] = []
    const provider = scriptedProvider([classified('CONFIRM')])
    setProviderForTests(provider)

    const result = await runBrain(
      { projectId, userId: ownerId, message: 'go ahead', deadlineAt: realNow() + RUN_LIMITS.maxMs },
      (e) => {
        events.push(e)
        // The first step took the run past its time limit.
        if (e.type === 'tool_done' && e.tool === 'create_table') movedBy = RUN_LIMITS.maxMs
      },
    )

    expect(await tableExists('plan_first')).toBe(true)
    expect(await tableExists('plan_second')).toBe(false)
    expect(await tableExists('plan_third')).toBe(false)
    expect((await loadResumeQueue(projectId))?.steps.map((s) => s.label)).toEqual(['Create plan_second', 'Create plan_third'])
    expect(await loadPendingPlan(projectId)).toBeNull()
    // The fix loop reports its first live check as run_test starting.
    expect(events.some((e) => e.type === 'tool_start' && e.tool === 'run_test')).toBe(false)
    expect(provider.calls).toHaveLength(1)
    expect(result).toMatchObject({
      success: false,
      budgetStopped: true,
      applied: ['Create plan_first'],
      verifiedInline: false,
      next: { tool: 'backend_chat', arguments: { message: 'continue' } },
    })
    expect(result.summary).toMatch(/The time ran out before 2 more could start/)
    expect(result.summary).toMatch(/Reply "continue" to run the 2 remaining steps/)

    await clearResumeQueue(projectId)
  })
})
