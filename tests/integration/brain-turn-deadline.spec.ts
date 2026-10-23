/**
 * A TURN STARTS NOTHING ONCE ITS TIME IS UP (#247)
 * ================================================
 * backend_chat answers at its 90-second cap, and the brain used to carry on
 * after that answer. The deadline was read once per agent-loop iteration and
 * nowhere else, so the calls of a model answer that came back late still ran,
 * a blueprint kept building, and the route said "Nothing was applied" with
 * `retryable: true` while a change was landing. Each turn now has one clock
 * (lib/ai/brain/turn-clock.ts):
 *   - a model answer that comes back after the reserve began has none of its
 *     calls run, and the reserve is spent verifying what landed;
 *   - when the caller gives up, the model call in flight is cancelled and
 *     nothing it asked for runs;
 *   - a blueprint starts no step after that, the rest wait in the resume
 *     queue, and the post-build fix loop does not start;
 *   - the architect is cancelled, tries no second design and ends the turn
 *     instead of falling through to the agent loop;
 *   - through the real /api/mcp/chat route, the cap stops the brain, and a
 *     tool still running when it fires is reported as still running, not as
 *     nothing applied, and is left to finish.
 *
 * Real database: the projects, their workspace tables, the plans and queues a
 * blueprint keeps, the change lock. Only the model is scripted, and the clock:
 * Date.now is moved, or the route's own 90-second timer is fired by hand.
 * runBrain is watched, not replaced, so a test can wait for the turn the route
 * stopped answering for to end.
 */

jest.mock('@/lib/ai/brain/agent', () => {
  const actual = jest.requireActual<typeof import('@/lib/ai/brain/agent')>('@/lib/ai/brain/agent')
  return { ...actual, runBrain: jest.fn(actual.runBrain) }
})

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider, type ScriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { creditAccountOf } from '@/lib/usage/account'
import { runBrain, type BrainEvent } from '@/lib/ai/brain/agent'
import { clearResumeQueue, loadPendingPlan, loadResumeQueue, savePendingPlan } from '@/lib/ai/blueprints/store'
import { withChangeLock } from '@/lib/changes/lock'
import { projectToLockKey } from '@/lib/autonomy/maintenance/single-flight'
import { POST } from '@/app/api/mcp/chat/route'

const KEY = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
const brainTurns = runBrain as jest.MockedFunction<typeof runBrain>
/** Spies a test made on the clock or on timers, undone after it. */
const spies: jest.SpyInstance[] = []

let ownerId: string
let projectId: string
let freshProjectId: string
let account: string | null

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

async function backendChat(provider: ScriptedProvider, message: string) {
  setProviderForTests(provider)
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ message }),
  }))
  return { status: res.status, body: (await res.json()) as any }
}

/** The turn the route last started, which goes on after the route has answered. */
const lastTurn = () => brainTurns.mock.results.at(-1)!.value as ReturnType<typeof runBrain>

/**
 * The route's 90-second cap, held instead of armed, so a test fires it at the
 * moment it chooses. Every other timer runs as usual.
 */
function holdRouteCap(): () => void {
  const realSetTimeout = global.setTimeout
  let cap: (() => void) | undefined
  spies.push(jest.spyOn(global, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 90_000 && !cap) {
      cap = () => fn()
      return realSetTimeout(() => {}, 0)
    }
    return realSetTimeout(fn, ms, ...args)
  }) as unknown as typeof setTimeout))
  return () => {
    if (!cap) throw new Error('the route never armed its cap')
    cap()
  }
}

async function waitFor(what: string, check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 15_000
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** A schema change of this project waiting for its change lock. */
async function changeWaitingForTheLock(): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 2 AND objid::bigint = $1::bigint`,
    projectToLockKey(projectId) >>> 0,
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
  freshProjectId = await newProject('brain-turn-deadline-fresh', false)
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: KEY.slice(0, 12), keyHash: hashApiKey(KEY), userId: ownerId, projectId,
      scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })
  account = await creditAccountOf(projectId)
}, 60_000)

beforeEach(async () => {
  setSpendLedgerForTests(memorySpendLedger())
  brainTurns.mockClear()
  // Every turn saves its messages to its project, and past 20 a summary starts
  // without waiting and takes the next test's scripted reply.
  await prisma.conversationMessage.deleteMany({ where: { projectId: { in: [projectId, freshProjectId] } } })
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  for (const id of [projectId, freshProjectId]) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaOf(id)}" CASCADE`).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId: id } }).catch(() => {})
  }
  if (account) {
    await prisma.aiCreditHold.deleteMany({ where: { billingAccountId: account } }).catch(() => {})
    await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: account } }).catch(() => {})
  }
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
        // This answer took the turn past its whole 90-second budget.
        movedBy += 100_000
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
      { projectId, userId: ownerId, message: 'add a clock_on_time table and a clock_late table', deadlineAt: realNow() + 90_000 },
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

  it('cancels the model call in flight when the caller gives up, and runs nothing it asked for', async () => {
    const giveUp = new AbortController()
    let callCancelled: boolean | undefined
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({ toolUse: [createTable('toolu_before', 'gave_up_before')] }),
      (_params, opts) => {
        // backend_chat's cap fires while the model is answering.
        giveUp.abort()
        callCancelled = opts.signal?.aborted
        return scriptedMessage({ toolUse: [createTable('toolu_after', 'gave_up_after')] })
      },
    ])
    setProviderForTests(provider)

    const result = await runBrain(
      { projectId, userId: ownerId, message: 'add the gave_up tables', deadlineAt: Date.now() + 90_000, signal: giveUp.signal },
      () => {},
    )

    expect(callCancelled).toBe(true)
    expect(await tableExists('gave_up_before')).toBe(true)
    expect(await tableExists('gave_up_after')).toBe(false)
    expect(provider.calls).toHaveLength(3)
    expect(result.budgetStopped).toBe(true)
    expect(result.applied).toEqual([expect.stringContaining('gave_up_before')])
  })
})

describe('a confirmed blueprint', () => {
  it('starts no step once the caller gives up, queues the rest for "continue" and runs no fix loop', async () => {
    const step = (tableName: string) => ({ label: `Create ${tableName}`, tool: 'create_table', args: { tableName, columns: COLUMNS } })
    await savePendingPlan(
      projectId,
      { domain: 'custom', title: 'Three tables', summary: 'three tables', steps: [step('plan_first'), step('plan_second'), step('plan_third')] },
      { domain: 'custom', confidence: 1, matchedOn: 'test' },
      0,
    )
    const giveUp = new AbortController()
    const events: BrainEvent[] = []
    const provider = scriptedProvider([classified('CONFIRM')])
    setProviderForTests(provider)

    const result = await runBrain(
      { projectId, userId: ownerId, message: 'go ahead', deadlineAt: Date.now() + 90_000, signal: giveUp.signal },
      (e) => {
        events.push(e)
        // The cap fires as the first step lands.
        if (e.type === 'tool_done' && e.tool === 'create_table') giveUp.abort()
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
    expect(result).toMatchObject({ success: false, budgetStopped: true, applied: ['Create plan_first'], verifiedInline: false })
    expect(result.summary).toMatch(/The time ran out before 2 more could start/)
    expect(result.summary).toMatch(/Reply "continue" to run the 2 remaining steps/)

    await clearResumeQueue(projectId)
  })
})

describe('the architect', () => {
  // Over 500 characters, so the curated templates are skipped and the
  // architect designs it.
  const DESCRIPTION =
    'A backend for a beekeeping co-op. Members register their apiaries and the hives in each one. ' +
    'At every inspection a member records the date, the weather, the queen status, brood frames, ' +
    'signs of disease and the temperament of the colony. Harvests are logged per hive with the ' +
    'weight of honey and wax taken. The co-op runs shared extraction days that members book in ' +
    'advance, and an equipment library from which members borrow extractors, smokers and suits. ' +
    'Treasurers need a monthly summary of harvest weight per member and of equipment loans.'

  it('is cancelled when the caller gives up, tries no second design and does not fall into the agent loop', async () => {
    expect(DESCRIPTION.length).toBeGreaterThan(500)
    const giveUp = new AbortController()
    let designCancelled: boolean | undefined
    const provider = scriptedProvider([
      classified('BUILD'),
      (_params, opts) => {
        giveUp.abort()
        designCancelled = opts.signal?.aborted
        // What a provider throws for a request its signal cancelled.
        throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' })
      },
    ])
    setProviderForTests(provider)

    const result = await runBrain(
      { projectId: freshProjectId, userId: ownerId, message: DESCRIPTION, deadlineAt: Date.now() + 90_000, signal: giveUp.signal },
      () => {},
    )

    expect(designCancelled).toBe(true)
    // The classifier and one design call: no second attempt, no agent loop.
    expect(provider.calls).toHaveLength(2)
    expect(await loadPendingPlan(freshProjectId)).toBeNull()
    expect(result).toMatchObject({ success: false, failureCode: 'MODEL_TIMEOUT', retryable: true, applied: [], toolsRun: [] })
    expect(result.summary).toMatch(/took longer than this request's time limit\. Nothing was modified\./)
  })
})

describe('backend_chat at its 90-second cap', () => {
  it('stops the brain: nothing the model asked for after the cap runs, and the answer lists what did', async () => {
    const fireCap = holdRouteCap()
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({ toolUse: [createTable('toolu_before_cap', 'cap_before')] }),
      () => {
        fireCap()
        return scriptedMessage({ toolUse: [createTable('toolu_after_cap', 'cap_after')] })
      },
    ])

    const { status, body } = await backendChat(provider, 'add a cap_before table and a cap_after table')
    await lastTurn()

    expect(await tableExists('cap_before')).toBe(true)
    expect(await tableExists('cap_after')).toBe(false)
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, partial: true, verified: false, applied: [expect.stringContaining('cap_before')] })
    expect(body.stillRunning).toBeUndefined()
    expect(body.summary).toMatch(/was stopped, so nothing new started after it/)
  })

  it('reports a tool still running at the cap as still running, not as nothing applied, and lets it finish', async () => {
    const fireCap = holdRouteCap()
    // Hold the project's change lock, so the schema change the model asks for
    // waits for it: it has started and not finished when the cap fires. Only a
    // governed change takes the lock, and jest.setup.js turns governance off.
    const engineMode = process.env.ENGINE_MODE
    process.env.ENGINE_MODE = 'runtime'
    let release!: () => void
    let taken!: () => void
    const lockTaken = new Promise<void>((resolve) => (taken = resolve))
    const holding = withChangeLock(projectId, async () => {
      taken()
      await new Promise<void>((resolve) => (release = resolve))
    })
    await lockTaken
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({ toolUse: [createTable('toolu_running', 'cap_running')] }),
      scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'never asked for' } }] }),
    ])

    let status = 0
    let body: any = null
    try {
      const answer = backendChat(provider, 'add a cap_running table')
      await waitFor('create_table to wait for the change lock', changeWaitingForTheLock)
      fireCap()
      ;({ status, body } = await answer)
    } finally {
      release()
      await holding
      await lastTurn()
      process.env.ENGINE_MODE = engineMode
    }

    expect(status).toBe(504)
    expect(body).toMatchObject({
      ok: false,
      code: 'BRAIN_TIMEOUT',
      retryable: false,
      partial: false,
      stillRunning: [expect.stringContaining('cap_running')],
    })
    expect(body.retryAfterMs).toBeUndefined()
    expect(body.error).toMatch(/was still running and was left to finish, so it may take effect/)
    expect(body.error).not.toMatch(/Nothing was applied/)
    // It was left to finish, and nothing started after it: no second step.
    expect(await tableExists('cap_running')).toBe(true)
    expect(provider.calls).toHaveLength(2)
  })
})
