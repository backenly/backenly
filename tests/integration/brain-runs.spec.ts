/**
 * A backend_chat request is a run that outlives its call (lib/ai/brain/runs.ts).
 *
 * A turn used to live inside one call with a 90 s wall clock, and a whole
 * backend did not fit: the build stopped after two or three tables. Now the
 * call waits a while, and a request still going then answers `status:
 * "running"` and keeps going; "status", check_approval and any message sent
 * meanwhile collect its result. These hold that to the real route, the real
 * run records and a real database. Only the brain is a stub, so each test
 * decides when a turn ends and what it applied.
 */
jest.mock('@/lib/ai/brain/agent', () => ({ runBrain: jest.fn() }))
jest.mock('@/lib/platform-controls', () => ({ assertAiAllowed: jest.fn(async () => ({ ok: true })) }))
jest.mock('@/lib/entitlements/policy', () => ({ enforceAiCredits: jest.fn(async () => true) }))
jest.mock('@/lib/entitlements/credit-holds', () => ({ closeCreditTurn: jest.fn(async () => {}) }))
jest.mock('@/lib/usage/account', () => ({ creditAccountOf: jest.fn(async () => 'account-1') }))
jest.mock('@/lib/data-plane/residency', () => {
  const actual = jest.requireActual('@/lib/data-plane/residency')
  return { ...actual, quotesKeptHere: jest.fn(actual.quotesKeptHere) }
})
jest.mock('@/lib/data-plane/regional-bodies', () => {
  const actual = jest.requireActual('@/lib/data-plane/regional-bodies')
  return { ...actual, regionalBodiesFor: jest.fn(actual.regionalBodiesFor) }
})
jest.mock('@/lib/mcp/approvals', () => {
  const actual = jest.requireActual('@/lib/mcp/approvals')
  return { ...actual, createApprovalRequest: jest.fn(async () => ({ id: 'apr-test-1' })) }
})

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { runBrain, type BrainEvent, type BrainResult } from '@/lib/ai/brain/agent'
import { enforceAiCredits } from '@/lib/entitlements/policy'
import { closeCreditTurn } from '@/lib/entitlements/credit-holds'
import { quotesKeptHere } from '@/lib/data-plane/residency'
import { regionalBodiesFor, type RegionalBodies } from '@/lib/data-plane/regional-bodies'
import { loadLoopResume } from '@/lib/ai/brain/loop-resume'
import { setRunLimitsForTests } from '@/lib/ai/brain/runs'
import { POST as chatRoute } from '@/app/api/mcp/chat/route'
import { POST as toolRoute } from '@/app/api/mcp/tool/route'

const brain = runBrain as jest.MockedFunction<typeof runBrain>
const credits = enforceAiCredits as jest.MockedFunction<typeof enforceAiCredits>
const charge = closeCreditTurn as jest.MockedFunction<typeof closeCreditTurn>
const residentHere = quotesKeptHere as jest.MockedFunction<typeof quotesKeptHere>
const bodiesFor = regionalBodiesFor as jest.MockedFunction<typeof regionalBodiesFor>

let ownerId: string
let projectId: string
let keyId: string
let mcpKey: string

async function chat(message: string) {
  const res = await chatRoute(new NextRequest('https://backenly.test/api/mcp/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
    body: JSON.stringify({ message }),
  }))
  return { status: res.status, body: await res.json() as any }
}

async function checkApproval(id: string) {
  const res = await toolRoute(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
    body: JSON.stringify({ tool: 'check_approval', args: { id } }),
  }))
  return { status: res.status, body: await res.json() as any }
}

const turn = (o: Partial<BrainResult> = {}): BrainResult => ({
  success: true,
  summary: 'Done.',
  needsUser: false,
  iterations: 1,
  toolsRun: ['create_table'],
  classification: { intent: 'BUILD', confidence: 0.9, reasoning: 'stub' },
  tokensUsed: 0,
  ...o,
})
const landed = (title: string): BrainEvent => ({ type: 'tool_done', tool: 'create_table', title })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** Wait until no run of this project is going, so no turn outlives its test. */
async function settled(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const n = await prisma.backgroundJob.count({ where: { projectId, type: 'brain_run', status: 'brain_running' } })
    if (n === 0) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('a run did not finish')
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `brain-runs-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'brain-runs', userId: ownerId } })).id
  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  keyId = (await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })).id
}, 60_000)

beforeEach(() => {
  setRunLimitsForTests({ syncWaitMs: 300, heartbeatMs: 50, staleMs: 400, pollMs: 20 })
  brain.mockReset()
  charge.mockClear()
  credits.mockResolvedValue(true)
})

afterEach(async () => {
  await settled()
  setRunLimitsForTests(null)
  residentHere.mockImplementation(jest.requireActual('@/lib/data-plane/residency').quotesKeptHere)
  bodiesFor.mockImplementation(jest.requireActual('@/lib/data-plane/regional-bodies').regionalBodiesFor)
  await prisma.backgroundJob.deleteMany({ where: { projectId, type: 'brain_run' } })
  await prisma.projectPreference.deleteMany({ where: { projectId } })
  await prisma.conversationMessage.deleteMany({ where: { projectId } })
})

afterAll(async () => {
  await prisma.apiKeyUsage.deleteMany({ where: { apiKeyId: keyId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('a request that finishes inside the window', () => {
  it('answers in one call with its result, and its run is recorded and heard', async () => {
    brain.mockImplementation(async (_input, emit) => {
      emit(landed('Creating table notes'))
      return turn({ applied: ['Creating table notes'] })
    })

    const { status, body } = await chat('add a notes table')

    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, applied: ['Creating table notes'], run: { status: 'completed' } })
    const row = await prisma.backgroundJob.findUnique({ where: { id: body.run.id } })
    expect(row).toMatchObject({ type: 'brain_run', status: 'completed' })
    expect(row!.payload).toMatchObject({ delivered: true, appliedCount: 1, request: 'add a notes table' })
  }, 30_000)
})

describe('a request that outlasts the window', () => {
  it('answers that it is running, keeps going, and "status" returns its result', async () => {
    const gate = deferred()
    brain.mockImplementation(async (_input, emit) => {
      emit(landed('Creating table products'))
      await gate.promise
      emit(landed('Creating table orders'))
      return turn({ applied: ['Creating table products', 'Creating table orders'] })
    })

    const first = await chat('build my store')
    expect(first.body).toMatchObject({
      ok: true,
      status: 'running',
      progress: { appliedCount: 1, applied: ['Creating table products'] },
      next: { tool: 'backend_chat', arguments: { message: 'status' } },
    })
    expect(first.body).not.toHaveProperty('code')

    const collecting = chat('status')
    gate.resolve()
    const second = await collecting

    expect(second.body).toMatchObject({
      ok: true,
      applied: ['Creating table products', 'Creating table orders'],
      run: { id: first.body.run.id, status: 'completed' },
    })
    expect(brain).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('a request sent while one runs joins it, is not run, and says so', async () => {
    const gate = deferred()
    brain.mockImplementation(async () => {
      await gate.promise
      return turn({ applied: ['Creating table products'] })
    })
    const first = await chat('build my store')

    const second = await chat('also add a reviews table')

    expect(second.body).toMatchObject({ status: 'running', run: { id: first.body.run.id }, notRun: { message: 'also add a reviews table' } })
    expect(second.body.summary).toContain('was not run')
    expect(brain).toHaveBeenCalledTimes(1)
    gate.resolve()
  }, 30_000)

  it('check_approval with its run id says where it has got to, then returns its result', async () => {
    const gate = deferred()
    brain.mockImplementation(async (_input, emit) => {
      emit(landed('Creating table products'))
      await gate.promise
      return turn({ applied: ['Creating table products'] })
    })
    const first = await chat('build my store')

    const running = await checkApproval(first.body.run.id)
    expect(running.body).toMatchObject({ ok: true, status: 'running', data: { kind: 'build_run', status: 'running' } })

    gate.resolve()
    await settled()
    const done = await checkApproval(first.body.run.id)
    expect(done.body).toMatchObject({
      ok: true,
      data: { kind: 'build_run', status: 'completed', result: { ok: true, applied: ['Creating table products'] } },
    })
  }, 30_000)

  it('is charged and finished even when nobody collects it, and the next request hears how it went', async () => {
    const gate = deferred()
    brain.mockImplementationOnce(async () => {
      await gate.promise
      return turn({
        success: false,
        summary: 'Built the tables; dropping the old ones waits for a person.',
        applied: ['Creating table products'],
        tokensUsed: 1234,
        blockedCalls: [{ tool: 'drop_table', args: { tableName: 'legacy' }, target: 'the `legacy` table', rowCount: 3, reversible: true }],
      })
    })
    const first = await chat('rebuild my store')
    expect(first.body.status).toBe('running')
    gate.resolve()
    await settled()
    // Charged when it ended, though no call was waiting for it.
    expect(charge).toHaveBeenCalledWith('account-1', expect.anything(), 1234)

    brain.mockImplementationOnce(async () => turn({ summary: 'Added the column.' }))
    const next = await chat('add a price column to products')

    expect(next.body.summary).toBe('Added the column.')
    expect(next.body.previousRun).toMatchObject({
      id: first.body.run.id,
      status: 'completed',
      approval: { id: 'apr-test-1', status: 'pending' },
    })
    // Heard once: the request after that carries no previousRun.
    brain.mockImplementationOnce(async () => turn())
    expect((await chat('add an index')).body).not.toHaveProperty('previousRun')
  }, 30_000)
})

describe('a run whose process stopped', () => {
  it('is closed as interrupted, with what landed and a resume point "continue" picks up', async () => {
    const id = crypto.randomUUID()
    const past = new Date(Date.now() - 5_000)
    await prisma.backgroundJob.create({
      data: {
        id, type: 'brain_run', status: 'brain_running', projectId,
        payload: { userId: ownerId, keyId, request: 'build my store', applied: ['Creating table products'], appliedCount: 1, delivered: false },
        attempts: 1, maxAttempts: 1, runAt: past, startedAt: past, timeoutAt: past,
      },
    })

    const { body } = await chat('status')

    expect(body).toMatchObject({
      ok: false,
      code: 'RUN_INTERRUPTED',
      applied: ['Creating table products'],
      next: { tool: 'backend_chat', arguments: { message: 'continue' } },
      run: { id, status: 'interrupted' },
    })
    expect(await loadLoopResume(projectId)).toMatchObject({
      request: 'build my store',
      applied: ['Creating table products'],
      reason: 'Backenly restarted while it was running',
    })
    expect(await prisma.backgroundJob.findUnique({ where: { id } })).toMatchObject({ status: 'failed', error: 'RUN_INTERRUPTED' })
  }, 30_000)
})

describe('the gates', () => {
  it('collecting a running request is answered when the credits for a new one are gone', async () => {
    const gate = deferred()
    brain.mockImplementation(async () => {
      await gate.promise
      return turn({ applied: ['Creating table products'] })
    })
    const first = await chat('build my store')
    credits.mockResolvedValue({ allowed: false, message: 'Out of AI credits.', currentPlan: 'SANDBOX', requiredPlan: 'BUILDER' } as any)

    const collecting = chat('status')
    gate.resolve()
    const second = await collecting

    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ ok: true, run: { id: first.body.run.id, status: 'completed' } })
  }, 30_000)

  it('"status" with nothing ever run says so, and runs no turn', async () => {
    const { body } = await chat('status')
    expect(body).toMatchObject({ ok: true, status: 'idle' })
    expect(brain).not.toHaveBeenCalled()
  }, 30_000)
})

describe('a project kept in another region', () => {
  it('keeps its request and answer in the region; its run row holds none of its words', async () => {
    const store = new Map<string, any>()
    const inRegion: RegionalBodies = {
      region: 'us-east-1' as any,
      set: async (kind, id, fields) => { store.set(`${kind}:${id}`, { ...(store.get(`${kind}:${id}`) ?? {}), ...fields }) },
      get: async (kind, id) => store.get(`${kind}:${id}`) ?? null,
      getMany: async () => new Map(),
      remove: async (kind, ids) => { for (const id of ids ?? []) store.delete(`${kind}:${id}`) },
      idsMatching: async () => [],
    }
    residentHere.mockResolvedValue(false)
    bodiesFor.mockResolvedValue(inRegion)
    const gate = deferred()
    brain.mockImplementation(async (_input, emit) => {
      emit(landed('Creating table patients'))
      await gate.promise
      return turn({ summary: 'Built the clinic for jane@example.com.', applied: ['Creating table patients'] })
    })

    const first = await chat('build a clinic backend for jane@example.com')
    const runId = first.body.run.id
    gate.resolve()
    await settled()

    const row = await prisma.backgroundJob.findUnique({ where: { id: runId } })
    const onRow = JSON.stringify({ payload: row!.payload, result: row!.result })
    expect(onRow).not.toContain('jane@example.com')
    expect(onRow).not.toContain('patients')
    expect(row!.payload).toMatchObject({ keptInRegion: true, appliedCount: 1 })
    expect(store.get(`brain_run:${runId}`).payload).toMatchObject({ request: 'build a clinic backend for jane@example.com' })

    const { body } = await chat('status')
    expect(body).toMatchObject({ ok: true, summary: 'Built the clinic for jane@example.com.', run: { id: runId } })
  }, 30_000)
})
