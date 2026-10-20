/**
 * A turn reports as changed only what changed.
 *
 * The loop counts a call as a mutation unless it is a read, and a mutation is
 * listed in the turn's `applied`, which an agent reads as "this changed", and
 * sends a later finish back for a verification pass. A read counted that way
 * was reported as a change that never happened and verified for nothing: a
 * list_synced_columns read and a dry-run data migration both came back in
 * `applied` (#229). The other way round, a readiness call that applied fixes
 * was counted as a read, so its changes were missing from `applied` and never
 * verified (#240).
 *
 * Real database: the project, its workspace schema, the rows a dry run must
 * leave as they were and the JWT secret a readiness fix generates. Only the
 * model is scripted, as in brain-on-gateway.spec.ts, and spend reservations go
 * to the gateway's in-memory ledger for the reason given there.
 */

import crypto from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/db/prisma'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider, type ScriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { runBrain } from '@/lib/ai/brain/agent'

let ownerId: string
let projectId: string
let schema: string

const classified = (intent: string) =>
  scriptedMessage({ text: JSON.stringify({ intent, confidence: 0.9, reasoning: 'scripted' }) })

async function turn(provider: ScriptedProvider, message: string) {
  setProviderForTests(provider)
  return runBrain({ projectId, userId: ownerId, message }, () => {})
}

/** What the model was told one call returned, from the step that answered it. */
function answerTo(provider: ScriptedProvider, step: number, toolUseId: string) {
  const blocks = provider.calls[step].params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
  const block = blocks.find((b) => b.tool_use_id === toolUseId)!
  return JSON.parse(block.content as string) as { ok: boolean; summary: string }
}

async function statuses(): Promise<Array<string | null>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ status: string | null }>>(
    `SELECT status FROM "${schema}"."accounts" ORDER BY id`,
  )
  return rows.map((r) => r.status)
}

/** The project's own JWT secret, which a readiness fix generates when it is missing. */
async function jwtSecret(): Promise<string | null> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { jwtSecret: true } })
  return project.jwtSecret
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `brain-accounting-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'brain' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'brain-mutation-accounting', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."accounts" (id serial PRIMARY KEY, status text)`)
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."accounts" (status) VALUES ('active'), (NULL), (NULL)`)
}, 60_000)

beforeEach(async () => {
  setSpendLedgerForTests(memorySpendLedger())
  // Each test starts with no history: past 20 saved messages a summary starts
  // without waiting, and its model call would take a scripted reply.
  await prisma.conversationMessage.deleteMany({ where: { projectId } })
})

afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.aiUsage.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('what a turn reports as applied', () => {
  it('does not report listing the derived columns as a change, or verify it', async () => {
    const provider = scriptedProvider([
      classified('QUESTION'),
      scriptedMessage({ toolUse: [{ id: 'toolu_list', name: 'list_synced_columns', input: {} }] }),
      scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'No derived columns are maintained.' } }] }),
    ])

    const result = await turn(provider, 'which columns are kept in sync for me?')

    expect(answerTo(provider, 2, 'toolu_list')).toMatchObject({ ok: true })
    expect(result).toMatchObject({
      success: true,
      summary: 'No derived columns are maintained.',
      toolsRun: ['list_synced_columns', 'finish'],
      applied: [],
    })
    // The finish was accepted as it came: no verification pass was asked for.
    expect(provider.calls).toHaveLength(3)
  }, 60_000)

  it('does not report a dry-run data migration as a change, and the dry run changes nothing', async () => {
    const backfill = { op: 'backfill', table: 'accounts', column: 'status', value: 'active', onlyNull: true }
    const provider = scriptedProvider([
      classified('MODIFY'),
      scriptedMessage({
        toolUse: [{ id: 'toolu_dry', name: 'run_data_migration', input: { operations: [backfill], dryRun: true } }],
      }),
      scriptedMessage({
        toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'The backfill would set 2 of 3 accounts to active. Nothing has changed yet.' } }],
      }),
    ])

    const result = await turn(provider, 'dry-run a backfill of the empty account statuses to active')

    // The dry run ran against the real table and said what it would do.
    const answer = answerTo(provider, 2, 'toolu_dry')
    expect(answer).toMatchObject({ ok: true })
    expect(answer.summary).toMatch(/^Dry run — no data was changed/)
    expect(answer.summary).toContain('**2** of 3 rows')
    expect(await statuses()).toEqual(['active', null, null])

    expect(result).toMatchObject({
      success: true,
      summary: 'The backfill would set 2 of 3 accounts to active. Nothing has changed yet.',
      toolsRun: ['run_data_migration', 'finish'],
      applied: [],
    })
    expect(result.refused).toBeUndefined()
    expect(provider.calls).toHaveLength(3)
  }, 60_000)

  it('does not report reading the readiness scorecard as a change, and the read fixes nothing', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { jwtSecret: null } })
    const provider = scriptedProvider([
      classified('QUESTION'),
      scriptedMessage({ toolUse: [{ id: 'toolu_ready', name: 'get_readiness', input: {} }] }),
      scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'Not ready yet: see the blockers.' } }] }),
    ])

    const result = await turn(provider, 'is my backend ready to deploy?')

    expect(answerTo(provider, 2, 'toolu_ready')).toMatchObject({ ok: true })
    expect(await jwtSecret()).toBeNull()
    expect(result).toMatchObject({ success: true, toolsRun: ['get_readiness', 'finish'], applied: [] })
    expect(provider.calls).toHaveLength(3)
  }, 120_000)

  it('reports a readiness call that applies the safe fixes as a change, and verifies it', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { jwtSecret: null } })
    const provider = scriptedProvider([
      classified('FIX'),
      scriptedMessage({ toolUse: [{ id: 'toolu_fix', name: 'get_readiness', input: { autoFix: true } }] }),
      scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'Applied the safe fixes.' } }] }),
      scriptedMessage({ toolUse: [{ id: 'toolu_verify', name: 'read_backend_state', input: {} }] }),
      scriptedMessage({ toolUse: [{ id: 'toolu_done', name: 'finish', input: { summary: 'Applied the safe fixes and read the state back.' } }] }),
    ])

    const result = await turn(provider, 'apply the safe readiness fixes')

    // The fix landed: the project has its own JWT secret now.
    expect(await jwtSecret()).toEqual(expect.any(String))
    expect(result).toMatchObject({
      success: true,
      summary: 'Applied the safe fixes and read the state back.',
      toolsRun: ['get_readiness', 'finish', 'read_backend_state', 'finish'],
      applied: ['Applying the safe readiness fixes'],
    })
    // The first finish was sent back for the verification pass a change needs.
    expect(provider.calls).toHaveLength(5)
    expect(provider.calls[3].params.messages.at(-1)!.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('did not verify') })]),
    )
  }, 120_000)
})
